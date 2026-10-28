import { ImapFlow } from 'imapflow';
import type { MailConfig } from './config.js';
import { MailError } from './errors.js';
import type { MessageRef } from './ids.js';

export async function withImap<T>(config: MailConfig, operation: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: config.imap.host, port: config.imap.port,
    secure: config.imap.security === 'tls',
    ...(config.imap.security === 'starttls' ? { doSTARTTLS: true } : {}),
    auth: config.auth, logger: false, logRaw: false, disableAutoIdle: true,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    maxLiteralSize: 25 * 1024 * 1024, maxResponseSize: 30 * 1024 * 1024,
    clientInfo: { name: 'qq-mail-mcp', version: '0.1.0' },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
  });
  client.on('error', () => { /* Errors are returned by the active command; never log credentials or message data. */ });
  try {
    await client.connect();
    return await operation(client);
  } finally {
    try { if (client.usable) await client.logout(); } catch { /* Cleanup must not hide a completed operation. */ }
    client.close();
  }
}

export async function withMailbox<T>(
  client: ImapFlow, folder: string, readOnly: boolean,
  operation: () => Promise<T>, validity?: string,
): Promise<T> {
  const lock = await client.getMailboxLock(folder, { readOnly, acquireTimeout: 15000 });
  try {
    if (!client.mailbox || (validity && String(client.mailbox.uidValidity) !== validity)) {
      throw new MailError('STALE_MESSAGE_ID', '邮箱文件夹的 UIDVALIDITY 已变化。请重新搜索邮件，避免操作错误邮件。');
    }
    return await operation();
  } finally {
    lock.release();
  }
}

export function withMessage<T>(client: ImapFlow, ref: MessageRef, readOnly: boolean, operation: () => Promise<T>): Promise<T> {
  return withMailbox(client, ref.f, readOnly, operation, ref.uv);
}
