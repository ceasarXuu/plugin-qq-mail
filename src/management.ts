import type { ImapFlow } from 'imapflow';
import type { MailConfig } from './config.js';
import { withMessage } from './connection.js';
import { MailError, publicError } from './errors.js';
import { getFolders, resolveFolder } from './folders.js';
import { messageId, parseMessageId } from './ids.js';

export function assertSafeMove(client: ImapFlow) {
  if (!client.capabilities.has('MOVE') && !client.capabilities.has('UIDPLUS')) {
    throw new MailError('SAFE_MOVE_UNAVAILABLE', '服务器不支持 MOVE 或 UIDPLUS，无法保证只移除选定邮件，已停止移动以保护其他邮件。');
  }
}

export async function createFolder(client: ImapFlow, config: MailConfig, folder: string) {
  if (!folder.trim() || /[\r\n\0]/u.test(folder) || folder.length > 1024) throw new MailError('INVALID_FOLDER', '文件夹名称无效。');
  const existing = (await getFolders(client, config)).find(item => item.path === folder);
  if (existing) return { path: existing.path, created: false };
  const result = await client.mailboxCreate(folder);
  if (!result) throw new MailError('FOLDER_CREATE_FAILED', '服务器未确认创建文件夹，请重新列出文件夹后核对。');
  return { path: result.path, created: true };
}

export async function moveEmails(client: ImapFlow, config: MailConfig, ids: string[], destination: string) {
  const refs = [...new Set(ids)].map(id => ({ id, ref: parseMessageId(id, config.accountId) }));
  const target = resolveFolder(destination, await getFolders(client, config), config);
  if (refs.some(item => item.ref.f !== target)) assertSafeMove(client);
  const results = [];
  for (const { id, ref } of refs) {
    try {
      results.push(await withMessage(client, ref, false, async () => {
        if (!await client.fetchOne(ref.u, { uid: true }, { uid: true })) throw new MailError('MESSAGE_NOT_FOUND', '邮件已不存在，请重新搜索。');
        if (ref.f === target) return { message_id: id, status: 'unchanged', new_message_id: id, destination: target };
        const result = await client.messageMove([ref.u], target, { uid: true });
        if (!result) throw new MailError('MOVE_UNKNOWN', '移动结果未确认，可能已产生目标副本。请先核对源文件夹和目标文件夹，不要自动重试。');
        const newUid = result.uidMap?.get(ref.u);
        return {
          message_id: id, status: 'moved', destination: target,
          new_message_id: newUid && result.uidValidity ? messageId(config.accountId, target, result.uidValidity, newUid) : null,
        };
      }));
    } catch (error) { results.push({ message_id: id, status: 'error', error: publicError(error) }); }
  }
  return { results, complete: results.every(result => result.status !== 'error') };
}

export async function trashEmails(client: ImapFlow, config: MailConfig, ids: string[]) {
  return moveEmails(client, config, ids, 'trash');
}

export async function archiveEmails(client: ImapFlow, config: MailConfig, ids: string[]) {
  let target: string;
  const folders = await getFolders(client, config);
  try { target = resolveFolder('archive', folders, config); }
  catch (error) {
    if (!(error instanceof MailError) || error.code !== 'FOLDER_UNAVAILABLE') throw error;
    // QQ has no Gmail-style All Mail: use a normal reversible archive folder.
    assertSafeMove(client);
    target = config.folders.archive || 'Archive';
    await createFolder(client, config, target);
  }
  return moveEmails(client, config, ids, target);
}

export async function modifyEmails(client: ImapFlow, config: MailConfig, ids: string[], read?: boolean, starred?: boolean) {
  if (read === undefined && starred === undefined) throw new MailError('FLAGS_MISSING', '至少指定 read 或 starred。');
  const refs = [...new Set(ids)].map(id => ({ id, ref: parseMessageId(id, config.accountId) }));
  const results = [];
  for (const { id, ref } of refs) {
    try {
      await withMessage(client, ref, false, async () => {
        if (!await client.fetchOne(ref.u, { uid: true }, { uid: true })) throw new MailError('MESSAGE_NOT_FOUND', '邮件已不存在，请重新搜索。');
        const add: string[] = [], remove: string[] = [];
        if (read !== undefined) (read ? add : remove).push('\\Seen');
        if (starred !== undefined) (starred ? add : remove).push('\\Flagged');
        if (add.length && !await client.messageFlagsAdd([ref.u], add, { uid: true })) throw new MailError('FLAGS_UNKNOWN', '未确认标志更新，请重新读取邮件状态。');
        if (remove.length && !await client.messageFlagsRemove([ref.u], remove, { uid: true })) throw new MailError('FLAGS_UNKNOWN', '未确认标志更新，请重新读取邮件状态。');
      });
      results.push({ message_id: id, status: 'updated', read, starred });
    } catch (error) { results.push({ message_id: id, status: 'error', error: publicError(error) }); }
  }
  return { results, complete: results.every(result => result.status !== 'error') };
}
