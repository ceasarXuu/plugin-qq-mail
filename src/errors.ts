export class MailError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'MailError';
  }
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof MailError) return { code: error.code, message: error.message };
  const details = error as { code?: string; authenticationFailed?: boolean; responseCode?: number };
  if (details?.authenticationFailed || details?.code === 'EAUTH') {
    return { code: 'AUTH_FAILED', message: '邮箱认证失败。请确认已开启 IMAP/SMTP，并使用有效的邮箱授权码。' };
  }
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'CONNECT_TIMEOUT'].includes(details?.code ?? '')) {
    return { code: 'CONNECTION_FAILED', message: '无法连接邮箱服务。请检查网络、服务器地址、端口与 TLS 设置。' };
  }
  return { code: 'MAIL_OPERATION_FAILED', message: '邮箱操作未完成。请检查连接或邮箱权限；有副作用的操作请先核对结果再重试。' };
}
