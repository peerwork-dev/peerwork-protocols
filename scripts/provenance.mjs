#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function walk(path, rows = []) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolute = join(path, entry.name), stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`symlink in public bundle: ${absolute}`);
    if (stat.isDirectory()) await walk(absolute, rows);
    else if (stat.isFile()) rows.push([relative(root, absolute).split('\\').join('/'), digest(await readFile(absolute))]);
    else throw new Error(`non-regular public bundle path: ${absolute}`);
  }
  return rows;
}
const packages = JSON.parse(await readFile(join(root, 'protocol-catalog.json'), 'utf8'));
const runnerFiles = ['protocol-package.js','protocol-package-closure.js','protocol-compiler.js','workspace-contract.js','workspace-interpreter.js','workspace-admin.js','errors.js','json.js'];
const sourceFiles = (await readdir(join(root, 'src'))).filter(x => x.endsWith('.ts')).sort();
const provenance = {
  format: 'peerwork.protocol-release-provenance.v1',
  source_repository: 'https://github.com/peerwork-dev/peerwork',
  source_commit: 'b26ef91459c1b04fbf52d243ecbf83f17352fd30',
  package_count: packages.package_count,
  packages: packages.packages.map(x => ({ package_id: x.package_id, version: x.version, digest: x.digest, dependencies: x.dependencies })),
  portable_runner: {
    executable_source_of_truth: 'runner-core/dist-workspace/src/*.js',
    export_command: 'node scripts/export-protocol-runner.mjs --out <empty-directory>',
    runtime_modules: await Promise.all(runnerFiles.map(async file => ({ file: `runner-core/dist-workspace/src/${file}`, sha256: digest(await readFile(join(root, 'runner-core/dist-workspace/src', file))) }))),
    upstream_typescript_reference_files: await Promise.all(sourceFiles.map(async file => ({ file: `src/${file}`, sha256: digest(await readFile(join(root, 'src', file))) }))),
    zod_version: JSON.parse(await readFile(join(root, 'runner-core/node_modules/zod/package.json'), 'utf8')).version,
    zod_license: 'MIT'
  }
};
await writeFile(join(root, 'release-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
if (process.argv[2] === 'verify') {
  const lines = (await readFile(join(root, 'SHA256SUMS'), 'utf8')).trimEnd().split('\n');
  const expected = new Map(lines.map(line => [line.slice(66), line.slice(0, 64)]));
  const actual = (await walk(root)).filter(([path]) => path !== 'SHA256SUMS');
  if (expected.size !== actual.length) throw new Error(`checksum file count mismatch: expected ${expected.size}, found ${actual.length}`);
  for (const [path, hash] of actual) if (expected.get(path) !== hash) throw new Error(`checksum mismatch: ${path}`);
  console.log(JSON.stringify({ result: 'PASS', checksummedFiles: actual.length, sourceCommit: provenance.source_commit }));
} else {
  const rows = (await walk(root)).filter(([path]) => path !== 'SHA256SUMS').sort(([a],[b]) => a.localeCompare(b));
  await writeFile(join(root, 'SHA256SUMS'), rows.map(([path, hash]) => `${hash}  ${path}`).join('\n') + '\n');
  console.log(JSON.stringify({ generated: 'SHA256SUMS', checksummedFiles: rows.length }));
}
