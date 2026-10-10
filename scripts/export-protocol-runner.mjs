#!/usr/bin/env node
import { mkdir, writeFile, copyFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const arg = process.argv.indexOf('--out');
if (arg < 0 || !process.argv[arg + 1]) throw new Error('Usage: node scripts/export-protocol-runner.mjs --out <empty-output-directory>');
const output = process.argv[arg + 1];
await mkdir(output, { recursive: true });
if ((await lstat(output)).isSymbolicLink() || (await readdir(output)).length) throw new Error('output directory must be a new, empty, non-symlink directory');
const core = join(root, 'runner-core');
const library = join(output, 'dist-workspace/src');
await mkdir(library, { recursive: true });
for (const module of ['protocol-package.js', 'protocol-package-closure.js', 'protocol-compiler.js', 'workspace-contract.js', 'workspace-interpreter.js', 'workspace-admin.js', 'errors.js', 'json.js']) {
  await copyFile(join(core, 'dist-workspace/src', module), join(library, module));
}
await mkdir(join(output, 'scripts'), { recursive: true });
await copyFile(join(root, 'scripts/protocol-package.mjs'), join(output, 'scripts/protocol-package.mjs'));
async function copyRuntime(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name), target = join(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error('dependency source contains a symbolic link');
    if (entry.isDirectory()) await copyRuntime(source, target);
    else if (entry.isFile() && entry.name.endsWith('.js')) await copyFile(source, target);
  }
}
const vendor = join(output, 'node_modules/zod');
await mkdir(vendor, { recursive: true });
for (const file of ['index.js', 'package.json', 'LICENSE']) await copyFile(join(core, 'node_modules/zod', file), join(vendor, file));
await copyRuntime(join(core, 'node_modules/zod/v4'), join(vendor, 'v4'));
await copyFile(join(core, 'LICENSE'), join(output, 'LICENSE'));
await copyFile(join(core, 'PORTABLE-CORE-NOTICE.md'), join(output, 'PORTABLE-CORE-NOTICE.md'));
await writeFile(join(output, 'package.json'), JSON.stringify({ name: 'peerwork-protocol-runner', version: '1.0.0', private: true, type: 'module', engines: { node: '>=24.20.0 <25' }, scripts: { protocol: 'node scripts/protocol-package.mjs' } }, null, 2) + '\n');
await writeFile(join(output, 'README.md'), `# Portable protocol runner\n\nThis is a self-contained offline verifier. It runs on Node.js 24.20.x, uses only Node built-ins and the bundled Zod runtime, makes no network calls, and executes no package scripts.\n\nRun the scripts/protocol-package.mjs inspect or test commands, or closure-test with a canonical closure JSON file. See the repository README and PORTABLE-CORE-NOTICE.md for scope, provenance, and license boundaries.\n`);
