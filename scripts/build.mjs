import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';

await mkdir('dist', { recursive: true });
const result = await build({
  entryPoints: { 'mail-server': 'src/main.ts', 'mail-cli': 'src/cli.ts' },
  outdir: 'dist', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  sourcemap: false, legalComments: 'eof', metafile: true,
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !builtinModules.includes(dependency.path.replace(/^node:/u, ''))) {
      throw new Error(`Unbundled runtime dependency: ${dependency.path}`);
    }
  }
}
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = [];
for (const [directory, info] of Object.entries(lock.packages)) {
  if (!directory || info.dev) continue;
  const entries = await readdir(directory);
  const files = entries.filter(name => /^(license|copying|notice)([.-]|$)/iu.test(name));
  notices.push(`\n===== ${info.name || directory.split('node_modules/').at(-1)} ${info.version} (${info.license || 'see license'}) =====\n`);
  for (const filename of files) notices.push(await readFile(`${directory}/${filename}`, 'utf8'));
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n'));
