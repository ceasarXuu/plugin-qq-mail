import type { ImapFlow } from 'imapflow';
import type { MailComposerOptions } from 'nodemailer/lib/mail-composer';
import type { MailConfig } from './config.js';
import { mailOptions, type ComposeInput } from './compose.js';
import { deliver } from './delivery.js';
import { fetchRaw, parseSource } from './messages.js';
import { MailError } from './errors.js';

export async function withReplyContext(client: ImapFlow, config: MailConfig, input: ComposeInput): Promise<MailComposerOptions> {
  const options = mailOptions(config, input);
  if (!input.reply_message_id) return options;
  const { source } = await fetchRaw(client, input.reply_message_id, config);
  const parsed = await parseSource(source);
  if (!parsed.messageId) throw new MailError('REPLY_CONTEXT_MISSING', '原邮件没有 Message-ID，无法建立标准回复关联。');
  options.inReplyTo = parsed.messageId;
  options.references = [...(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []), parsed.messageId];
  return options;
}

export async function sendEmail(client: ImapFlow, config: MailConfig, input: ComposeInput, key: string) {
  return deliver(config, await withReplyContext(client, config, input), key, input.reply_message_id || '');
}

export async function replyEmail(
  client: ImapFlow, config: MailConfig, id: string,
  input: { text?: string; html?: string; reply_all?: boolean; attachments?: ComposeInput['attachments'] }, key: string,
) {
  const { source } = await fetchRaw(client, id, config);
  const parsed = await parseSource(source);
  const recipients = (parsed.replyTo?.value || parsed.from?.value || []).map(item => item.address).filter((value): value is string => Boolean(value));
  if (!recipients.length) throw new MailError('REPLY_ADDRESS_MISSING', '原邮件没有可用的回复地址，请明确指定收件人。');
  const cc = input.reply_all ? [...(Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : []), ...(Array.isArray(parsed.cc) ? parsed.cc : parsed.cc ? [parsed.cc] : [])]
    .flatMap(item => item.value.map(address => address.address).filter((value): value is string => Boolean(value)))
    .filter(address => address.toLowerCase() !== config.email.toLowerCase() && !recipients.some(to => to.toLowerCase() === address.toLowerCase())) : [];
  return sendEmail(client, config, {
    to: recipients, cc: [...new Set(cc)], subject: /^re:/iu.test(parsed.subject || '') ? parsed.subject! : `Re: ${parsed.subject || ''}`,
    text: input.text, html: input.html, attachments: input.attachments, reply_message_id: id,
  }, key);
}

export async function forwardEmail(client: ImapFlow, config: MailConfig, id: string, input: ComposeInput, key: string) {
  const { source } = await fetchRaw(client, id, config);
  const options = mailOptions(config, input);
  options.attachments = [...(options.attachments || []), { filename: 'forwarded-message.eml', contentType: 'message/rfc822', content: source }];
  return deliver(config, options, key, id);
}
