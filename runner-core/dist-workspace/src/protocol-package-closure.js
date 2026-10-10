import { TextDecoder } from 'node:util';
import { parseJson } from './json.js';
import { hash } from './workspace-contract.js';
import { canonicalProtocolPackageBytes, parseProtocolPackage, parseProtocolPackageBytes } from './protocol-package.js';
export const PROTOCOL_PACKAGE_CLOSURE_FORMAT = 'peerwork.protocol-package-closure.v1';
export const protocolPackageClosureLimits = Object.freeze({ entries: 16, rawBytes: 4 * 1024 * 1024, wireBytes: 6 * 1024 * 1024, depth: 16, compileSteps: 128 });
const digestPattern = /^[a-f0-9]{64}$/;
function fail(message) { throw new Error(`INVALID_PROTOCOL_PACKAGE_CLOSURE: ${message}`); }
function canonicalObject(closure) { const packages = Object.fromEntries(Object.entries(closure.packages).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)); return { format: PROTOCOL_PACKAGE_CLOSURE_FORMAT, packages, root_package_digest: closure.root_package_digest }; }
function encodeBase64url(bytes) { return Buffer.from(bytes).toString('base64url'); }
function decodeBase64url(value) { if (!/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/.test(value))
    fail('package bytes are not canonical base64url'); const bytes = Buffer.from(value, 'base64url'); if (encodeBase64url(bytes) !== value)
    fail('package bytes are not canonical base64url'); return new Uint8Array(bytes); }
function packageValue(value) { if (value && typeof value === 'object' && Object.hasOwn(value, 'bundle')) {
    const parsed = parseProtocolPackage(value.bundle);
    if (parsed.packageDigest !== value.packageDigest)
        return fail('parsed package digest mismatch');
    return parsed;
} return parseProtocolPackage(value); }
function assertEnvelope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return fail('invalid closure envelope');
    const obj = value;
    if (Object.keys(obj).sort().join(',') !== 'format,packages,root_package_digest' || obj.format !== PROTOCOL_PACKAGE_CLOSURE_FORMAT || typeof obj.root_package_digest !== 'string' || !digestPattern.test(obj.root_package_digest) || !obj.packages || typeof obj.packages !== 'object' || Array.isArray(obj.packages))
        return fail('invalid closure envelope');
    const packages = obj.packages, entries = Object.entries(packages);
    if (entries.length === 0 || entries.length > protocolPackageClosureLimits.entries)
        return fail('closure package count out of bounds');
    for (const [digest, value] of entries)
        if (!digestPattern.test(digest) || typeof value !== 'string')
            return fail('invalid package map entry');
    if (!Object.hasOwn(packages, obj.root_package_digest))
        return fail('root package is missing');
    return { format: PROTOCOL_PACKAGE_CLOSURE_FORMAT, root_package_digest: obj.root_package_digest, packages: packages };
}
function validateClosure(closureValue) {
    const closure = assertEnvelope(closureValue), packages = new Map();
    let rawBytes = 0, steps = 0;
    for (const [expectedDigest, encoded] of Object.entries(closure.packages)) {
        const bytes = decodeBase64url(encoded);
        rawBytes += bytes.byteLength;
        if (bytes.byteLength > 1024 * 1024 || rawBytes > protocolPackageClosureLimits.rawBytes)
            return fail('raw package closure byte limit exceeded');
        let parsed;
        try {
            parsed = parseProtocolPackageBytes(bytes);
        }
        catch {
            return fail('contained package is invalid or noncanonical');
        }
        if (parsed.packageDigest !== expectedDigest)
            return fail('package map digest does not match canonical package bytes');
        packages.set(expectedDigest, parsed);
    }
    const visited = new Set(), active = new Set();
    const visit = (digest, depth) => { if (depth > protocolPackageClosureLimits.depth)
        return fail('dependency depth exceeded'); if (active.has(digest))
        return fail('dependency cycle'); if (visited.has(digest))
        return; if (++steps > protocolPackageClosureLimits.compileSteps)
        return fail('closure compile step limit exceeded'); const pkg = packages.get(digest); if (!pkg)
        return fail(`missing exact package dependency ${digest}`); active.add(digest); for (const dependency of pkg.source.imports)
        visit(dependency.package_digest, depth + 1); active.delete(digest); visited.add(digest); };
    visit(closure.root_package_digest, 0);
    if (visited.size !== packages.size)
        return fail('closure contains unreferenced packages');
    return { closure, rootPackage: packages.get(closure.root_package_digest), packages, rawBytes };
}
export function canonicalProtocolPackageClosureBytes(value) {
    const closure = assertEnvelope(value), bytes = Buffer.from(JSON.stringify(canonicalObject(closure)), 'utf8');
    if (bytes.byteLength > protocolPackageClosureLimits.wireBytes)
        return fail('closure wire byte limit exceeded');
    validateClosure(closure);
    return new Uint8Array(bytes);
}
export function parseProtocolPackageClosureBytes(bytes) {
    if (bytes.byteLength > protocolPackageClosureLimits.wireBytes)
        return fail('closure wire byte limit exceeded');
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return fail('invalid UTF-8 closure');
    }
    let parsed;
    try {
        parsed = parseJson(text);
    }
    catch {
        return fail('invalid or duplicate-key JSON closure');
    }
    const result = validateClosure(parsed);
    const canonical = Buffer.from(JSON.stringify(canonicalObject(result.closure)), 'utf8');
    if (!canonical.equals(Buffer.from(bytes)))
        return fail('closure bytes are not canonical');
    return result;
}
export function digestProtocolPackageClosure(value) { return hash(canonicalProtocolPackageClosureBytes(value)); }
export function createProtocolPackageClosure(rootValue, dependencyValues) {
    const root = packageValue(rootValue), packages = new Map([[root.packageDigest, root]]);
    for (const value of dependencyValues) {
        const pkg = packageValue(value);
        if (packages.has(pkg.packageDigest))
            return fail('duplicate package digest');
        packages.set(pkg.packageDigest, pkg);
    }
    const encoded = Object.create(null);
    for (const [digest, pkg] of packages)
        encoded[digest] = encodeBase64url(canonicalProtocolPackageBytes(pkg));
    const closure = { format: PROTOCOL_PACKAGE_CLOSURE_FORMAT, root_package_digest: root.packageDigest, packages: encoded };
    validateClosure(closure);
    return closure;
}
export function exactPackageLoader(closure) { const parsed = 'rootPackage' in closure ? closure : validateClosure(closure); return (digest) => parsed.packages.get(digest); }
export function packageClosureDigest(value) { return packageValue(value).packageDigest; }
