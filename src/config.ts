import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { MailError } from './errors.js';

const safeString = z.string().min(1).max(1024).refine(value => !/[\r\n\0]/u.test(value));
const endpoint = z.object({
  host: safeString,
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls']).default('tls'),
});
const configSchema = z.object({
  provider: z.enum(['qq', 'custom']).default('qq'),
  email: z.email(),
  displayName: z.string().max(200).refine(value => !/[\r\n\0]/u.test(value)).optional(),
  auth: z.object({
    user: safeString.optional(),
    passwordEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).optional(),
    passwordFile: safeString.optional(),
  }).default({}),
  imap: endpoint.optional(),
  smtp: endpoint.optional(),
  folders: z.object({
    drafts: safeString.optional(), sent: safeString.optional(),
    trash: safeString.optional(), archive: safeString.optional(), junk: safeString.optional(),
  }).default({}),
  stateDir: safeString.optional(),
}).strict();

export interface MailConfig {
  provider: 'qq' | 'custom';
  email: string;
  displayName?: string;
  auth: { user: string; pass: string };
  imap: z.infer<typeof endpoint>;
  smtp: z.infer<typeof endpoint>;
  folders: z.infer<typeof configSchema>['folders'];
  accountId: string;
  stateDir: string;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'qq-mail', 'config.json');
}

export interface NamedAccount { email: string; secretKey: string; credentialConfigured: boolean }

export function namedAccounts(env: NodeJS.ProcessEnv = process.env): NamedAccount[] {
  const accounts: NamedAccount[] = [];
  for (const [key, email] of Object.entries(env)) {
    const match = /^MAIL_ACCOUNT_([A-Z0-9]+(?:_[A-Z0-9]+)*)_EMAIL$/u.exec(key);
    if (!match) continue;
    if (!email || !z.email().safeParse(email).success) {
      throw new MailError('CONFIG_INVALID', `${key} 不是有效的邮箱地址。`);
    }
    const secretKey = `MAIL_ACCOUNT_${match[1]}_AUTH_CODE`;
    if (accounts.some(account => account.email.toLowerCase() === email.toLowerCase())) {
      throw new MailError('CONFIG_INVALID', '多个邮箱配置使用了相同地址，请删除重复配置。');
    }
    accounts.push({ email, secretKey, credentialConfigured: Boolean(env[secretKey]) });
  }
  return accounts;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env, account?: string): Promise<MailConfig> {
  const configPath = path.resolve(env.MAIL_CONFIG_PATH || defaultConfigPath(env));
  const named = namedAccounts(env);
  const selected = account && named.find(item => item.email.toLowerCase() === account.toLowerCase());
  let input: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid config shape');
    input = raw as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new MailError('CONFIG_INVALID', '邮箱配置文件无法读取或不是合法 JSON。');
    }
    if (env.MAIL_CONFIG_PATH) throw new MailError('CONFIG_MISSING', 'MAIL_CONFIG_PATH 指向的配置文件不存在。');
  }
  const primaryEmail = env.MAIL_EMAIL || (typeof input.email === 'string' ? input.email : undefined);
  if (primaryEmail && named.some(item => item.email.toLowerCase() === primaryEmail.toLowerCase())) {
    throw new MailError('CONFIG_INVALID', '附加邮箱地址与默认邮箱重复，请删除重复配置。');
  }
  if (selected) input = { email: selected.email };
  else if (env.MAIL_EMAIL) input.email = env.MAIL_EMAIL;
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new MailError('CONFIG_INVALID', '邮箱配置无效。请运行配置向导，或检查邮箱地址及服务器配置。');
  const settings = parsed.data;
  if (account && settings.email.toLowerCase() !== account.toLowerCase()) {
    throw new MailError('ACCOUNT_NOT_FOUND', '未找到指定邮箱，请先调用 list_accounts 查看可用账号。');
  }
  if (settings.provider === 'custom' && (!settings.imap || !settings.smtp)) {
    throw new MailError('CONFIG_INVALID', '自定义邮箱必须提供 IMAP 和 SMTP 服务器配置。');
  }
  let pass = selected ? env[selected.secretKey] : env.MAIL_AUTH_CODE || env[settings.auth.passwordEnv || 'QQ_MAIL_AUTH_CODE'];
  if (!pass && settings.auth.passwordFile) {
    const secretPath = path.resolve(path.dirname(configPath), settings.auth.passwordFile);
    try {
      const info = await stat(secretPath);
      if (!info.isFile() || info.size > 4096) throw new Error('invalid secret file');
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
        throw new MailError('SECRET_PERMISSIONS', '授权码文件权限过宽。请将其权限设为 600。');
      }
      pass = (await readFile(secretPath, 'utf8')).trim();
    } catch (error) {
      if (error instanceof MailError) throw error;
      throw new MailError('SECRET_UNAVAILABLE', '无法读取本机授权码文件。请重新运行配置向导。');
    }
  }
  if (!pass || /[\r\n\0]/u.test(pass)) {
    throw new MailError('SECRET_MISSING', selected ? `未找到 ${selected.secretKey}，请为该邮箱配置独立授权码。` : '未找到邮箱授权码。请运行配置向导，或设置 MAIL_AUTH_CODE 环境变量。');
  }
  const imap = settings.imap || { host: 'imap.qq.com', port: 993, security: 'tls' as const };
  const smtp = settings.smtp || { host: 'smtp.qq.com', port: 465, security: 'tls' as const };
  const auth = { user: settings.auth.user || settings.email, pass };
  const accountId = createHash('sha256').update(JSON.stringify([auth.user, imap.host, imap.port])).digest('hex').slice(0, 24);
  return {
    provider: settings.provider, email: settings.email, displayName: settings.displayName,
    auth, imap, smtp, folders: settings.folders, accountId,
    stateDir: settings.stateDir ? path.resolve(path.dirname(configPath), settings.stateDir) : path.join(path.dirname(configPath), 'state'),
  };
}
