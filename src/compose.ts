import { z } from 'zod';
import MailComposer, { type MailComposerOptions } from 'nodemailer/lib/mail-composer';
import type { ParsedMail, AddressObject } from 'mailparser';
import type { MailConfig } from './config.js';
import { MailError } from './errors.js';
import { MAX_MESSAGE_BYTES } from './messages.js';

const header = z.string().max(2000).refine(value => !/[\r\n\0]/u.test(value), '邮件头不能包含换行符');
const address = z.email().max(320);
const addresses = z.array(address).max(100);
export const attachmentSchema = z.object({
  filename: header.min(1).max(255), content_type: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/u).default('application/octet-stream'),
  content_base64: z.string().max(14 * 1024 * 1024),
  content_id: header.optional(),
}).strict();
export const composeShape = {
  to: addresses, cc: addresses.optional(), bcc: addresses.optional(),
  subject: header, text: z.string().max(500000).optional(), html: z.string().max(500000).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  reply_message_id: z.string().max(4096).optional(),
};
export const composeSchema = z.object(composeShape).strict();
export type ComposeInput = z.infer<typeof composeSchema>;

export function decodeAttachment(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new MailError('INVALID_ATTACHMENT', '附件内容必须为有效的标准 base64 编码。');
  }
  const content = Buffer.from(value, 'base64');
  if (content.toString('base64') !== value) throw new MailError('INVALID_ATTACHMENT', '附件 base64 编码不完整或不是规范格式。');
  if (content.length > 10 * 1024 * 1024) throw new MailError('ATTACHMENT_TOO_LARGE', '发送的单个附件上限为 10 MiB。');
  return content;
}

export function mailOptions(config: MailConfig, input: ComposeInput): MailComposerOptions {
  return {
    from: { name: config.displayName || '', address: config.email },
    to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject,
    text: input.text, html: input.html,
    attachments: input.attachments?.map(item => ({
      filename: item.filename, content: decodeAttachment(item.content_base64),
      contentType: item.content_type, cid: item.content_id,
    })),
    disableFileAccess: true, disableUrlAccess: true,
  };
}

function addressValues(value?: AddressObject | AddressObject[]): string[] {
  return (Array.isArray(value) ? value : value ? [value] : []).flatMap(item => item.value.map(address => address.address).filter((value): value is string => Boolean(value)));
}

export function optionsFromParsed(config: MailConfig, parsed: ParsedMail): MailComposerOptions {
  return {
    from: { name: config.displayName || '', address: config.email },
    to: addressValues(parsed.to), cc: addressValues(parsed.cc), bcc: addressValues(parsed.bcc),
    subject: parsed.subject || '', text: parsed.text, html: parsed.html || undefined,
    inReplyTo: parsed.inReplyTo, references: parsed.references,
    replyTo: addressValues(parsed.replyTo),
    attachments: parsed.attachments.map(item => ({
      filename: item.filename || 'attachment', content: item.content, contentType: item.contentType,
      cid: item.cid, contentDisposition: item.contentDisposition,
    })),
    disableFileAccess: true, disableUrlAccess: true,
  };
}

export async function compileMail(options: MailComposerOptions, draft: boolean) {
  const compiled = new MailComposer({ ...options, disableFileAccess: true, disableUrlAccess: true }).compile();
  compiled.keepBcc = draft;
  const envelope = compiled.getEnvelope();
  const raw = await compiled.build();
  if (raw.length > MAX_MESSAGE_BYTES) throw new MailError('MESSAGE_TOO_LARGE', '邮件编码后超过 20 MiB，请缩小正文或附件。');
  return { raw, envelope, messageId: String(compiled.getHeader('message-id')) };
}

export function assertRecipients(options: MailComposerOptions) {
  if (![options.to, options.cc, options.bcc].some(value => Array.isArray(value) ? value.length > 0 : Boolean(value))) {
    throw new MailError('RECIPIENT_MISSING', '发送邮件至少需要一个收件人。');
  }
}
