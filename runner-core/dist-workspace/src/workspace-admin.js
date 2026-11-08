import { z } from 'zod';
import { ApiError } from './errors.js';
import { canonicalStructured, hash, manifestDigest, manifestSchema, token } from './workspace-contract.js';
import { evaluateAction, validateResolvedManifest } from './workspace-interpreter.js';
const MAX_DEPENDENCIES = 16, MAX_EXAMPLES = 64;
const authSchema = z.object({ actorId: token, workspaceRoles: z.array(z.string()).max(64).default([]), protocolRoles: z.array(z.string()).max(64).default([]), capabilities: z.array(z.string()).max(64).default([]) }).strict();
const inputSchema = z.object({ recordId: token, revision: z.number().int().positive(), schema: z.string().min(1).max(80), payload: z.unknown(), scope: z.enum(['INSTANCE', 'WORKSPACE']), entityId: token.optional() }).strict();
export const protocolExampleSchema = z.object({ id: z.string().min(1).max(80), action_id: z.string().min(1).max(120), state: z.unknown(), body: z.unknown(), auth: authSchema, exact_inputs: z.array(inputSchema).max(32).default([]), time_ms: z.number().int().nonnegative().safe().optional(), expected: z.union([z.object({ accepted: z.literal(true), state: z.unknown().optional(), evaluated_at: z.number().int().nonnegative().safe().optional() }).strict(), z.object({ accepted: z.literal(false), code: z.string().min(1).max(80) }).strict()]) }).strict();
export const protocolExamplesSchema = z.array(protocolExampleSchema).max(MAX_EXAMPLES).refine(v => new Set(v.map(x => x.id)).size === v.length);
function fail(code = 'INVALID_PAYLOAD', status = 400) { throw new ApiError(code, status); }
function objectState(value) { if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('COMPOSITION_CONFLICT', 409); return value; }
function same(a, b) { return canonicalStructured(a) === canonicalStructured(b); }
export function resolveProtocol(rootValue, load) {
    const root = manifestSchema.parse(rootValue), sourceDigest = manifestDigest(root).digest, ordered = [], closure = [], active = new Set(), done = new Set();
    const visit = (digest, depth) => { if (depth > MAX_DEPENDENCIES || closure.length >= MAX_DEPENDENCIES)
        fail('RESOURCE_EXHAUSTED', 429); if (active.has(digest))
        fail('DEPENDENCY_CYCLE', 409); if (done.has(digest))
        return; const value = load(digest); if (value === undefined)
        fail('DEPENDENCY_MISSING', 409); const manifest = manifestSchema.parse(value), actual = manifestDigest(manifest).digest; if (actual !== digest)
        fail('DEPENDENCY_MISMATCH', 409); active.add(digest); for (const child of [...manifest.dependencies].sort())
        visit(child, depth + 1); active.delete(digest); done.add(digest); closure.push(digest); ordered.push(manifest); };
    for (const digest of [...root.dependencies].sort())
        visit(digest, 1);
    ordered.push(root);
    const schemas = {}, actions = new Map(), roles = new Set(), capabilities = new Set(), conflicts = new Map(), historicalConflicts = new Map(), state = {}, constraints = new Map();
    for (const manifest of ordered) {
        for (const [name, schema] of Object.entries(manifest.record_schemas)) {
            if (schemas[name] && !same(schemas[name], schema))
                fail('COMPOSITION_CONFLICT', 409);
            schemas[name] = schema;
        }
        for (const action of manifest.actions) {
            if (actions.has(action.id))
                fail('REDUCER_CONFLICT', 409);
            actions.set(action.id, action);
        }
        for (const role of manifest.protocol_roles)
            roles.add(role);
        for (const capability of manifest.capabilities)
            capabilities.add(capability);
        for (const pair of manifest.role_conflicts) {
            const sorted = [...pair].sort();
            conflicts.set(sorted.join('\0'), sorted);
        }
        for (const pair of manifest.historical_role_conflicts) {
            const sorted = [...pair].sort();
            historicalConflicts.set(sorted.join('\0'), sorted);
        }
        for (const [key, value] of Object.entries(objectState(manifest.initial_state))) {
            if (Object.hasOwn(state, key) && !same(state[key], value))
                fail('COMPOSITION_CONFLICT', 409);
            state[key] = value;
        }
        for (const [id, rules] of Object.entries(manifest.constraints)) {
            const list = constraints.get(id) ?? [];
            list.push(...rules);
            constraints.set(id, list);
        }
    }
    const unresolved = [...constraints.keys()].filter(id => !actions.has(id));
    if (unresolved.length && actions.size > 0)
        fail('COMPOSITION_CONFLICT', 409);
    const resolvedActions = [...actions.values()].sort((a, b) => a.id.localeCompare(b.id)).map(action => { const extra = constraints.get(action.id) ?? []; return extra.length ? { ...action, variants: action.variants.map(variant => ({ ...variant, when: [...extra, ...variant.when] })) } : action; });
    const retainedConstraints = actions.size ? {} : Object.fromEntries([...constraints.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const requirementSources = [...ordered, root].filter(item => item.execution_requirements), executionRequirements = root.execution_requirements?.closure_complete ? root.execution_requirements : requirementSources.length ? { format: 'peerwork.protocol-execution-requirements.v1', closure_complete: true, ports: requirementSources.flatMap(item => item.execution_requirements?.ports ?? []) } : undefined;
    const manifest = manifestSchema.parse({ name: root.name, display_version: root.display_version, semantics: root.semantics, dependencies: [...closure], protocol_roles: [...roles].sort(), capabilities: [...capabilities].sort(), role_conflicts: [...conflicts.values()].sort((a, b) => a.join().localeCompare(b.join())), historical_role_conflicts: [...historicalConflicts.values()].sort((a, b) => a.join().localeCompare(b.join())), constraints: retainedConstraints, record_schemas: schemas, initial_state: state, actions: resolvedActions, ...(executionRequirements ? { execution_requirements: executionRequirements } : {}) });
    validateResolvedManifest({ actions: manifest.actions });
    for (const port of manifest.execution_requirements?.ports ?? []) {
        const action = manifest.actions.find(item => item.id === port.action_id);
        if (!action || !action.variants[port.variant])
            fail('COMPOSITION_CONFLICT', 409);
    }
    const resolvedDigest = manifestDigest(manifest).digest;
    return { sourceDigest, sourceManifest: root, resolvedDigest, dependencyClosure: closure, manifest };
}
export function runProtocolExamples(manifest, value) { const examples = protocolExamplesSchema.parse(value), results = []; for (const example of examples) {
    let observed;
    try {
        const output = evaluateAction({ manifest: { actions: manifest.actions }, actionId: example.action_id, state: example.state, body: example.body, auth: example.auth, exactInputs: example.exact_inputs, executionTimeMs: example.time_ms });
        observed = { accepted: true, state: output.nextState, ...output.evaluatedAt !== undefined ? { evaluated_at: output.evaluatedAt } : {} };
    }
    catch (error) {
        observed = { accepted: false, code: error instanceof ApiError ? error.code : 'INVALID_PAYLOAD' };
    }
    const expected = example.expected, passed = expected.accepted ? observed.accepted === true && (typeof expected.state === 'undefined' || same(expected.state, observed.state)) && (typeof expected.evaluated_at === 'undefined' || expected.evaluated_at === observed.evaluated_at) : observed.accepted === false && observed.code === expected.code;
    results.push({ id: example.id, passed, expected, observed });
} return { passed: results.every(result => result.passed), results }; }
export function protocolDiff(base, next, affected) { const before = new Map((base?.actions ?? []).map(action => [action.id, action])), after = new Map(next.actions.map(action => [action.id, action])), ids = [...new Set([...before.keys(), ...after.keys()])].sort(), beforeConstraints = new Map(Object.entries(base?.constraints ?? {})), afterConstraints = new Map(Object.entries(next.constraints)), constraintIds = [...new Set([...beforeConstraints.keys(), ...afterConstraints.keys()])].sort(); return { actions: { added: ids.filter(id => !before.has(id)), removed: ids.filter(id => !after.has(id)), changed: ids.filter(id => before.has(id) && after.has(id) && !same(before.get(id), after.get(id))) }, constraints: { added: constraintIds.filter(id => !beforeConstraints.has(id)), removed: constraintIds.filter(id => !afterConstraints.has(id)), changed: constraintIds.filter(id => beforeConstraints.has(id) && afterConstraints.has(id) && !same(beforeConstraints.get(id), afterConstraints.get(id))) }, roles: { before: base?.protocol_roles ?? [], after: next.protocol_roles }, capabilities: { before: base?.capabilities ?? [], after: next.capabilities }, affected_pinned_instances: [...affected.instance_ids].sort(), approval_refs: [...affected.approval_refs].sort((a, b) => `${a.record_id}:${a.revision}`.localeCompare(`${b.record_id}:${b.revision}`)) }; }
export function validateProtocolDraft(input) { const resolved = resolveProtocol(input.manifest, input.load), examples = runProtocolExamples(resolved.manifest, input.examples), diff = protocolDiff(input.base, resolved.manifest, input.affected ?? { instance_ids: [], approval_refs: [] }), report = { base_protocol_digest: input.baseProtocolDigest ?? null, source_digest: resolved.sourceDigest, resolved_digest: resolved.resolvedDigest, dependency_closure: resolved.dependencyClosure, examples, diff }; if (!examples.passed)
    fail('EXAMPLE_FAILED', 409); return { ...resolved, examples, diff, validationDigest: hash(canonicalStructured(report)), report }; }
