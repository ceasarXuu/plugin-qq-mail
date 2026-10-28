import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMailServer } from './server.js';

const server = createMailServer();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close().finally(() => process.exit(0)); });
}
server.connect(new StdioServerTransport()).catch(() => {
  process.stderr.write('QQ Mail MCP 启动失败，请检查运行时及插件安装。\n');
  process.exitCode = 1;
});
