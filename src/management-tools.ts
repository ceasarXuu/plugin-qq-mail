import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { archiveEmails, createFolder, modifyEmails, moveEmails, trashEmails } from './management.js';
import type { MailService } from './service.js';
import { toolResult, writeAnnotations as annotations } from './tool-result.js';

const ids = z.array(z.string().min(1).max(4096)).min(1).max(100).describe('复制自本插件结果的明确邮件 ID，最多 100 封；不接受搜索表达式或通配符。');
const folder = z.string().min(1).max(1024).refine(value => !/[\r\n\0]/u.test(value));

export function registerManagementTools(server: McpServer, service: MailService) {
  server.registerTool('create_folder', {
    title: '创建邮箱文件夹', description: '按用户要求创建真实 IMAP 文件夹；名称已存在时直接返回。QQ 文件夹对应组织邮件的用途，不提供 Gmail 多标签语义。',
    inputSchema: { path: folder }, annotations: { ...annotations, destructiveHint: false, idempotentHint: true },
  }, input => toolResult(() => service.run((client, config) => createFolder(client, config, input.path))));
  server.registerTool('move_emails', {
    title: '移动邮件', description: '将选定邮件移到真实文件夹。移动后 ID 通常改变，请使用返回的新 ID 或重新搜索。批量结果逐封报告；只按用户明确要求执行。',
    inputSchema: { message_ids: ids, destination: folder }, annotations,
  }, input => toolResult(() => service.run((client, config) => moveEmails(client, config, input.message_ids, input.destination))));
  server.registerTool('archive_emails', {
    title: '归档邮件', description: '将选定邮件移入归档文件夹。优先使用配置或服务器标记的归档目录，未设置时创建并使用 Archive；保留邮件内容，可移回收件箱。',
    inputSchema: { message_ids: ids }, annotations,
  }, input => toolResult(() => service.run((client, config) => archiveEmails(client, config, input.message_ids))));
  server.registerTool('delete_emails', {
    title: '移入垃圾箱', description: '按用户明确要求将选定邮件移入垃圾箱，不永久删除。已在垃圾箱的邮件保持原状；不提供清空垃圾箱或永久删除接口。',
    inputSchema: { message_ids: ids }, annotations,
  }, input => toolResult(() => service.run((client, config) => trashEmails(client, config, input.message_ids))));
  server.registerTool('batch_modify_email', {
    title: '修改已读与星标', description: '按用户明确要求批量修改选定邮件的已读和星标状态；不修改删除标志或其他标志。组织邮件请使用 move_emails。',
    inputSchema: { message_ids: ids, read: z.boolean().optional(), starred: z.boolean().optional() }, annotations: { ...annotations, idempotentHint: true },
  }, input => toolResult(() => service.run((client, config) => modifyEmails(client, config, input.message_ids, input.read, input.starred))));
}
