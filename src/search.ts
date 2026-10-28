import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ImapFlow, ListResponse } from 'imapflow';
import type { MailConfig } from './config.js';
import { withMailbox } from './connection.js';
import { MailError } from './errors.js';
import { getFolders, resolveFolder } from './folders.js';
import { andQueries, parseQuery, type QueryPlan } from './query.js';
import { hasAttachment, summarizeMessage } from './messages.js';

const cursorSchema = z.object({
  v: z.literal(1), hash: z.string().length(64), folder: z.number().int().min(0).max(10000),
  before: z.number().int().min(1).max(4294967295).optional(),
  validity: z.string().regex(/^[1-9][0-9]*$/u).optional(),
  now: z.string().datetime(),
}).strict();
type Cursor = z.infer<typeof cursorSchema>;
export interface SearchInput { query?: string; folder?: string; max_results?: number; next_page_token?: string }

function decodeCursor(token?: string): Cursor | undefined {
  if (!token) return;
  try {
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(token)) throw new Error('invalid');
    return cursorSchema.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
  } catch { throw new MailError('INVALID_PAGE_TOKEN', '分页标记无效。请重新执行搜索。'); }
}

function selectFolders(plan: QueryPlan, available: ListResponse[], config: MailConfig, explicit?: string): string[] {
  const paths = explicit ? [resolveFolder(explicit, available, config)] : plan.folders.length
    ? [...new Set(plan.folders.map(folder => resolveFolder(folder, available, config)))]
    : available.filter(folder => folder.specialUse !== '\\All').map(folder => folder.path);
  // Gmail label: is a folder selector here; multiple positive selectors must not widen an AND query.
  if (plan.folders.length > 1 || (explicit && plan.folders.length && paths[0] !== resolveFolder(plan.folders[0]!, available, config))) {
    throw new MailError('INVALID_QUERY', 'IMAP 文件夹不可同时叠加。请一次指定一个 folder、in: 或 label:。');
  }
  const excluded = new Set(plan.excludeFolders.flatMap(folder => {
    try { return [resolveFolder(folder, available, config)]; }
    catch (error) {
      if (error instanceof MailError && error.code === 'FOLDER_UNAVAILABLE') return [];
      throw error;
    }
  }));
  if (!explicit && !plan.folders.length && !plan.anywhere) {
    for (const folder of available) if (['\\Trash', '\\Junk'].includes(folder.specialUse || '')) excluded.add(folder.path);
  }
  return paths.filter(folder => !excluded.has(folder)).sort((a, b) => a === 'INBOX' ? -1 : b === 'INBOX' ? 1 : a.localeCompare(b));
}

export async function searchEmails(client: ImapFlow, config: MailConfig, input: SearchInput, idsOnly = false) {
  const previous = decodeCursor(input.next_page_token);
  const now = previous?.now || new Date().toISOString();
  const plan = parseQuery(input.query || '', config.email, new Date(now));
  const available = await getFolders(client, config);
  const folders = selectFolders(plan, available, config, input.folder);
  const hash = createHash('sha256').update(JSON.stringify([config.accountId, input.query || '', input.folder, folders, now])).digest('hex');
  if (previous && previous.hash !== hash) throw new MailError('INVALID_PAGE_TOKEN', '搜索条件或文件夹列表发生变化。请重新搜索。');
  const limit = input.max_results ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new MailError('INVALID_LIMIT', 'max_results 须在 1 到 100 之间。');
  const messages: ReturnType<typeof summarizeMessage>[] = [];
  const cursor: Cursor = previous || { v: 1, hash, folder: 0, now };
  let scanned = 0;
  while (cursor.folder < folders.length && messages.length < limit && scanned < 1000) {
    const folder = folders[cursor.folder]!;
    let finished = false;
    await withMailbox(client, folder, true, async () => {
      if (!client.mailbox) throw new MailError('MAILBOX_UNAVAILABLE', '未打开邮箱文件夹。');
      const validity = String(client.mailbox.uidValidity);
      if (cursor.validity && cursor.validity !== validity) throw new MailError('STALE_PAGE_TOKEN', '文件夹版本已变化，请重新搜索。');
      cursor.validity = validity;
      if (cursor.before === 1 || client.mailbox.exists === 0) { finished = true; return; }
      const criteria = andQueries([plan.search, { deleted: false }, ...(cursor.before ? [{ uid: `1:${cursor.before - 1}` }] : [])]);
      const result = await client.search(criteria, { uid: true });
      if (!Array.isArray(result)) throw new MailError('SEARCH_FAILED', '服务器未能完成搜索。请缩小条件后重试。');
      const uids = result.sort((a, b) => b - a);
      let offset = 0;
      while (offset < uids.length && messages.length < limit && scanned < 1000) {
        const batch = uids.slice(offset, offset + Math.min(50, 1000 - scanned));
        const fetched = await client.fetchAll(batch, { envelope: true, flags: true, size: true, bodyStructure: true, internalDate: true }, { uid: true });
        const byUid = new Map(fetched.map(message => [message.uid, message]));
        for (const uid of batch) {
          cursor.before = uid;
          offset++;
          scanned++;
          const message = byUid.get(uid);
          if (message && (plan.attachment === undefined || plan.attachment === hasAttachment(message.bodyStructure))) {
            messages.push(summarizeMessage(config, folder, validity, message));
          }
          if (messages.length >= limit || scanned >= 1000) break;
        }
      }
      finished = offset >= uids.length;
    });
    if (finished) { cursor.folder++; delete cursor.before; delete cursor.validity; }
  }
  return {
    ...(idsOnly ? { message_ids: messages.map(message => message.id) } : { emails: messages }),
    next_page_token: cursor.folder < folders.length ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null,
    scanned_count: scanned, search_complete: cursor.folder >= folders.length,
    ordering: 'folders_inbox_first_then_path; uid_descending_within_folder',
    query_language: 'documented_gmail_subset', untrusted_content: true,
  };
}
