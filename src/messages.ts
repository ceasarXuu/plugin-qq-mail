import { simpleParser, type ParsedMail } from 'mailparser';
import type { FetchMessageObject, ImapFlow, MessageStructureObject } from 'imapflow';
import type { MailConfig } from './config.js';
import { MailError } from './errors.js';
import { messageId, parseMessageId } from './ids.js';
import { withMessage } from './connection.js';

export const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
const MAX_BODY_CHARS = 120000;

export function hasAttachment(structure?: MessageStructureObject): boolean {
  if (!structure) return false;
  return structure.disposition === 'attachment' || Boolean(structure.dispositionParameters?.filename || structure.parameters?.name)
    || (structure.childNodes || []).some(hasAttachment);
}

export function summarizeMessage(config: MailConfig, folder: string, validity: bigint | string, message: FetchMessageObject) {
  const envelope = message.envelope || {};
  return {
    id: messageId(config.accountId, folder, validity, message.uid), folder,
    subject: envelope.subject || '', from: envelope.from || [], to: envelope.to || [],
    cc: envelope.cc || [], bcc: envelope.bcc || [], date: envelope.date || message.internalDate || null,
    message_id_header: envelope.messageId || null, in_reply_to: envelope.inReplyTo || null,
    unread: !message.flags?.has('\\Seen'), starred: Boolean(message.flags?.has('\\Flagged')),
    size: message.size ?? null, has_attachment: hasAttachment(message.bodyStructure),
  };
}

export async function parseSource(source: Buffer): Promise<ParsedMail> {
  return simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 2 * 1024 * 1024 });
}

export async function fetchRaw(client: ImapFlow, id: string, config: MailConfig) {
  const ref = parseMessageId(id, config.accountId);
  return withMessage(client, ref, true, async () => {
    const metadata = await client.fetchOne(ref.u, { size: true, flags: true, envelope: true, bodyStructure: true }, { uid: true });
    if (!metadata) throw new MailError('MESSAGE_NOT_FOUND', '邮件不存在，可能已被移动或删除。请重新搜索。');
    if (metadata.size === undefined || metadata.size > MAX_MESSAGE_BYTES) throw new MailError('MESSAGE_TOO_LARGE', '邮件原文超过 20 MiB 读取限制，或服务器未报告大小。请使用邮箱客户端查看。');
    const raw = await client.fetchOne(ref.u, { source: { maxLength: MAX_MESSAGE_BYTES + 1 } }, { uid: true });
    if (!raw || !raw.source) throw new MailError('MESSAGE_NOT_FOUND', '未能读取邮件原文。');
    if (raw.source.length > MAX_MESSAGE_BYTES || raw.source.length < metadata.size) throw new MailError('MESSAGE_TOO_LARGE', '邮件原文不完整，已停止读取。');
    return { ref, source: raw.source, metadata };
  });
}

export async function readEmail(client: ImapFlow, config: MailConfig, id: string, format: 'full' | 'metadata' | 'raw' = 'full') {
  if (format === 'metadata') {
    const ref = parseMessageId(id, config.accountId);
    return withMessage(client, ref, true, async () => {
      const message = await client.fetchOne(ref.u, { envelope: true, flags: true, size: true, bodyStructure: true }, { uid: true });
      if (!message) throw new MailError('MESSAGE_NOT_FOUND', '邮件不存在，请重新搜索。');
      return summarizeMessage(config, ref.f, ref.uv, message);
    });
  }
  const { ref, source, metadata } = await fetchRaw(client, id, config);
  const summary = summarizeMessage(config, ref.f, ref.uv, metadata);
  if (format === 'raw') {
    if (source.length > 2 * 1024 * 1024) throw new MailError('RESPONSE_TOO_LARGE', '原文返回最多支持 2 MiB。请使用 full 格式分开读取正文及附件。');
    return { ...summary, raw_base64: source.toString('base64'), untrusted_content: true };
  }
  const parsed = await parseSource(source);
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  return {
    ...summary, text: (parsed.text || '').slice(0, MAX_BODY_CHARS), html: html.slice(0, MAX_BODY_CHARS),
    body_truncated: (parsed.text?.length || 0) > MAX_BODY_CHARS || html.length > MAX_BODY_CHARS,
    reply_to: parsed.replyTo?.value || [], references: parsed.references || [],
    attachments: parsed.attachments.map((attachment, index) => ({
      attachment_id: `att_${index}`, filename: attachment.filename || `attachment-${index + 1}`,
      content_type: attachment.contentType, size: attachment.size,
      content_id: attachment.contentId || null, disposition: attachment.contentDisposition,
      read_attachment_supported: attachment.size <= 5 * 1024 * 1024,
    })),
    untrusted_content: true,
  };
}

export async function readAttachment(client: ImapFlow, config: MailConfig, id: string, attachmentId?: string, filename?: string) {
  const { source } = await fetchRaw(client, id, config);
  const parsed = await parseSource(source);
  let attachment;
  if (attachmentId) {
    const match = /^att_(\d+)$/u.exec(attachmentId);
    if (!match) throw new MailError('ATTACHMENT_NOT_FOUND', '附件 ID 无效，请从 read_email 的附件列表复制。');
    attachment = parsed.attachments[Number(match[1])];
  } else {
    const matches = parsed.attachments.filter(item => item.filename === filename);
    if (matches.length > 1) throw new MailError('AMBIGUOUS_ATTACHMENT', '存在同名附件，请使用附件列表中的 attachment_id。');
    attachment = matches[0];
  }
  if (!attachment) throw new MailError('ATTACHMENT_NOT_FOUND', '未找到指定附件。');
  if (attachment.size > 5 * 1024 * 1024) throw new MailError('ATTACHMENT_TOO_LARGE', '单个附件返回上限为 5 MiB。请在邮箱客户端下载。');
  return {
    filename: attachment.filename || 'attachment', content_type: attachment.contentType,
    size: attachment.size, content_base64: attachment.content.toString('base64'), untrusted_content: true,
  };
}
