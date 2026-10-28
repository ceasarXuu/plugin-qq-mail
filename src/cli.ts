import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { defaultConfigPath } from './config.js';
import { MailError, publicError } from './errors.js';
import { createService } from './service.js';

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new MailError('TTY_REQUIRED', '配置向导需要交互式终端。无终端时请通过环境变量配置，勿在命令行参数中填写授权码。');
  process.stdout.write(prompt);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let secret = '';
    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(secret);
    };
    const onData = (data: Buffer) => {
      for (const char of data.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') { finish(new MailError('CANCELLED', '已取消配置。')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') { secret = secret.slice(0, -1); continue; }
        if (char >= ' ' && char <= '~' && secret.length < 4096) secret += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function configure(configPath: string) {
  if (!process.stdin.isTTY) throw new MailError('TTY_REQUIRED', '请在交互式终端运行 configure。');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const question = async (label: string, fallback = '') => (await terminal.question(`${label}${fallback ? ` [${fallback}]` : ''}：`)).trim() || fallback;
  let provider: string, email: string, imap: unknown, smtp: unknown;
  try {
    provider = z.enum(['qq', 'custom']).parse(await question('邮箱类型 qq/custom', 'qq'));
    email = z.email().parse(await question('完整邮箱地址'));
    if (provider === 'custom') {
      const getEndpoint = async (type: string, port: number) => {
        const host = z.string().min(1).max(1024).regex(/^[^\s\r\n\0]+$/u).parse(await question(`${type} 服务器`));
        const endpointPort = z.coerce.number().int().min(1).max(65535).parse(await question(`${type} 端口`, String(port)));
        const security = z.enum(['tls', 'starttls']).parse(await question(`${type} 加密方式 tls/starttls`, 'tls'));
        return { host, port: endpointPort, security };
      };
      imap = await getEndpoint('IMAP', 993);
      smtp = await getEndpoint('SMTP', 465);
    }
  } finally { terminal.close(); }
  const password = (await readSecret('邮箱授权码（输入不回显）：')).trim();
  if (!password || /[\r\n\0]/u.test(password)) throw new MailError('INVALID_SECRET', '授权码不能为空或包含换行符。');
  if (provider === 'qq' && !/^[A-Za-z]{16}$/u.test(password)) throw new MailError('INVALID_SECRET', 'QQ 邮箱需要 16 位字母授权码，请不要输入 QQ 登录密码。');
  const directory = path.dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await readFile(configPath);
    const backup = `${configPath}.backup-${Date.now()}-${randomUUID()}`;
    await copyFile(configPath, backup, constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') await chmod(backup, 0o600);
    process.stdout.write(`原配置已备份：${backup}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const passwordFilename = `auth-code-${randomUUID()}`;
  await writeFile(path.join(directory, passwordFilename), password, { mode: 0o600, flag: 'wx' });
  const config = { provider, email, auth: { passwordFile: `./${passwordFilename}` }, ...(provider === 'custom' ? { imap, smtp } : {}) };
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, configPath);
  process.stdout.write(`配置已保存：${configPath}\n授权码仅保存在本机独立文件，未显示或发送至聊天。\n下一步：运行 node dist/mail-cli.cjs check-connection 验证连接。\n`);
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { config: { type: 'string' } } });
  if (values.config) process.env.MAIL_CONFIG_PATH = path.resolve(values.config);
  switch (positionals[0]) {
    case 'configure': return configure(path.resolve(process.env.MAIL_CONFIG_PATH || defaultConfigPath()));
    case 'status': process.stdout.write(`${JSON.stringify(await createService().profile(), null, 2)}\n`); return;
    case 'check-connection': process.stdout.write(`${JSON.stringify(await createService().verify(), null, 2)}\n`); return;
    default: process.stdout.write('QQ Mail 本地邮箱插件\n\n用法：\n  node dist/mail-cli.cjs configure [--config /绝对路径/config.json]\n  node dist/mail-cli.cjs status\n  node dist/mail-cli.cjs check-connection\n\nMCP 服务：node dist/mail-server.cjs\n');
  }
}

main().catch(error => {
  const safe = publicError(error);
  process.stderr.write(`${safe.code}: ${safe.message}\n`);
  process.exitCode = 1;
});
