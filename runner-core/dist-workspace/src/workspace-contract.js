import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './errors.js';
import { guardSchema, interpreterManifestSchema, validateResolvedManifest } from './workspace-interpreter.js';
export const CONTROL_APPLICATION_ID = 0x50574b31;
export const PUBLIC_APPLICATION_ID = 0x50575031;
export const CONTROL_DATABASE_VERSION = 9;
export const PUBLIC_DATABASE_VERSION = 1;
export const SEMANTICS = 'peerwork.kernel.v1';
export const COMMAND_TYPE = 'peerwork.kernel-command.v1+jws';
export const RECEIPT_TYPE = 'peerwork.kernel-receipt.v1+jws';
export const READ_TYPE = 'peerwork.kernel-read.v1+jws';
export const limits = Object.freeze({
    outerBytes: 262144, jwsBytes: 250000, payloadBytes: 180000, headerBytes: 256,
    manifestBytes: 65536, actionBytes: 16384, recordBytes: 16384, stateBytes: 65536,
    dependencies: 16, actions: 64, nodes: 2048, depth: 12, guards: 32, refs: 32, effects: 16,
    producedRecords: 8, stringBytes: 8192, listItems: 128, protocols: 128,
    instancesPerWorkspace: 10000, instancesGlobal: 100000, grantsPerInstance: 128,
    objectsPerWorkspace: 50000, objectsGlobal: 1000000, bytesPerWorkspace: 10 * 1024 * 1024,
    bytesGlobal: 1024 * 1024 * 1024, workspacesPerActor: 64, workspacesGlobal: 10000,
    commandsPerMinute: 120,
    catalogPackageBytes: 1024 * 1024, catalogChunkBytes: 64 * 1024, catalogActorStagedBytes: 2 * 1024 * 1024, catalogGlobalStagedBytes: 16 * 1024 * 1024, catalogActorActiveUploads: 2, catalogUploadTtlMs: 600000,
    protocolRoles: 32, capabilities: 64, roleConflicts: 32,
    admissionRows: 20000, admissionBytes: 20000 * (256 + 71 + 16),
    readNonceRows: 20000, readNonceBytes: 20000 * (256 + 43 + 64 + 43 + 8),
    filesystemHeadroomBytes: 16 * 1024 * 1024,
});
export const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const jsonValue = z.lazy(() => z.union([
    z.null(), z.boolean(), z.number().int(), z.string().refine(v => Buffer.byteLength(v) <= limits.stringBytes),
    z.array(jsonValue).max(limits.listItems), z.record(z.string(), jsonValue),
]));
export const exactRef = z.object({ record_id: token, revision: z.number().int().positive() }).strict();
export const commandSchema = z.object({
    v: z.literal(1), audience: z.string().min(1).max(200), command_id: token, actor_id: token, authority: digest,
    method: z.literal('POST'), path: z.string().regex(/^\/api\/workspace\/v1\/(?:commands|catalog\/upload|private\/packages\/upload|browser\/sessions\/[A-Za-z0-9_-]{43}\/commands)$/),
    workspace_id: token.nullable(), instance_id: token.nullable(), protocol_digest: digest.nullable(),
    action_id: z.string().min(1).max(120), expected_workspace_revision: z.number().int().nonnegative().nullable(), expected_instance_revision: z.number().int().nonnegative().nullable(),
    exact_input_refs: z.array(exactRef).max(limits.refs), body: jsonValue,
    issued_at: z.number().int().nonnegative(), expires_at: z.number().int().positive(),
}).strict().superRefine((value, ctx) => { try {
    if (['protocol.publish', 'admin.draft.create', 'admin.draft.update', 'protocol.package.derive.preview'].includes(value.action_id))
        normalized(value.body, 0, { n: 0 }, 32);
    else
        canonical(value.body);
}
catch {
    ctx.addIssue({ code: 'custom', message: 'invalid body bounds' });
} });
const pathSegment = z.string().min(1).max(80).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v));
const operand = z.union([
    z.object({ source: z.literal('state'), path: z.array(pathSegment).min(1).max(limits.depth) }).strict(),
    z.object({ source: z.literal('body'), path: z.array(pathSegment).max(limits.depth) }).strict(),
    z.object({ source: z.literal('literal'), value: jsonValue }).strict(),
]);
const guard = z.lazy(() => z.union([
    z.object({ op: z.literal('eq'), left: operand, right: operand }).strict(),
    z.object({ op: z.literal('in'), value: operand, set: z.array(jsonValue).max(limits.listItems) }).strict(),
    z.object({ op: z.literal('state_eq'), path: z.array(pathSegment).min(1).max(limits.depth), value: jsonValue }).strict(),
    z.object({ op: z.literal('exact_ref'), record_id: token, revision: z.number().int().positive() }).strict(),
    z.object({ op: z.enum(['and', 'or']), rules: z.array(guard).min(1).max(limits.guards) }).strict(),
    z.object({ op: z.literal('not'), rule: guard }).strict(),
]));
const effect = z.union([
    z.object({ op: z.literal('set'), path: z.array(pathSegment).min(1).max(limits.depth), value: operand }).strict(),
    z.object({ op: z.literal('append'), schema: z.string().min(1).max(80), value: operand }).strict(),
]);
const bindingName = z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/);
const executionRequirementsSchema = z.object({ format: z.literal('peerwork.protocol-execution-requirements.v1'), closure_complete: z.boolean(), ports: z.array(z.object({ import_path: z.array(bindingName).max(limits.dependencies), action_id: z.string().min(1).max(120), variant: z.number().int().nonnegative().max(31), input_name: bindingName, type: z.enum(['exact_ref', 'actor_id']), required: z.boolean(), bound: z.boolean() }).strict()).max(512) }).strict();
export const manifestSchema = z.object({
    name: z.string().min(1).max(120), display_version: z.string().min(1).max(40), semantics: z.literal(SEMANTICS),
    dependencies: z.array(digest).max(limits.dependencies).refine(v => new Set(v).size === v.length),
    protocol_roles: z.array(bindingName).max(limits.protocolRoles).refine(v => new Set(v).size === v.length).default([]),
    capabilities: z.array(bindingName).max(limits.capabilities).refine(v => new Set(v).size === v.length).default([]),
    role_conflicts: z.array(z.tuple([bindingName, bindingName])).max(limits.roleConflicts).default([]),
    historical_role_conflicts: z.array(z.tuple([bindingName, bindingName])).max(limits.roleConflicts).default([]),
    constraints: z.record(z.string().min(1).max(120), z.array(guardSchema).min(1).max(limits.guards)).default({}),
    record_schemas: z.record(z.string().min(1).max(80), z.object({ type: z.literal('object'), fields: z.record(z.string().min(1).max(80), z.enum(['string', 'integer', 'boolean', 'null', 'json'])), required: z.array(z.string().min(1).max(80)).max(64), max_bytes: z.number().int().positive().max(limits.recordBytes) }).strict().superRefine((v, ctx) => { for (const name of v.required)
        if (!Object.hasOwn(v.fields, name))
            ctx.addIssue({ code: 'custom', message: 'unknown required field' }); })),
    initial_state: jsonValue,
    actions: interpreterManifestSchema.shape.actions,
    execution_requirements: executionRequirementsSchema.optional(),
}).strict().superRefine((v, ctx) => {
    const ids = v.actions.map(a => a.id);
    if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: 'custom', message: 'duplicate action' });
    const roles = new Set(v.protocol_roles);
    for (const conflicts of [v.role_conflicts, v.historical_role_conflicts]) {
        const pairs = new Set();
        for (const [a, b] of conflicts) {
            if (a === b || !roles.has(a) || !roles.has(b))
                ctx.addIssue({ code: 'custom', message: 'invalid role conflict' });
            const key = [a, b].sort().join('\0');
            if (pairs.has(key))
                ctx.addIssue({ code: 'custom', message: 'duplicate role conflict' });
            pairs.add(key);
        }
    }
    for (const a of v.actions)
        for (const variant of a.variants)
            for (const e of variant.effects)
                if (e.op === 'append' && !Object.hasOwn(v.record_schemas, e.schema))
                    ctx.addIssue({ code: 'custom', message: 'unknown append schema' });
});
function normalized(value, depth = 0, nodes = { n: 0 }, maxDepth = limits.depth) {
    if (++nodes.n > limits.nodes || depth > maxDepth)
        throw new ApiError('INVALID_PAYLOAD', 400);
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return value;
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value))
            throw new ApiError('INVALID_PAYLOAD', 400);
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > limits.listItems)
            throw new ApiError('INVALID_PAYLOAD', 400);
        return value.map(v => normalized(v, depth + 1, nodes, maxDepth));
    }
    if (typeof value === 'object') {
        const result = {};
        for (const key of Object.keys(value).sort()) {
            if (!key || ['__proto__', 'prototype', 'constructor'].includes(key))
                throw new ApiError('INVALID_PAYLOAD', 400);
            result[key] = normalized(value[key], depth + 1, nodes, maxDepth);
        }
        return result;
    }
    throw new ApiError('INVALID_PAYLOAD', 400);
}
export function canonical(value) { return JSON.stringify(normalized(value)); }
// A signed command result is validated and hashed at the ordinary depth limit.
// Its persisted receipt envelope adds exactly one structural level.
export function canonicalResponse(value) { return JSON.stringify(normalized(value, 0, { n: 0 }, limits.depth + 1)); }
export function canonicalCommand(value) { return JSON.stringify(normalized(value, 0, { n: 0 }, 40)); }
export function canonicalStructured(value) { return JSON.stringify(normalized(value, 0, { n: 0 }, 32)); }
export function hash(value) { return createHash('sha256').update(value).digest('hex'); }
export function manifestDigest(value) {
    const parsed = manifestSchema.parse(value);
    canonical(parsed.initial_state);
    validateResolvedManifest({ actions: parsed.actions });
    const encoded = JSON.stringify(normalized({ semantics: SEMANTICS, manifest: parsed }, 0, { n: 0 }, 32));
    if (Buffer.byteLength(encoded) > limits.manifestBytes)
        throw new ApiError('RESOURCE_EXHAUSTED', 429);
    return { manifest: parsed, canonical: encoded, digest: hash(encoded) };
}
export function assertSized(value, max, code = 'RESOURCE_EXHAUSTED') {
    const encoded = canonical(value);
    if (Buffer.byteLength(encoded) > max)
        throw new ApiError(code, code === 'INVALID_PAYLOAD' ? 400 : 429);
    return encoded;
}
