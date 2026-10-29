import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../tgcloud/', import.meta.url);
let count = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) { await check(new URL(`${entry.name}/`, directory)); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(path)], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier === 'sdk' || specifier.startsWith('sdk/')) continue;
      if (!specifier.startsWith('.') || !specifier.endsWith('.js')) throw new Error(`Unsupported runtime import: ${specifier}`);
      const target = new URL(specifier, path);
      if (!target.href.startsWith(root.href)) throw new Error(`Import outside tgcloud: ${specifier}`);
      await readFile(target);
    }
    count++;
  }
}
await check(root);
console.log(`Checked syntax and runtime imports in ${count} tgcloud modules.`);
