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

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<MailConfig> {
  const configPath = path.resolve(env.MAIL_CONFIG_PATH || defaultConfigPath(env));
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
  if (env.MAIL_EMAIL) input.email = env.MAIL_EMAIL;
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new MailError('CONFIG_INVALID', '邮箱配置无效。请运行配置向导，或检查邮箱地址及服务器配置。');
  const settings = parsed.data;
  if (settings.provider === 'custom' && (!settings.imap || !settings.smtp)) {
    throw new MailError('CONFIG_INVALID', '自定义邮箱必须提供 IMAP 和 SMTP 服务器配置。');
  }
  let pass = env.MAIL_AUTH_CODE || env[settings.auth.passwordEnv || 'QQ_MAIL_AUTH_CODE'];
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
    throw new MailError('SECRET_MISSING', '未找到邮箱授权码。请运行配置向导，或设置 MAIL_AUTH_CODE 环境变量。');
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
