import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type SMTPTransportOptions } from 'nodemailer';
import type { MailComposerOptions } from 'nodemailer/lib/mail-composer';
import type { MailConfig } from './config.js';
import { assertRecipients, compileMail } from './compose.js';
import { MailError, publicError } from './errors.js';

export interface DeliveryReceipt {
  delivery_status: 'sent' | 'partially_sent';
  message_id_header: string;
  accepted: string[];
  rejected: string[];
  replayed?: boolean;
  warnings?: string[];
}
interface DeliveryRecord {
  fingerprint: string;
  status: 'sending' | 'unknown' | 'sent';
  created_at: string;
  receipt?: DeliveryReceipt;
  context?: string;
}

function recordPath(stateDir: string, accountId: string, key: string) {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(key)) throw new MailError('INVALID_REQUEST_ID', 'idempotency_key 须为 8–128 位字母、数字、下划线或连字符，每次有意发送使用唯一值。');
  return path.join(stateDir, 'deliveries', `${createHash('sha256').update(`${accountId}:${key}`).digest('hex')}.json`);
}

export async function replayDelivery(stateDir: string, accountId: string, key: string, context: string): Promise<DeliveryReceipt | undefined> {
  const filename = recordPath(stateDir, accountId, key);
  let record: DeliveryRecord;
  try { record = JSON.parse(await readFile(filename, 'utf8')) as DeliveryRecord; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new MailError('DELIVERY_UNKNOWN', '发送记录不完整，请先核对已发送邮件，禁止自动重发。');
  }
  if (record.context !== context) throw new MailError('REQUEST_CONFLICT', '相同请求键已用于其他邮件操作，请核对请求。');
  if (record.status === 'sent' && record.receipt) return { ...record.receipt, replayed: true };
  throw new MailError('DELIVERY_UNKNOWN', '该请求仍在发送或结果不确定，请先核对邮箱，禁止自动重发。');
}

export function smtpOptions(config: MailConfig): SMTPTransportOptions {
  return {
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.security === 'tls',
    requireTLS: config.smtp.security === 'starttls',
    auth: config.auth, logger: false, debug: false, pool: false,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    disableFileAccess: true, disableUrlAccess: true,
  };
}

export async function guardedDelivery(
  stateDir: string, accountId: string, key: string, fingerprint: string,
  send: () => Promise<DeliveryReceipt>,
  context = '',
): Promise<DeliveryReceipt> {
  const directory = path.join(stateDir, 'deliveries');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = recordPath(stateDir, accountId, key);
  const record: DeliveryRecord = { fingerprint, status: 'sending', created_at: new Date().toISOString(), context };
  let handle;
  try {
    handle = await open(filename, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new MailError('STATE_UNAVAILABLE', '无法创建本机发送记录，已停止发送。请检查 stateDir 的写入权限。');
    let existing: DeliveryRecord;
    try { existing = JSON.parse(await readFile(filename, 'utf8')) as DeliveryRecord; }
    catch { throw new MailError('DELIVERY_UNKNOWN', '该发送请求可能已经执行，记录不完整。请检查已发送邮件后再决定是否以新请求发送。'); }
    if (existing.fingerprint !== fingerprint) throw new MailError('REQUEST_CONFLICT', '相同 idempotency_key 已用于不同邮件。请核对发送请求。');
    if (existing.status === 'sent' && existing.receipt) return { ...existing.receipt, replayed: true };
    throw new MailError('DELIVERY_UNKNOWN', '该请求仍在发送、曾中断或结果不确定，已阻止重复发送。请先检查已发送邮件。');
  }
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally { await handle.close(); }
  const persist = async () => {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const update = await open(temporary, 'wx', 0o600);
    try { await update.writeFile(JSON.stringify(record)); await update.sync(); }
    finally { await update.close(); }
    await rename(temporary, filename);
  };
  let receipt: DeliveryReceipt;
  try { receipt = await send(); }
  catch (error) {
    record.status = 'unknown';
    await persist().catch(() => {});
    const safe = publicError(error);
    throw new MailError('DELIVERY_UNKNOWN', `${safe.message} 发送结果无法确认；同一请求不会自动重发，请先检查邮箱。`);
  }
  record.status = 'sent'; record.receipt = receipt;
  try { await persist(); }
  catch { receipt.warnings = [...(receipt.warnings || []), 'SMTP 已接受邮件，但本机记录更新失败；请勿以新请求重复发送。']; }
  return receipt;
}

export async function deliver(config: MailConfig, options: MailComposerOptions, key: string, context = ''): Promise<DeliveryReceipt> {
  assertRecipients(options);
  const fingerprint = createHash('sha256').update(JSON.stringify([options, context])).digest('hex');
  const compiled = await compileMail(options, false);
  return guardedDelivery(config.stateDir, config.accountId, key, fingerprint, async () => {
    const transport = nodemailer.createTransport(smtpOptions(config));
    try {
      const result = await transport.sendMail({
        envelope: compiled.envelope, raw: compiled.raw, disableFileAccess: true, disableUrlAccess: true,
      });
      const accepted = result.accepted || [];
      const rejected = result.rejected || [];
      if (!accepted.length) throw new MailError('SEND_REJECTED', 'SMTP 服务器未接受任何收件人。');
      return {
        delivery_status: rejected.length ? 'partially_sent' : 'sent',
        message_id_header: compiled.messageId, accepted, rejected,
        warnings: rejected.length ? ['部分收件人被服务器拒绝。不要重发整封邮件，以免其他收件人重复收到。'] : [],
      };
    } finally { transport.close(); }
  }, context);
}
