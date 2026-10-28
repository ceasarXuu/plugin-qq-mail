import nodemailer from 'nodemailer';
import { loadConfig, type MailConfig } from './config.js';
import { withImap } from './connection.js';
import { smtpOptions } from './delivery.js';
import { publicError } from './errors.js';
import type { ImapFlow } from 'imapflow';

export interface MailService {
  profile(): Promise<unknown>;
  verify(): Promise<unknown>;
  run<T>(operation: (client: ImapFlow, config: MailConfig) => Promise<T>): Promise<T>;
}

export function createService(): MailService {
  return {
    async profile() {
      try {
        const config = await loadConfig();
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
    async verify() {
      const config = await loadConfig();
      await withImap(config, async () => {});
      const transport = nodemailer.createTransport(smtpOptions(config));
      try { await transport.verify(); }
      finally { transport.close(); }
      return { connected: true, email_address: config.email, imap: true, smtp: true, email_sent: false };
    },
    async run<T>(operation: (client: ImapFlow, config: MailConfig) => Promise<T>): Promise<T> {
      const config = await loadConfig();
      return withImap(config, client => operation(client, config));
    },
  };
}
