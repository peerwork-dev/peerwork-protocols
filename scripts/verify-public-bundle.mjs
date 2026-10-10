#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TextEncoder } from 'node:util';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), 'peerwork-protocol-check-'));
async function importFresh(path) { return import(`${pathToFileURL(path).href}?run=${Math.random()}`); }
async function runCli(runner, args) {
  const cli = join(runner, 'scripts/protocol-package.mjs');
  const oldArgv = process.argv, oldExit = process.exitCode, logs = [], errors = [];
  process.argv = [process.execPath, cli, ...args];
  process.exitCode = 0;
  const oldLog = console.log, oldError = console.error;
  console.log = (...values) => logs.push(values.join(' '));
  console.error = (...values) => errors.push(values.join(' '));
  try { await importFresh(cli); return { code: process.exitCode, logs, errors }; }
  finally { process.argv = oldArgv; process.exitCode = oldExit; console.log = oldLog; console.error = oldError; }
}
try {
  const runner = join(scratch, 'runner');
  const exporter = join(root, 'scripts/export-protocol-runner.mjs');
  const priorArgv = process.argv;
  process.argv = [process.execPath, exporter, '--out', runner];
  try { await importFresh(exporter); } finally { process.argv = priorArgv; }
  const runnerModules = ['protocol-package.js','protocol-package-closure.js','protocol-compiler.js','workspace-contract.js','workspace-interpreter.js','workspace-admin.js','errors.js','json.js'];
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const file of runnerModules) assert.equal(hash(await readFile(join(runner, 'dist-workspace/src', file))), hash(await readFile(join(root, 'runner-core/dist-workspace/src', file))), `exported runtime changed: ${file}`);
  assert.deepEqual(await readFile(join(runner, 'scripts/protocol-package.mjs')), await readFile(join(root, 'scripts/protocol-package.mjs')));
  assert.deepEqual(await readFile(join(runner, 'LICENSE')), await readFile(join(root, 'runner-core/LICENSE')));
  assert.deepEqual(await readFile(join(runner, 'PORTABLE-CORE-NOTICE.md')), await readFile(join(root, 'runner-core/PORTABLE-CORE-NOTICE.md')));
  async function javascriptFiles(directory, base = directory, output = new Map()) { for (const entry of await readdir(directory, { withFileTypes: true })) { const full = join(directory, entry.name); if (entry.isDirectory()) await javascriptFiles(full, base, output); else if (entry.isFile() && entry.name.endsWith('.js')) output.set(full.slice(base.length + 1).split('\\').join('/'), hash(await readFile(full))); } return output; }
  const expectedZod = await javascriptFiles(join(root, 'runner-core/node_modules/zod/v4'));
  const exportedZod = await javascriptFiles(join(runner, 'node_modules/zod/v4'));
  assert.deepEqual([...exportedZod].sort(), [...expectedZod].sort(), 'exported Zod runtime differs from its pinned source');
  const { parseProtocolPackage } = await import(pathToFileURL(join(runner, 'dist-workspace/src/protocol-package.js')).href);
  const { compileProtocolPackage } = await import(pathToFileURL(join(runner, 'dist-workspace/src/protocol-compiler.js')).href);
  const closureApi = await import(pathToFileURL(join(runner, 'dist-workspace/src/protocol-package-closure.js')).href);
  const dirs = (await readdir(join(root, 'protocols'), { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name).sort();
  const packages = [];
  for (const dir of dirs) {
    const base = join(root, 'protocols', dir), files = Object.create(null);
    async function walk(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const absolute = join(path, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`symlink in package ${absolute}`);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) files[absolute.slice(base.length + 1).split('\\').join('/')] = await readFile(absolute, 'utf8');
        else throw new Error(`non-regular file in package ${absolute}`);
      }
    }
    await walk(base);
    packages.push({ dir, base, pkg: parseProtocolPackage({ format: 'peerwork.protocol-package.v1', files }), metadata: JSON.parse(files['package.json']), source: JSON.parse(files['protocol.source.json']) });
  }
  assert.equal(packages.length, 14, 'official package inventory changed; review the inventory before updating this assertion');
  const byDigest = new Map(packages.map(x => [x.pkg.packageDigest, x]));
  const rows = [];
  for (const entry of packages) {
    const dependencies = new Map();
    const visit = pkg => {
      for (const ref of pkg.source.imports) {
        const found = byDigest.get(ref.package_digest);
        assert.ok(found, `${entry.metadata.package_id} missing exact dependency ${ref.package_digest}`);
        if (found.pkg.packageDigest === entry.pkg.packageDigest || dependencies.has(found.pkg.packageDigest)) continue;
        dependencies.set(found.pkg.packageDigest, found.pkg); visit(found.pkg);
      }
    };
    visit(entry.pkg);
    const closure = closureApi.createProtocolPackageClosure(entry.pkg, [...dependencies.values()]);
    const parsed = closureApi.parseProtocolPackageClosureBytes(closureApi.canonicalProtocolPackageClosureBytes(closure));
    const result = compileProtocolPackage(parsed.rootPackage, { loadExactPackage: closureApi.exactPackageLoader(parsed) });
    assert.equal(result.validation.passed, true, `${entry.metadata.package_id} validation failed`);
    assert.equal(result.passed, true, `${entry.metadata.package_id} fixtures failed`);
    rows.push({ package_id: entry.metadata.package_id, version: entry.metadata.version, name: entry.metadata.name, digest: entry.pkg.packageDigest,
      dependencies: entry.source.imports.map(x => x.package_digest).sort(), roles: entry.source.manifest.protocol_roles, capabilities: entry.source.manifest.capabilities,
      actions: entry.source.manifest.actions.map(x => x.id), task_description: entry.metadata.description, source_path: `protocols/${entry.dir}`,
      fixtures: result.fixtureResults.map(x => ({ id: x.id, passed: x.passed })) });
  }
  rows.sort((a,b) => a.package_id.localeCompare(b.package_id));
  const expectedCatalog = JSON.stringify({ format: 'peerwork.protocol-catalog.v1', source_commit: 'b26ef91459c1b04fbf52d243ecbf83f17352fd30', package_count: 14, packages: rows }, null, 2) + '\n';
  const build = await importFresh(join(root, 'scripts/build-catalog.mjs'));
  void build;
  const catalogText = await readFile(join(root, 'protocol-catalog.json'), 'utf8');
  assert.equal(catalogText, expectedCatalog, 'catalog differs from package source and runner output');
  const proposal = packages.find(x => x.metadata.package_id === 'peerwork-proposal-adoption');
  const result = compileProtocolPackage(proposal.pkg, {});
  const selfAdoption = result.fixtureResults.find(x => x.id === 'author-cannot-adopt-own-candidate');
  assert.equal(selfAdoption?.passed, true);
  assert.deepEqual(selfAdoption?.observed, { accepted: false, code: 'CONSTRAINT_FAILED' });
  const task = packages.find(x => x.metadata.package_id === 'peerwork-tasks-proposal-adoption');
  const taskDeps = new Map();
  for (const ref of task.pkg.source.imports) taskDeps.set(ref.package_digest, byDigest.get(ref.package_digest).pkg);
  const taskClosure = closureApi.createProtocolPackageClosure(task.pkg, [...taskDeps.values()]);
  const envelope = structuredClone(taskClosure);
  const encoded = envelope.packages[task.pkg.packageDigest];
  envelope.packages[task.pkg.packageDigest] = `${encoded[0] === 'A' ? 'B' : 'A'}${encoded.slice(1)}`;
  const damagedBytes = new TextEncoder().encode(JSON.stringify(envelope));
  assert.throws(() => closureApi.parseProtocolPackageClosureBytes(damagedBytes), /digest|canonical|package/i, 'altered package bytes unexpectedly passed digest validation');
  const damagedPath = join(scratch, 'corrupt-digest.json');
  await writeFile(damagedPath, damagedBytes);
  const cliNegative = await runCli(runner, ['closure-test', damagedPath]);
  assert.equal(cliNegative.code, 1, 'CLI accepted altered canonical package bytes');
  assert.match(cliNegative.errors.join(' '), /digest|canonical|package/i);
  const cliRunner = runner;
  for (const [pkg, deps] of [
    ['proposal-adoption', []],
    ['wiki-review-composition', ['wiki-draft-component', 'wiki-review-component']],
    ['tasks-proposal-adoption', ['proposal-adoption-component', 'tasks-proposal-component']]
  ]) {
    const args = ['test', join(root, 'protocols', pkg)];
    for (const dep of deps) args.push('--dependency', join(root, 'protocols', dep));
    const output = await runCli(cliRunner, args);
    assert.equal(output.code, 0, `runnable example failed: ${pkg}: ${output.errors.join(' ')}`);
    const cliResult = JSON.parse(output.logs.at(-1));
    assert.equal(cliResult.passed, true, `runnable example fixture failure: ${pkg}`);
    if (pkg === 'proposal-adoption') { const denial = cliResult.fixtures.find(f => f.id === 'author-cannot-adopt-own-candidate'); assert.deepEqual(denial?.observed, { accepted: false, code: 'CONSTRAINT_FAILED' }); }
    const doc = await readFile(join(root, 'examples', pkg === 'wiki-review-composition' ? 'wiki-review.md' : pkg === 'tasks-proposal-adoption' ? 'task-proposal-adoption.md' : `${pkg}.md`), 'utf8');
    assert.match(doc, /node \/tmp\/peerwork-protocol-runner\/scripts\/protocol-package\.mjs test/);
  }
  for (const file of ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/hosted-adoption-status.md', 'examples/proposal-adoption.md', 'examples/wiki-review.md', 'examples/task-proposal-adoption.md', ...packages.map(x => `protocols/${x.dir}/README.md`)]) {
    const body = await readFile(join(root, file), 'utf8');
    for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^(https?:|#|mailto:)/.test(target)) continue;
      const clean = target.split('#')[0];
      if (clean) await readFile(resolve(dirname(join(root, file)), clean));
    }
  }
  const sensitive = ['-----BEGIN PRIVATE KEY-----', 'PRIVATE_KEY=', 'PEERWORK_CONTROL_TOKEN=', 'DATABASE_URL='];
  for (const packageEntry of packages) for (const path of await readdir(packageEntry.base)) {
    const body = await readFile(join(packageEntry.base, path), 'utf8').catch(() => '');
    for (const marker of sensitive) assert.ok(!body.includes(marker), `sensitive marker ${marker} in ${path}`);
  }
  const provScript = join(root, 'scripts/provenance.mjs');
  const argvBeforeProvenance = process.argv;
  process.argv = [process.execPath, provScript, 'verify'];
  try { await importFresh(provScript); } finally { process.argv = argvBeforeProvenance; }
  console.log(JSON.stringify({ result: 'PASS', packageCount: packages.length, packageClosuresVerified: packages.length, negativeCases: ['altered canonical digest rejected', 'same-author adoption denied by role constraint'], portableRunnerExported: true, commandExamples: 3, docsLinks: 'resolved' }));
} finally { await rm(scratch, { recursive: true, force: true }); }
