import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type { FetchMessageObject, ImapFlow, ListResponse, SearchObject } from 'imapflow';
import { parseSource } from '../src/messages.js';
import type { MailConfig } from '../src/config.js';
import type { MailService } from '../src/service.js';

export async function tempDir(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qq-mail-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export function config(stateDir: string): MailConfig {
  return {
    provider: 'qq', email: 'owner@example.test', auth: { user: 'owner@example.test', pass: 'test-only-secret' },
    imap: { host: 'imap.invalid', port: 993, security: 'tls' },
    smtp: { host: 'smtp.invalid', port: 465, security: 'tls' },
    accountId: '123456789012345678901234', stateDir, folders: {},
  };
}

export const sample = Buffer.from([
  'From: Alice <alice@example.test>', 'To: owner@example.test', 'Subject: Project report',
  'Message-ID: <report@example.test>', 'Date: Wed, 28 Oct 2026 10:00:00 +0000',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="test-boundary"', '',
  '--test-boundary', 'Content-Type: text/plain; charset=utf-8', '', 'Read this report.',
  '--test-boundary', 'Content-Type: text/plain; name="report.txt"',
  'Content-Disposition: attachment; filename="report.txt"', 'Content-Transfer-Encoding: base64', '',
  Buffer.from('attachment content').toString('base64'), '--test-boundary--', '',
].join('\r\n'));

interface Folder { validity: bigint; messages: Map<number, FetchMessageObject>; next: number; special?: string }

export class FakeImap {
  folders = new Map<string, Folder>();
  mailbox: { path: string; uidValidity: bigint; exists: number } | false = false;
  capabilities = new Map([['MOVE', true], ['UIDPLUS', true]]);
  calls: { method: string; readOnly?: boolean; folder?: string; uids?: number[]; flags?: string[] }[] = [];
  failMove = false;

  constructor() {
    for (const [name, special] of [['INBOX', undefined], ['Drafts', '\\Drafts'], ['Sent', '\\Sent'], ['Trash', '\\Trash'], ['Junk', '\\Junk']] as const) {
      this.folders.set(name, { validity: 100n + BigInt(this.folders.size), messages: new Map(), next: 1, special });
    }
  }
  asClient() { return this as unknown as ImapFlow; }
  selected() {
    if (!this.mailbox) throw new Error('No mailbox');
    return this.folders.get(this.mailbox.path)!;
  }
  async add(folder: string, source: Buffer, flags: string[] = []) {
    const target = this.folders.get(folder)!;
    const parsed = await parseSource(source);
    const uid = target.next++;
    const addresses = (value: typeof parsed.to) => (Array.isArray(value) ? value : value ? [value] : []).flatMap(item => item.value);
    target.messages.set(uid, {
      uid, seq: uid, source, size: source.length, flags: new Set(flags),
      internalDate: parsed.date || new Date('2026-10-28T10:00:00Z'),
      envelope: {
        subject: parsed.subject, from: parsed.from?.value, to: addresses(parsed.to), cc: addresses(parsed.cc), bcc: addresses(parsed.bcc),
        messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, date: parsed.date,
      },
      bodyStructure: { type: 'multipart/mixed', childNodes: parsed.attachments.map(item => ({ type: item.contentType, disposition: 'attachment', dispositionParameters: { filename: item.filename || 'attachment' } })) },
    });
    if (this.mailbox && this.mailbox.path === folder) this.mailbox.exists = target.messages.size;
    return uid;
  }
  async getMailboxLock(folder: string, options: { readOnly?: boolean }) {
    const target = this.folders.get(folder);
    if (!target) throw new Error('Unknown mailbox');
    this.mailbox = { path: folder, uidValidity: target.validity, exists: target.messages.size };
    this.calls.push({ method: 'lock', folder, readOnly: options.readOnly });
    return { release() {} };
  }
  async list() {
    return [...this.folders].map(([name, value]) => ({
      path: name, name, flags: new Set<string>(), specialUse: value.special,
      status: { messages: value.messages.size, unseen: [...value.messages.values()].filter(item => !item.flags?.has('\\Seen')).length },
    })) as ListResponse[];
  }
  async mailboxCreate(name: string) {
    this.folders.set(name, { validity: 999n, messages: new Map(), next: 1 });
    this.calls.push({ method: 'create', folder: name });
    return { path: name };
  }
  async fetchOne(uid: number, query: { source?: unknown }) {
    this.calls.push({ method: query.source ? 'fetch_source' : 'fetch', uids: [uid] });
    return this.selected().messages.get(uid) || false;
  }
  async fetchAll(uids: number[]) {
    if (!Array.isArray(uids) || !uids.length) throw new Error('Unsafe empty fetch');
    this.calls.push({ method: 'fetch_all', uids });
    return uids.flatMap(uid => this.selected().messages.get(uid) || []);
  }
  async search(query: SearchObject) {
    this.calls.push({ method: 'search' });
    return [...this.selected().messages.values()].filter(item => matches(query, item)).map(item => item.uid);
  }
  async append(folder: string, raw: Buffer, flags: string[]) {
    this.calls.push({ method: 'append', folder });
    const uid = await this.add(folder, raw, flags);
    return { uid, uidValidity: this.folders.get(folder)!.validity };
  }
  async messageMove(uids: number[], destination: string) {
    this.calls.push({ method: 'move', folder: destination, uids });
    if (this.failMove) return false;
    const origin = this.selected();
    const uidMap = new Map<number, number>();
    for (const uid of uids) {
      const value = origin.messages.get(uid);
      if (value?.source) {
        const next = await this.add(destination, value.source, [...(value.flags || [])]);
        uidMap.set(uid, next);
        origin.messages.delete(uid);
      }
    }
    return { uidMap, uidValidity: this.folders.get(destination)!.validity };
  }
  async messageFlagsAdd(uids: number[], flags: string[]) { return this.flags(uids, flags, true); }
  async messageFlagsRemove(uids: number[], flags: string[]) { return this.flags(uids, flags, false); }
  flags(uids: number[], flags: string[], add: boolean) {
    this.calls.push({ method: 'flags', uids, flags });
    for (const uid of uids) for (const flag of flags) {
      const message = this.selected().messages.get(uid);
      if (add) message?.flags?.add(flag); else message?.flags?.delete(flag);
    }
    return true;
  }
  service(configuration: MailConfig): MailService {
    return {
      profile: async () => ({ configured: true, email_address: configuration.email }),
      verify: async () => ({ connected: true, email_sent: false }),
      run: operation => operation(this.asClient(), configuration),
    };
  }
}

function matches(query: SearchObject, item: FetchMessageObject): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (key === 'all') return true;
    if (key === 'not') return !matches(value as SearchObject, item);
    if (key === 'or') return (value as SearchObject[]).some(term => matches(term, item));
    if (key === 'uid') { const [low, high] = String(value).split(':').map(Number); return item.uid >= low! && item.uid <= (high ?? low!); }
    const flag = ({ seen: '\\Seen', flagged: '\\Flagged', deleted: '\\Deleted' } as Record<string, string>)[key];
    if (flag) return Boolean(item.flags?.has(flag)) === value;
    if (key === 'header') return Object.entries(value as Record<string, string>).every(([header, content]) =>
      header.toLowerCase() === 'message-id' ? item.envelope?.messageId === content : false);
    if (key === 'subject') return (item.envelope?.subject || '').includes(String(value));
    if (key === 'from' || key === 'to') return (item.envelope?.[key] || []).some(address => address.address?.includes(String(value)));
    if (key === 'text') return item.source?.toString().includes(String(value)) || false;
    return true;
  });
}
