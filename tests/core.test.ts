import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { compileMail, mailOptions, decodeAttachment } from '../src/compose.js';
import { messageId, parseMessageId } from '../src/ids.js';
import { parseQuery } from '../src/query.js';
import { publicError } from '../src/errors.js';
import { guardedDelivery, replayDelivery, type DeliveryReceipt } from '../src/delivery.js';
import { parseSource } from '../src/messages.js';
import { config, tempDir } from './fixtures.js';

test('QQ preset loads credentials locally and rejects world-readable secret files', async t => {
  const directory = await tempDir(t);
  const filename = path.join(directory, 'config.json');
  await writeFile(filename, JSON.stringify({ email: 'owner@qq.com', auth: { passwordFile: './secret' } }));
  const secret = path.join(directory, 'secret');
  await writeFile(secret, 'abcdefghijklmnop', { mode: 0o600 });
  const loaded = await loadConfig({ MAIL_CONFIG_PATH: filename });
  assert.equal(loaded.imap.host, 'imap.qq.com');
  assert.equal(loaded.smtp.security, 'tls');
  assert.equal(loaded.auth.pass, 'abcdefghijklmnop');
  if (process.platform !== 'win32') {
    await chmod(secret, 0o644);
    await assert.rejects(loadConfig({ MAIL_CONFIG_PATH: filename }), { code: 'SECRET_PERMISSIONS' });
  }
  await writeFile(filename, 'null');
  await assert.rejects(loadConfig({ MAIL_CONFIG_PATH: filename }), { code: 'CONFIG_INVALID' });
  assert(!JSON.stringify(publicError(new Error('password=abcdefghijklmnop'))).includes('abcdefghijklmnop'));
});

test('mail IDs reject wrong accounts and arbitrary ranges', () => {
  const id = messageId('123456789012345678901234', 'INBOX', 1n, 42);
  assert.equal(parseMessageId(id, '123456789012345678901234').u, 42);
  assert.throws(() => parseMessageId(id, 'different-account'), { code: 'INVALID_MESSAGE_ID' });
  assert.throws(() => parseMessageId('1:*', '123456789012345678901234'), { code: 'INVALID_MESSAGE_ID' });
});

test('query parser preserves repeated AND terms and fails closed on unsupported syntax', () => {
  const plan = parseQuery('from:me subject:"Project report" -is:read has:attachment', 'owner@example.test');
  assert.equal(plan.attachment, true);
  assert(JSON.stringify(plan.search).includes('owner@example.test'));
  assert.throws(() => parseQuery('category:promotions', 'owner@example.test'), { code: 'UNSUPPORTED_QUERY' });
  assert.throws(() => parseQuery('from:a OR from:b', 'owner@example.test'), { code: 'UNSUPPORTED_QUERY' });
  assert.throws(() => parseQuery('before:2026-02-30', 'owner@example.test'), { code: 'INVALID_QUERY' });
});

test('draft MIME preserves Bcc and binary attachments; outgoing MIME hides Bcc while keeping envelope recipients', async () => {
  const options = mailOptions(config('/unused'), {
    to: ['recipient@example.test'], bcc: ['hidden@example.test'], subject: '中文主题', text: '正文',
    attachments: [{ filename: 'bytes.bin', content_type: 'application/octet-stream', content_base64: Buffer.from([0, 255, 1]).toString('base64') }],
  });
  const draft = await compileMail(options, true);
  const saved = await parseSource(draft.raw);
  assert(saved.bcc && !Array.isArray(saved.bcc) && saved.bcc.value[0]?.address === 'hidden@example.test');
  assert.deepEqual(saved.attachments[0]?.content, Buffer.from([0, 255, 1]));
  const sent = await compileMail(options, false);
  assert(!/^Bcc:/imu.test(sent.raw.toString()));
  assert(sent.envelope.to.includes('hidden@example.test'));
  assert.equal(saved.subject, '中文主题');
  assert.throws(() => decodeAttachment('%%%'), { code: 'INVALID_ATTACHMENT' });
});

test('delivery ledger prevents duplicate and concurrent sends and blocks unknown-result retries', async t => {
  const directory = await tempDir(t);
  let sends = 0;
  const receipt: DeliveryReceipt = { delivery_status: 'sent', accepted: ['recipient@example.test'], rejected: [], message_id_header: '<test@example.test>' };
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const first = guardedDelivery(directory, 'account', 'unique-key-001', 'fingerprint', async () => { sends++; entered(); await barrier; return receipt; }, 'draft:123');
  await started;
  await assert.rejects(guardedDelivery(directory, 'account', 'unique-key-001', 'fingerprint', async () => receipt), { code: 'DELIVERY_UNKNOWN' });
  release();
  await first;
  const repeated = await guardedDelivery(directory, 'account', 'unique-key-001', 'fingerprint', async () => { sends++; return receipt; });
  assert.equal(repeated.replayed, true);
  assert.equal(sends, 1);
  assert.equal((await replayDelivery(directory, 'account', 'unique-key-001', 'draft:123'))?.replayed, true);
  await assert.rejects(guardedDelivery(directory, 'account', 'unique-key-001', 'changed', async () => receipt), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(guardedDelivery(directory, 'account', 'unknown-key-001', 'fingerprint', async () => { throw new Error('socket died with sensitive data'); }), { code: 'DELIVERY_UNKNOWN' });
  await assert.rejects(guardedDelivery(directory, 'account', 'unknown-key-001', 'fingerprint', async () => { sends++; return receipt; }), { code: 'DELIVERY_UNKNOWN' });
  const records = (await import('node:fs/promises')).readdir;
  for (const entry of await records(path.join(directory, 'deliveries'))) {
    assert(!(await readFile(path.join(directory, 'deliveries', entry), 'utf8')).includes('sensitive data'));
  }
  assert.equal(sends, 1);
});
