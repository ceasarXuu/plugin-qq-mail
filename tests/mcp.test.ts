import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMailServer } from '../src/server.js';
import { config, FakeImap, sample, tempDir } from './fixtures.js';
import { MailError } from '../src/errors.js';

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, JSON.stringify(result));
  const content = result.content as { type: string; text: string }[];
  assert.equal(content[0]?.type, 'text');
  return JSON.parse(content[0]!.text) as T;
}

test('MCP client discovers tools and completes search/read/flag/archive/trash against a mock mailbox', { timeout: 15000 }, async t => {
  const fake = new FakeImap();
  await fake.add('INBOX', sample);
  const server = createMailServer(fake.service(config(await tempDir(t))));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  const names = tools.tools.map(tool => tool.name);
  for (const name of ['read_email', 'read_attachment', 'update_draft', 'delete_emails', 'archive_emails', 'batch_modify_email']) assert(names.includes(name));
  assert.equal(tools.tools.find(tool => tool.name === 'read_email')?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find(tool => tool.name === 'delete_emails')?.annotations?.destructiveHint, true);
  const result = await call<{ emails: { id: string }[] }>(client, 'search_emails', { query: 'subject:Project has:attachment' });
  const id = result.emails[0]!.id;
  const message = await call<{ text: string; attachments: { attachment_id: string }[]; unread: boolean }>(client, 'read_email', { message_id: id });
  assert(message.text.includes('Read this report'));
  assert.equal(message.unread, true);
  const attachment = await call<{ content_base64: string }>(client, 'read_attachment', { message_id: id, attachment_id: message.attachments[0]!.attachment_id });
  assert.equal(Buffer.from(attachment.content_base64, 'base64').toString(), 'attachment content');
  const flags = await call<{ complete: boolean }>(client, 'batch_modify_email', { message_ids: [id], read: true, starred: true });
  assert(flags.complete);
  const archived = await call<{ complete: boolean; results: { new_message_id: string }[] }>(client, 'archive_emails', { message_ids: [id] });
  assert(archived.complete);
  const trashed = await call<{ complete: boolean }>(client, 'delete_emails', { message_ids: [archived.results[0]!.new_message_id] });
  assert(trashed.complete);
  const unsupported = await client.callTool({ name: 'search_emails', arguments: { query: 'category:promotions' } });
  assert.equal(unsupported.isError, true);
  assert(!JSON.stringify(unsupported).includes('test-only-secret'));
});

test('standalone bundled stdio server initializes and returns a redacted unconfigured profile', { timeout: 15000 }, async t => {
  const directory = await tempDir(t);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.resolve('dist/mail-server.cjs')], stderr: 'pipe',
    env: { MAIL_CONFIG_PATH: path.join(directory, 'missing-config.json') },
  });
  const client = new Client({ name: 'stdio-test-client', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 22);
  const profile = await call<{ configured: boolean; configuration_error: { code: string } }>(client, 'get_profile');
  assert.equal(profile.configured, false);
  assert.equal(profile.configuration_error.code, 'CONFIG_MISSING');
});

test('MCP routes each operation to the requested account and rejects cross-account message IDs', async t => {
  const directory = await tempDir(t);
  const first = config(directory);
  const second = { ...config(directory), email: 'second@qq.com', accountId: 'abcdefabcdefabcdefabcdef' };
  const boxes = [new FakeImap(), new FakeImap()];
  await boxes[0]!.add('INBOX', sample);
  await boxes[1]!.add('INBOX', sample);
  const service = {
    accounts: async () => ({ accounts: [{ email_address: first.email, default: true }, { email_address: second.email, default: false }] }),
    profile: async () => ({}), verify: async () => ({}),
    run: async <T>(operation: Parameters<ReturnType<FakeImap['service']>['run']>[0], account?: string): Promise<T> => {
      const index = !account || account === first.email ? 0 : account === second.email ? 1 : -1;
      if (index < 0) throw new MailError('ACCOUNT_NOT_FOUND', 'Unknown account');
      return await operation(boxes[index]!.asClient(), [first, second][index]!) as T;
    },
  };
  const server = createMailServer(service);
  const client = new Client({ name: 'multi-account-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const firstSearch = await call<{ emails: { id: string }[] }>(client, 'search_emails', { folder: 'INBOX' });
  const secondSearch = await call<{ emails: { id: string }[] }>(client, 'search_emails', { folder: 'INBOX', account: second.email });
  assert.notEqual(firstSearch.emails[0]!.id, secondSearch.emails[0]!.id);
  const wrong = await client.callTool({ name: 'batch_modify_email', arguments: { account: first.email, message_ids: [secondSearch.emails[0]!.id], read: true } });
  assert.equal(wrong.isError, true);
  assert(!boxes[0]!.calls.some(item => item.method === 'flags'));
  const marked = await call<{ complete: boolean }>(client, 'batch_modify_email', { account: second.email, message_ids: [secondSearch.emails[0]!.id], read: true });
  assert(marked.complete);
  assert(boxes[1]!.calls.some(item => item.method === 'flags'));
});

test('bundled server lists and selects multiple environment-configured QQ accounts without exposing credentials', { timeout: 15000 }, async t => {
  const directory = await tempDir(t);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.resolve('dist/mail-server.cjs')], stderr: 'pipe',
    env: { HOME: directory, MAIL_EMAIL: 'first@qq.com', MAIL_AUTH_CODE: 'first-secret', MAIL_ACCOUNT_2_EMAIL: 'second@qq.com', MAIL_ACCOUNT_2_AUTH_CODE: 'second-secret' },
  });
  const client = new Client({ name: 'multi-stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const accounts = await call<{ accounts: { email_address: string; default: boolean }[] }>(client, 'list_accounts');
  assert.deepEqual(accounts.accounts.map(item => item.email_address), ['first@qq.com', 'second@qq.com']);
  assert.equal(accounts.accounts[0]!.default, true);
  const profile = await call<{ configured: boolean; email_address: string }>(client, 'get_profile', { account: 'second@qq.com' });
  assert.equal(profile.configured, true);
  assert.equal(profile.email_address, 'second@qq.com');
  assert(!JSON.stringify([accounts, profile]).includes('secret'));
});
