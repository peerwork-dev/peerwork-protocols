#!/usr/bin/env node
import {protocolDirectories} from './protocol-directories.mjs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProtocolPackage } from '../runner-core/dist-workspace/src/protocol-package.js';
import { compileProtocolPackage } from '../runner-core/dist-workspace/src/protocol-compiler.js';
import { createProtocolPackageClosure, exactPackageLoader, parseProtocolPackageClosureBytes, canonicalProtocolPackageClosureBytes } from '../runner-core/dist-workspace/src/protocol-package-closure.js';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dirs = await protocolDirectories(root);
const packages = [];
for (const dir of dirs) {
  const base = join(root, 'protocols', dir), files = Object.create(null);
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink in official package ${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files[absolute.slice(base.length + 1).split('\\').join('/')] = await readFile(absolute, 'utf8');
      else throw new Error(`non-regular file in official package ${absolute}`);
    }
  }
  await walk(base);
  const pkg = parseProtocolPackage({ format: 'peerwork.protocol-package.v1', files });
  const metadata = JSON.parse(files['package.json']);
  const source = JSON.parse(files['protocol.source.json']);
  packages.push({ dir, base, pkg, metadata, source });
}
const byDigest = new Map(packages.map(x => [x.pkg.packageDigest, x.pkg]));
const rows = [];
for (const entry of packages) {
  const closurePackages = new Map();
  const visit = (pkg) => {
    for (const dependency of pkg.source.imports) {
      const found = byDigest.get(dependency.package_digest);
      if (!found) throw new Error(`${entry.metadata.package_id}: missing exact package dependency ${dependency.package_digest}`);
      if (found.packageDigest === entry.pkg.packageDigest || closurePackages.has(found.packageDigest)) continue;
      closurePackages.set(found.packageDigest, found); visit(found);
    }
  };
  visit(entry.pkg);
  const closure = createProtocolPackageClosure(entry.pkg, [...closurePackages.values()]);
  const parsed = parseProtocolPackageClosureBytes(canonicalProtocolPackageClosureBytes(closure));
  const result = compileProtocolPackage(parsed.rootPackage, { loadExactPackage: exactPackageLoader(parsed) });
  if (!result.validation.passed || !result.passed) throw new Error(`${entry.metadata.package_id}: validation or fixture failure`);
  rows.push({
    package_id: entry.metadata.package_id,
    version: entry.metadata.version,
    name: entry.metadata.name,
    digest: entry.pkg.packageDigest,
    dependencies: entry.source.imports.map(x => x.package_digest).sort(),
    roles: entry.source.manifest.protocol_roles,
    capabilities: entry.source.manifest.capabilities,
    actions: entry.source.manifest.actions.map(x => x.id),
    task_description: entry.metadata.description,
    source_path: `protocols/${entry.dir}`,
    fixtures: result.fixtureResults.map(x => ({ id: x.id, passed: x.passed }))
  });
}
rows.sort((a,b) => a.package_id.localeCompare(b.package_id));
const catalog = { format: 'peerwork.protocol-catalog.v1', source_commit: 'b26ef91459c1b04fbf52d243ecbf83f17352fd30', package_count: rows.length, packages: rows };
await writeFile(join(root, 'protocol-catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(JSON.stringify({ catalog: 'protocol-catalog.json', packages: rows.length, allFixtureSetsPassed: rows.every(x => x.fixtures.every(f => f.passed)) }));
