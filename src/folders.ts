import type { ImapFlow, ListResponse } from 'imapflow';
import type { MailConfig } from './config.js';
import { MailError } from './errors.js';

export type FolderRole = keyof MailConfig['folders'];
const roleFlags: Record<FolderRole, string> = {
  drafts: '\\Drafts', sent: '\\Sent', trash: '\\Trash', archive: '\\Archive', junk: '\\Junk',
};

export async function getFolders(client: ImapFlow, config: MailConfig, counts = false): Promise<ListResponse[]> {
  const folders = await client.list({
    specialUseHints: config.folders,
    ...(counts ? { statusQuery: { messages: true, unseen: true } } : {}),
  });
  return folders.filter(folder => !folder.flags.has('\\Noselect'));
}

export function resolveFolder(roleOrPath: string, folders: ListResponse[], config: MailConfig): string {
  if (roleOrPath.toLowerCase() === 'inbox') return 'INBOX';
  const role = ({ spam: 'junk', draft: 'drafts' } as Record<string, string>)[roleOrPath] || roleOrPath;
  if (Object.hasOwn(roleFlags, role)) {
    const typedRole = role as FolderRole;
    const configured = config.folders[typedRole];
    if (configured) {
      if (folders.some(folder => folder.path === configured)) return configured;
      throw new MailError('FOLDER_UNAVAILABLE', `配置的 ${typedRole} 文件夹不存在，请核对 folders.${typedRole}。`);
    }
    const discovered = folders.find(folder => folder.specialUse === roleFlags[typedRole]);
    if (discovered) return discovered.path;
    if (typedRole === 'archive' && folders.some(folder => folder.path === 'Archive')) return 'Archive';
    throw new MailError('FOLDER_UNAVAILABLE', `未识别到 ${typedRole} 文件夹。请在本机配置 folders.${typedRole}，或先创建并指定对应文件夹。`);
  }
  const existing = folders.find(folder => folder.path === roleOrPath);
  if (!existing) throw new MailError('FOLDER_NOT_FOUND', '目标文件夹不存在。请先调用 list_folders 获取真实路径。');
  return existing.path;
}

export async function listFolders(client: ImapFlow, config: MailConfig) {
  return {
    organization_model: 'imap_folders',
    folders: (await getFolders(client, config, true)).map(folder => ({
      path: folder.path, name: folder.name, special_use: folder.specialUse || null,
      messages_total: folder.status?.messages ?? null, messages_unread: folder.status?.unseen ?? null,
    })),
  };
}
