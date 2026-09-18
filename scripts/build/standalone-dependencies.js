const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { fileURLToPath } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');

const execFileAsync = promisify(execFile);

/** Trace external imports from the actual compiled server, including Turbopack aliases. */
async function stageStandaloneDependencies(root, destination) {
  const buildRoot = path.join(root, '.next');
  const aliasesRoot = path.join(buildRoot, 'node_modules');
  const aliases = [];
  for (const entry of await fs.readdir(aliasesRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const name of await fs.readdir(path.join(aliasesRoot, entry.name))) aliases.push(`${entry.name}/${name}`);
    } else aliases.push(entry.name);
  }
  const imports = new Set(['next', 'js-yaml', 'tar']);
  async function inspect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (entry.name.endsWith('.js')) {
        const source = await fs.readFile(file, 'utf8');
        for (const match of source.matchAll(/["']([^"'\\\s]+)["']/g)) {
          if (aliases.some((alias) => match[1] === alias || match[1].startsWith(`${alias}/`))) imports.add(match[1]);
        }
      }
    }
  }
  await inspect(path.join(buildRoot, 'server'));
  const specifiers = [...imports];
  // Resolve both import and require conditions without executing package code.
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e',
    'console.log(JSON.stringify(JSON.parse(process.argv[1]).map(s => { try { return import.meta.resolve(s); } catch { return null; } })))',
    JSON.stringify(specifiers)], { cwd: buildRoot, maxBuffer: 1024 * 1024, timeout: 30_000 });
  const esm = JSON.parse(stdout);
  const resolve = createRequire(path.join(buildRoot, 'standalone-trace.cjs')).resolve;
  const entries = new Set();
  for (const [index, specifier] of specifiers.entries()) {
    let cjs;
    try { cjs = resolve(specifier); } catch { /* An import-only export is valid. */ }
    if (cjs) entries.add(cjs);
    if (esm[index]?.startsWith('file:')) entries.add(fileURLToPath(esm[index]));
    if (!cjs && !esm[index]) throw new Error(`Cannot resolve standalone runtime dependency: ${specifier}`);
  }
  const { fileList } = await nodeFileTrace([...entries], {
    base: root,
    processCwd: root,
    // Runtime dependency repair must never copy application data or environment files.
    ignore: (file) => !file.startsWith('node_modules/'),
  });
  const files = [...fileList].filter((file) => file.startsWith('node_modules/'));
  for (let offset = 0; offset < files.length; offset += 64) {
    await Promise.all(files.slice(offset, offset + 64).map(async (file) => {
      const source = path.join(root, file);
      if (!(await fs.stat(source)).isFile()) return;
      const target = path.join(destination, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }));
  }
  console.log(`[build] Verified dependency closure for ${specifiers.length} runtime imports (${files.length} files).`);
}

module.exports = { stageStandaloneDependencies };
