import assert from 'node:assert/strict';
import test from 'node:test';
import nodemailer from 'nodemailer';
import { messageId } from '../src/ids.js';
import { searchEmails } from '../src/search.js';
import { readEmail, readAttachment, fetchRaw } from '../src/messages.js';
import { archiveEmails, modifyEmails, trashEmails } from '../src/management.js';
import { createDraft, readDraft, sendDraft, updateDraft } from '../src/drafts.js';
import { config, FakeImap, sample, tempDir } from './fixtures.js';

test('search pages without duplicates and read/attachment calls never mark a message as read', async t => {
  const configuration = config(await tempDir(t));
  const fake = new FakeImap();
  await fake.add('INBOX', sample);
  await fake.add('INBOX', Buffer.from('From: bob@example.test\r\nTo: owner@example.test\r\nSubject: Another report\r\n\r\nbody'));
  const first = await searchEmails(fake.asClient(), configuration, { folder: 'INBOX', max_results: 1 });
  assert('emails' in first);
  assert.equal(first.emails.length, 1);
  assert(first.next_page_token);
  const next = await searchEmails(fake.asClient(), configuration, { folder: 'INBOX', max_results: 1, next_page_token: first.next_page_token });
  assert('emails' in next);
  assert.notEqual(first.emails[0]!.id, next.emails[0]!.id);
  assert.equal(next.next_page_token, null);
  const attachmentMessage = next.emails[0]!.id;
  const read = await readEmail(fake.asClient(), configuration, attachmentMessage);
  assert('attachments' in read);
  assert.equal(read.attachments.length, 1);
  assert.equal(read.unread, true);
  const attachment = await readAttachment(fake.asClient(), configuration, attachmentMessage, read.attachments[0]!.attachment_id);
  assert.equal(Buffer.from(attachment.content_base64, 'base64').toString(), 'attachment content');
  assert(!fake.calls.some(call => call.method === 'flags'));
  assert(fake.calls.filter(call => call.method === 'lock').every(call => call.readOnly));
  await assert.rejects(searchEmails(fake.asClient(), configuration, { folder: 'INBOX', query: 'from:other', next_page_token: first.next_page_token }), { code: 'INVALID_PAGE_TOKEN' });
  fake.calls = [];
  const empty = await searchEmails(fake.asClient(), configuration, { folder: 'INBOX', query: 'subject:nonexistent' });
  assert('emails' in empty && empty.emails.length === 0);
  assert(!fake.calls.some(call => call.method === 'fetch_all'));
});

test('trash is reversible, repeated trash never expunges, and stale IDs or unsafe servers cannot mutate mail', async t => {
  const configuration = config(await tempDir(t));
  const fake = new FakeImap();
  const uid = await fake.add('INBOX', sample);
  const id = messageId(configuration.accountId, 'INBOX', 100n, uid);
  await modifyEmails(fake.asClient(), configuration, [id], true, true);
  assert(fake.folders.get('INBOX')!.messages.get(uid)!.flags?.has('\\Seen'));
  assert(fake.folders.get('INBOX')!.messages.get(uid)!.flags?.has('\\Flagged'));
  const removed = await trashEmails(fake.asClient(), configuration, [id]);
  assert(removed.complete);
  const moved = removed.results[0]!;
  assert('new_message_id' in moved);
  const trashId = moved.new_message_id;
  assert(trashId);
  const again = await trashEmails(fake.asClient(), configuration, [trashId]);
  assert.equal(again.results[0]!.status, 'unchanged');
  assert.equal(fake.folders.get('Trash')!.messages.size, 1);
  assert(!fake.calls.some(call => call.flags?.includes('\\Deleted')));
  fake.folders.get('Trash')!.validity = 9999n;
  const stale = await modifyEmails(fake.asClient(), configuration, [trashId], false);
  assert.equal(stale.complete, false);
  assert.equal(stale.results[0]!.error?.code, 'STALE_MESSAGE_ID');
  fake.capabilities.clear();
  const freshId = messageId(configuration.accountId, 'Trash', 9999n, 1);
  await assert.rejects(archiveEmails(fake.asClient(), configuration, [freshId]), { code: 'SAFE_MOVE_UNAVAILABLE' });
  assert.equal(fake.folders.get('Archive'), undefined);
});

test('archive creates a normal folder and oversized source never downloads', async t => {
  const configuration = config(await tempDir(t));
  const fake = new FakeImap();
  const uid = await fake.add('INBOX', sample);
  const id = messageId(configuration.accountId, 'INBOX', 100n, uid);
  fake.folders.get('INBOX')!.messages.get(uid)!.size = 21 * 1024 * 1024;
  await assert.rejects(fetchRaw(fake.asClient(), id, configuration), { code: 'MESSAGE_TOO_LARGE' });
  assert(!fake.calls.some(call => call.method === 'fetch_source'));
  const archived = await archiveEmails(fake.asClient(), configuration, [id]);
  assert(archived.complete);
  assert.equal(fake.folders.get('Archive')!.messages.size, 1);
});

test('draft edits preserve attachments and Bcc; send cleans up reversibly and the same request can replay after cleanup', async t => {
  const configuration = config(await tempDir(t));
  const fake = new FakeImap();
  const outgoing: { raw: Buffer; envelope: { to: string[] } }[] = [];
  t.mock.method(nodemailer, 'createTransport', (() => ({
    async sendMail(message: { raw: Buffer; envelope: { to: string[] } }) {
      outgoing.push(message);
      return { accepted: message.envelope.to, rejected: [] };
    }, close() {},
  })) as unknown as typeof nodemailer.createTransport);
  const created = await createDraft(fake.asClient(), configuration, {
    to: ['recipient@example.test'], bcc: ['hidden@example.test'], subject: 'Original', text: 'Keep the body',
    attachments: [{ filename: 'note.txt', content_type: 'text/plain', content_base64: Buffer.from('keep this attachment').toString('base64') }],
  });
  assert(created.draft_id);
  const changed = await updateDraft(fake.asClient(), configuration, created.draft_id, { subject: 'Edited' });
  assert(changed.draft_id);
  assert.notEqual(changed.draft_id, created.draft_id);
  const read = await readDraft(fake.asClient(), configuration, changed.draft_id);
  assert.equal(read.subject, 'Edited');
  assert.equal(read.bcc[0]?.address, 'hidden@example.test');
  assert('attachments' in read && read.attachments.length === 1);
  assert.equal(fake.folders.get('Trash')!.messages.size, 1);
  const sent = await sendDraft(fake.asClient(), configuration, changed.draft_id, 'draft-send-key-001');
  assert.equal(sent.delivery_status, 'sent');
  assert.equal(sent.draft_cleanup_complete, true);
  assert.equal(fake.folders.get('Drafts')!.messages.size, 0);
  assert.equal(fake.folders.get('Trash')!.messages.size, 2);
  assert(outgoing[0]!.envelope.to.includes('hidden@example.test'));
  assert(!/^Bcc:/imu.test(outgoing[0]!.raw.toString()));
  const repeated = await sendDraft(fake.asClient(), configuration, changed.draft_id, 'draft-send-key-001');
  assert.equal(repeated.replayed, true);
  assert.equal(outgoing.length, 1);
});

test('failed draft cleanup and partial SMTP acceptance report saved/sent state without inviting duplicate delivery', async t => {
  const configuration = config(await tempDir(t));
  const fake = new FakeImap();
  const created = await createDraft(fake.asClient(), configuration, { to: ['one@example.test', 'two@example.test'], subject: 'Original', text: 'body' });
  assert(created.draft_id);
  fake.failMove = true;
  const edited = await updateDraft(fake.asClient(), configuration, created.draft_id, { text: 'updated' });
  assert(edited.saved);
  assert('previous_draft_retained' in edited && edited.previous_draft_retained);
  assert.equal(fake.folders.get('Drafts')!.messages.size, 2);
  t.mock.method(nodemailer, 'createTransport', (() => ({
    async sendMail() { return { accepted: ['one@example.test'], rejected: ['two@example.test'] }; }, close() {},
  })) as unknown as typeof nodemailer.createTransport);
  const sent = await sendDraft(fake.asClient(), configuration, created.draft_id, 'partial-send-001');
  assert.equal(sent.delivery_status, 'partially_sent');
  assert.equal(sent.draft_cleanup_complete, false);
  assert.equal(fake.folders.get('Drafts')!.messages.size, 2);
});
