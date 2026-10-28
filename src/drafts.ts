import type { ImapFlow } from 'imapflow';
import type { MailComposerOptions } from 'nodemailer/lib/mail-composer';
import type { MailConfig } from './config.js';
import { compileMail, mailOptions, optionsFromParsed, type ComposeInput } from './compose.js';
import { withMailbox } from './connection.js';
import { deliver, replayDelivery } from './delivery.js';
import { MailError } from './errors.js';
import { getFolders, resolveFolder } from './folders.js';
import { messageId, parseMessageId } from './ids.js';
import { fetchRaw, parseSource, readEmail } from './messages.js';
import { withReplyContext } from './outgoing.js';
import { assertSafeMove, trashEmails } from './management.js';

export async function draftFolder(client: ImapFlow, config: MailConfig): Promise<string> {
  return resolveFolder('drafts', await getFolders(client, config), config);
}

export async function requireDraft(client: ImapFlow, config: MailConfig, id: string) {
  const ref = parseMessageId(id, config.accountId);
  if (ref.f !== await draftFolder(client, config)) throw new MailError('INVALID_DRAFT_ID', 'draft_id 必须指向当前邮箱的草稿文件夹，请使用 list_drafts 返回的 ID。');
  return fetchRaw(client, id, config);
}

export async function appendDraft(client: ImapFlow, config: MailConfig, options: MailComposerOptions) {
  const folder = await draftFolder(client, config);
  const compiled = await compileMail(options, true);
  return withMailbox(client, folder, false, async () => {
    const result = await client.append(folder, compiled.raw, ['\\Draft', '\\Seen']);
    if (!result) throw new MailError('DRAFT_SAVE_UNKNOWN', '未收到草稿保存确认。请检查草稿箱后再决定是否重试。');
    let uid = result.uid;
    if (!uid) {
      const found = await client.search({ header: { 'Message-ID': compiled.messageId } }, { uid: true });
      if (Array.isArray(found) && found.length === 1) uid = found[0];
    }
    return {
      saved: true, draft_id: uid && client.mailbox ? messageId(config.accountId, folder, client.mailbox.uidValidity, uid) : null,
      message_id_header: compiled.messageId,
      warning: uid ? null : '草稿已保存，服务器未提供可用 UID。请调用 list_drafts 获取 ID，避免重复创建。',
    };
  });
}

export async function createDraft(client: ImapFlow, config: MailConfig, input: ComposeInput) {
  return appendDraft(client, config, await withReplyContext(client, config, input));
}

export async function sendDraft(client: ImapFlow, config: MailConfig, id: string, key: string) {
  const context = `draft:${id}`;
  const replayed = await replayDelivery(config.stateDir, config.accountId, key, context);
  if (replayed) return { ...replayed, draft_id: id, draft_cleanup_complete: null };
  const { source } = await requireDraft(client, config, id);
  const options = optionsFromParsed(config, await parseSource(source));
  const receipt = await deliver(config, options, key, context);
  if (receipt.delivery_status !== 'sent') return { ...receipt, draft_id: id, draft_cleanup_complete: false };
  try {
    const cleanup = await trashEmails(client, config, [id]);
    return { ...receipt, draft_id: id, draft_cleanup_complete: cleanup.complete,
      warnings: [...(receipt.warnings || []), ...(cleanup.complete ? [] : ['邮件已发送，原草稿移入垃圾箱未完成，请勿重复发送。'])] };
  } catch {
    return { ...receipt, draft_id: id, draft_cleanup_complete: false,
      warnings: [...(receipt.warnings || []), '邮件已发送，原草稿尚未移入垃圾箱，请勿重复发送。'] };
  }
}

export async function updateDraft(client: ImapFlow, config: MailConfig, id: string, patch: Partial<ComposeInput>) {
  const { source } = await requireDraft(client, config, id);
  const options = optionsFromParsed(config, await parseSource(source));
  if (!Object.values(patch).some(value => value !== undefined)) return { saved: true, draft_id: id, changed: false };
  // Verify reversible cleanup before APPEND. No permanent deletion is used for a replacement.
  resolveFolder('trash', await getFolders(client, config), config);
  assertSafeMove(client);
  for (const field of ['to', 'cc', 'bcc', 'subject'] as const) {
    if (patch[field] !== undefined) Object.assign(options, { [field]: patch[field] });
  }
  if (patch.text !== undefined || patch.html !== undefined) {
    options.text = patch.text; options.html = patch.html;
  }
  if (patch.attachments !== undefined) options.attachments = mailOptions(config, { to: [], subject: '', attachments: patch.attachments }).attachments;
  if (patch.reply_message_id !== undefined) {
    const context = await withReplyContext(client, config, { to: [], subject: '', reply_message_id: patch.reply_message_id });
    options.inReplyTo = context.inReplyTo; options.references = context.references;
  }
  const replacement = await appendDraft(client, config, options);
  if (!replacement.draft_id) return { ...replacement, previous_draft_id: id, previous_draft_retained: true };
  let cleaned = false;
  try { cleaned = (await trashEmails(client, config, [id])).complete; } catch { /* New draft is saved: never report a full failure and invite duplicate APPEND. */ }
  return { ...replacement, previous_draft_id: id, previous_draft_retained: !cleaned,
    warning: cleaned ? null : '新草稿已保存，旧草稿仍需核对；请使用新 draft_id，勿重复创建。' };
}

export async function readDraft(client: ImapFlow, config: MailConfig, id: string) {
  await requireDraft(client, config, id);
  return { ...await readEmail(client, config, id), draft_id: id };
}
