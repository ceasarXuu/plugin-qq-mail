import { z } from 'zod';
import { MailError } from './errors.js';

const idSchema = z.object({
  v: z.literal(1), a: z.string().length(24),
  f: z.string().min(1).max(1024).refine(value => !/[\r\n\0]/u.test(value)),
  u: z.number().int().min(1).max(4294967295),
  uv: z.string().regex(/^[1-9][0-9]*$/u),
}).strict();
export type MessageRef = z.infer<typeof idSchema>;

export function messageId(account: string, folder: string, validity: bigint | string, uid: number): string {
  return `mail_${Buffer.from(JSON.stringify({ v: 1, a: account, f: folder, uv: String(validity), u: uid })).toString('base64url')}`;
}

export function parseMessageId(id: string, account: string): MessageRef {
  try {
    if (!/^mail_[A-Za-z0-9_-]+$/u.test(id) || id.length > 4096) throw new Error('invalid');
    const ref = idSchema.parse(JSON.parse(Buffer.from(id.slice(5), 'base64url').toString('utf8')));
    if (ref.a !== account) throw new Error('account mismatch');
    return ref;
  } catch {
    throw new MailError('INVALID_MESSAGE_ID', '邮件 ID 无效或属于其他邮箱。请从当前邮箱重新搜索获取 ID。');
  }
}
