import nodemailer from 'nodemailer';
import { loadConfig, namedAccounts, type MailConfig } from './config.js';
import { withImap } from './connection.js';
import { smtpOptions } from './delivery.js';
import { publicError } from './errors.js';
import type { ImapFlow } from 'imapflow';

export interface MailService {
  accounts(): Promise<unknown>;
  profile(account?: string): Promise<unknown>;
  verify(account?: string): Promise<unknown>;
  run<T>(operation: (client: ImapFlow, config: MailConfig) => Promise<T>, account?: string): Promise<T>;
}

export function createService(): MailService {
  return {
    async accounts() {
      const primary = await loadConfig();
      return { accounts: [
        { email_address: primary.email, default: true, credential_configured: true },
        ...namedAccounts().map(item => ({ email_address: item.email, default: false, credential_configured: item.credentialConfigured })),
      ] };
    },
    async profile(account) {
      try {
        const config = await loadConfig(process.env, account);
        return {
          configured: true, email_address: config.email, provider: config.provider,
          imap: config.imap, smtp: config.smtp,
          transport: 'stdio', organization_model: 'imap_folders',
          authentication: 'local_app_password', credential_returned: false,
          native_gmail_labels: false, native_gmail_thread_ids: false,
          search_language: 'documented_gmail_subset',
        };
      } catch (error) { return { configured: false, configuration_error: publicError(error) }; }
    },
    async verify(account) {
      const config = await loadConfig(process.env, account);
      await withImap(config, async () => {});
      const transport = nodemailer.createTransport(smtpOptions(config));
      try { await transport.verify(); }
      finally { transport.close(); }
      return { connected: true, email_address: config.email, imap: true, smtp: true, email_sent: false };
    },
    async run<T>(operation: (client: ImapFlow, config: MailConfig) => Promise<T>, account?: string): Promise<T> {
      const config = await loadConfig(process.env, account);
      return withImap(config, client => operation(client, config));
    },
  };
}
