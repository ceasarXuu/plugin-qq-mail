import type { SearchObject } from 'imapflow';
import { MailError } from './errors.js';

export interface QueryPlan {
  search: SearchObject;
  folders: string[];
  excludeFolders: string[];
  anywhere: boolean;
  attachment?: boolean;
}

export function andQueries(terms: SearchObject[]): SearchObject {
  if (!terms.length) return { all: true };
  if (terms.length === 1) return terms[0]!;
  // IMAP SEARCH has implicit AND; De Morgan preserves repeated keys without losing conditions.
  return { not: { or: terms.map(term => ({ not: term })) } };
}

function tokens(query: string): string[] {
  const values: string[] = [];
  let value = '', quoted = false, escaped = false;
  for (const char of query) {
    if (escaped) { value += char; escaped = false; continue; }
    if (char === '\\' && quoted) { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && /[(){}]/u.test(char)) throw new MailError('UNSUPPORTED_QUERY', '当前支持以空格组合的 AND 条件，不支持 OR、括号或花括号分组。');
    if (!quoted && /\s/u.test(char)) {
      if (value) values.push(value);
      value = '';
    } else { value += char; }
  }
  if (quoted || escaped) throw new MailError('INVALID_QUERY', '搜索条件中的引号未闭合。');
  if (value) values.push(value);
  if (values.length > 50) throw new MailError('INVALID_QUERY', '一次搜索最多包含 50 个条件。');
  return values;
}

function parseDate(value: string): Date {
  const normalized = value.replaceAll('/', '-');
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new MailError('INVALID_QUERY', '日期格式须为 YYYY-MM-DD 或 YYYY/MM/DD，且必须是有效日期。');
  }
  return date;
}

export function parseQuery(query: string, email: string, now = new Date()): QueryPlan {
  const plan: QueryPlan = { search: {}, folders: [], excludeFolders: [], anywhere: false };
  const terms: SearchObject[] = [];
  if (query.length > 4096) throw new MailError('INVALID_QUERY', '搜索条件过长。');
  for (let token of tokens(query)) {
    if (token === 'OR') throw new MailError('UNSUPPORTED_QUERY', '当前不支持 OR，请分别搜索各条件。');
    const negative = token.startsWith('-');
    if (negative) token = token.slice(1);
    const split = token.indexOf(':');
    const key = split < 0 ? 'text' : token.slice(0, split).toLowerCase();
    let value = split < 0 ? token : token.slice(split + 1);
    if (!value) throw new MailError('INVALID_QUERY', '搜索条件不能包含空值。');
    if (key === 'in' || key === 'label') {
      if (value === 'anywhere' && !negative && key === 'in') plan.anywhere = true;
      else (negative ? plan.excludeFolders : plan.folders).push(value);
      continue;
    }
    if (key === 'has' && value === 'attachment') {
      if (plan.attachment !== undefined && plan.attachment !== !negative) throw new MailError('INVALID_QUERY', '附件搜索条件互相冲突。');
      plan.attachment = !negative;
      continue;
    }
    let term: SearchObject;
    if (['from', 'to', 'cc', 'bcc', 'subject', 'body', 'text'].includes(key)) {
      if (value === 'me' && ['from', 'to', 'cc', 'bcc'].includes(key)) value = email;
      term = { [key]: value };
    } else if (key === 'after' || key === 'before') {
      term = { [key === 'after' ? 'since' : 'before']: parseDate(value) };
    } else if (key === 'newer_than') {
      const match = /^(\d{1,5})([dw])$/u.exec(value);
      if (!match) throw new MailError('UNSUPPORTED_QUERY', 'newer_than 目前支持天 d 或周 w，例如 newer_than:7d。');
      const days = Number(match[1]) * (match[2] === 'w' ? 7 : 1);
      term = { since: new Date(now.getTime() - days * 86400000) };
    } else if (key === 'is') {
      const flags: Record<string, SearchObject> = {
        unread: { seen: false }, read: { seen: true }, starred: { flagged: true }, unstarred: { flagged: false },
      };
      if (!flags[value]) throw new MailError('UNSUPPORTED_QUERY', 'is: 仅支持 unread、read、starred、unstarred。');
      term = flags[value]!;
    } else if (key === 'larger' || key === 'smaller') {
      const match = /^(\d+)([kKmM]?)$/u.exec(value);
      if (!match) throw new MailError('INVALID_QUERY', '大小条件须为字节数，或使用 K、M 后缀。');
      const amount = Number(match[1]) * ({ k: 1024, m: 1048576 }[match[2]!.toLowerCase()] || 1);
      if (!Number.isSafeInteger(amount)) throw new MailError('INVALID_QUERY', '邮件大小条件超出范围。');
      term = { [key]: amount };
    } else {
      throw new MailError('UNSUPPORTED_QUERY', `不支持搜索操作符 ${key.slice(0, 30)}:。请使用文档列出的条件，不会忽略此条件扩大搜索范围。`);
    }
    terms.push(negative ? { not: term } : term);
  }
  plan.search = andQueries(terms);
  return plan;
}
