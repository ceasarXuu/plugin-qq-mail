import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const manifest = JSON.parse(await readFile('plugin.json', 'utf8'));
await stat('dist/mail-server.cjs');
await stat('dist/mail-cli.cjs');
await mkdir('releases', { recursive: true });
const archive = path.resolve('releases', `${manifest.name}-${manifest.version}.tar.gz`);
const files = ['plugin.json', 'mcp.json', '.claude-plugin', '.mcp.json', 'dist', 'skills', 'examples', 'README.md', 'docs'];
execFileSync('tar', ['-czf', archive, ...files], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
if (entries.some(entry => /(^|\/)(node_modules|\.git|\.env|auth-code[^/]*|credentials[^/]*)(\/|$)/u.test(entry))) throw new Error('Archive contains an excluded file');
process.stdout.write(`${archive}\n${entries.length} entries; no credentials or dependency directories\n`);
