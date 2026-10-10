import { z } from 'zod';
import { ApiError } from './errors.js';
import { canonicalStructured, hash, manifestDigest, manifestSchema, SEMANTICS } from './workspace-contract.js';
import { evaluateAction } from './workspace-interpreter.js';
import { resolveProtocol } from './workspace-admin.js';
import { parseProtocolPackage, PROTOCOL_COMPILER_VERSION, PROTOCOL_COMPILER_VERSION_V3, PROTOCOL_SOURCE_FORMAT_V2, packageLimits } from './protocol-package.js';
const MAX_TOTAL_PACKAGES = 16, MAX_TOTAL_BYTES = 4 * 1024 * 1024, MAX_COMPILE_STEPS = 128;
const compilerLockSchema = z.object({ format: z.literal('peerwork.compilation-lock.v1'), compiler_version: z.string(), semantics: z.literal(SEMANTICS), root_package_digest: z.string().regex(/^[a-f0-9]{64}$/), dependencies: z.array(z.object({ alias: z.string(), package_digest: z.string().regex(/^[a-f0-9]{64}$/), namespace: z.string() }).strict()), bindings: z.record(z.string(), z.unknown()), source_digest: z.string().regex(/^[a-f0-9]{64}$/), protocol_digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function reject(code = 'INVALID_PAYLOAD', status = 400, message = code) { throw new ApiError(code, status, message); }
function canonical(value) { try {
    return canonicalStructured(value);
}
catch {
    return reject('INVALID_PAYLOAD', 400, 'invalid protocol package value');
} }
function same(a, b) { return canonical(a) === canonical(b); }
function packageValue(value) {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'bundle')) {
        const row = value;
        const parsed = parseProtocolPackage(row.bundle);
        if (row.packageDigest !== parsed.packageDigest)
            reject('DEPENDENCY_MISMATCH', 409, 'loaded package digest does not match bytes');
        return parsed;
    }
    return parseProtocolPackage(value);
}
function loadClosure(root, load) {
    const packages = new Map(), active = new Set(), closure = [];
    let totalBytes = 0;
    const visit = (pkg, depth) => {
        if (depth > packageLimits.dependencies)
            reject('RESOURCE_EXHAUSTED', 429, 'package dependency depth exceeded');
        if (active.has(pkg.packageDigest))
            reject('DEPENDENCY_CYCLE', 409, 'package dependency cycle');
        if (packages.has(pkg.packageDigest))
            return;
        if (packages.size >= MAX_TOTAL_PACKAGES)
            reject('RESOURCE_EXHAUSTED', 429, 'package dependency closure exceeds package limit');
        totalBytes += Buffer.byteLength(JSON.stringify(pkg.bundle));
        if (totalBytes > MAX_TOTAL_BYTES)
            reject('RESOURCE_EXHAUSTED', 429, 'package dependency closure exceeds byte limit');
        packages.set(pkg.packageDigest, pkg);
        active.add(pkg.packageDigest);
        for (const imp of pkg.source.imports) {
            const raw = load(imp.package_digest);
            if (raw === undefined)
                reject('DEPENDENCY_MISSING', 409, 'exact package dependency is missing');
            const dep = packageValue(raw);
            if (dep.packageDigest !== imp.package_digest)
                reject('DEPENDENCY_MISMATCH', 409, 'exact package dependency digest mismatch');
            visit(dep, depth + 1);
        }
        active.delete(pkg.packageDigest);
        closure.push(pkg.packageDigest);
    };
    visit(root, 0);
    return { packages, closure, totalBytes };
}
function validateBinding(parameter, value) {
    if (parameter.type === 'enum') {
        if (typeof value !== 'string' || !parameter.values.includes(value))
            reject('INVALID_PAYLOAD', 400, `invalid value for parameter ${parameter.name}`);
        return value;
    }
    if (parameter.type === 'string') {
        if (typeof value !== 'string' || Buffer.byteLength(value) > 8192)
            reject('INVALID_PAYLOAD', 400, `invalid value for parameter ${parameter.name}`);
        return value;
    }
    if (parameter.type === 'integer') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || (parameter.minimum !== undefined && value < parameter.minimum) || (parameter.maximum !== undefined && value > parameter.maximum))
            reject('INVALID_PAYLOAD', 400, `invalid value for parameter ${parameter.name}`);
        return value;
    }
    if (typeof value !== 'boolean')
        reject('INVALID_PAYLOAD', 400, `invalid value for parameter ${parameter.name}`);
    return value;
}
function valuesFor(pkg, provided = {}) {
    const parameters = new Map(pkg.source.parameters.map(parameter => [parameter.name, parameter]));
    for (const name of Object.keys(provided))
        if (!parameters.has(name))
            reject('INVALID_PAYLOAD', 400, `unknown parameter ${name}`);
    const values = {};
    for (const parameter of pkg.source.parameters) {
        const has = Object.hasOwn(provided, parameter.name), value = has ? provided[parameter.name] : parameter.default;
        if (value === undefined) {
            if (parameter.required)
                reject('INVALID_PAYLOAD', 400, `required parameter ${parameter.name} has no value`);
            reject('INVALID_PAYLOAD', 400, `parameter ${parameter.name} has no value or default`);
        }
        values[parameter.name] = validateBinding(parameter, value);
    }
    return values;
}
function applyParameters(pkg, values, manifestValue) {
    const manifest = structuredClone(manifestValue);
    for (const parameter of pkg.source.parameters) {
        const binding = parameter.binding;
        if (!binding)
            continue;
        const action = manifest.actions.find(item => item.id === binding.action_id), variant = action?.variants[binding.variant_index], guard = variant?.when[binding.guard_index];
        if (!guard || guard.op !== 'has_protocol_role')
            reject('INVALID_PAYLOAD', 400, `binding ${parameter.name} does not target a protocol-role guard`);
        const role = values[parameter.name];
        if (typeof role !== 'string' || !manifest.protocol_roles.includes(role))
            reject('INVALID_PAYLOAD', 400, `binding ${parameter.name} selects an undeclared protocol role`);
        guard.role = role;
        if (binding.conflict_role) {
            if (!manifest.protocol_roles.includes(binding.conflict_role))
                reject('COMPOSITION_CONFLICT', 409, `binding ${parameter.name} cannot preserve its role conflict`);
            for (const field of ['role_conflicts', 'historical_role_conflicts']) {
                const pairs = manifest[field];
                const matches = pairs.filter(pair => pair.includes(binding.conflict_role));
                if (matches.length === 0 || matches.some(pair => pair.some(existing => existing !== binding.conflict_role && existing === role)))
                    reject('COMPOSITION_CONFLICT', 409, `binding ${parameter.name} conflicts with existing ${field}`);
                for (const pair of matches) {
                    const next = pair.map(existing => existing === binding.conflict_role ? role : existing);
                    if (new Set(next).size !== next.length)
                        reject('COMPOSITION_CONFLICT', 409, `binding ${parameter.name} collapses ${field}`);
                    Object.assign(pair, next);
                }
            }
        }
    }
    return manifestSchema.parse(manifest);
}
function applyInterfaceInputs(pkg, manifestValue) {
    const manifest = structuredClone(manifestValue);
    if (pkg.source.format !== PROTOCOL_SOURCE_FORMAT_V2)
        return manifestSchema.parse(manifest);
    const assigned = new Map();
    for (const contract of pkg.source.interfaces?.action_bodies ?? []) {
        const action = manifest.actions.find((item) => item.id === contract.action);
        if (!action)
            reject('INVALID_PAYLOAD', 400, `action body contract targets missing action ${contract.action}`);
        const bodySchema = structuredClone(contract.body);
        assigned.set(action.id, canonical(bodySchema));
        action.inputs = bodySchema;
    }
    for (const input of pkg.source.interfaces?.inputs ?? []) {
        const action = manifest.actions.find((item) => item.id === input.action);
        if (!action || !action.variants[input.variant])
            reject('INVALID_PAYLOAD', 400, `interface input targets missing action variant ${input.action}`);
        const bodySchema = structuredClone(input.action_body);
        for (const [name, field] of Object.entries(bodySchema.fields)) {
            if (field.type === 'exact_ref' && field.input) {
                field.schema = '*';
                delete field.input;
            }
            else if (field.type === 'actor_id' && field.input) {
                delete field.input;
            }
        }
        const canonicalBody = canonical(bodySchema), prior = assigned.get(action.id);
        if (prior && prior !== canonicalBody)
            reject('COMPOSITION_CONFLICT', 409, `inconsistent complete action body schema for ${action.id}`);
        assigned.set(action.id, canonicalBody);
        action.inputs = bodySchema;
    }
    return manifestSchema.parse(manifest);
}
function qualify(namespace, value, max = 120) { const result = `${namespace}.${value}`; if (result.length > max)
    reject('RESOURCE_EXHAUSTED', 429, 'namespaced protocol identifier too long'); return result; }
function statePath(path, namespace) { return Array.isArray(path) ? [namespace, ...path] : path; }
function mappedSymbol(namespace, value, mapping, max = 120) { const qualified = qualify(namespace, value, max); return mapping.get(value) ?? mapping.get(qualified) ?? qualified; }
function transformSelector(value, namespace, typed = false) {
    if (Array.isArray(value))
        return value.map(item => transformSelector(item, namespace, typed));
    if (!value || typeof value !== 'object')
        return value;
    if (typed && value.from === 'literal')
        return structuredClone(value);
    const out = {};
    for (const [key, item] of Object.entries(value))
        out[key] = transformSelector(item, namespace, typed);
    if (value.from === 'state' && Array.isArray(value.path))
        out.path = statePath(value.path, namespace);
    if (value.from === 'ref' && value.source === 'state' && Array.isArray(value.path))
        out.path = statePath(value.path, namespace);
    if (value.from === 'ref' && typeof value.schema === 'string')
        out.schema = qualify(namespace, value.schema, 80);
    if (value.from === 'resolved_entity' && value.ref?.source === 'state' && Array.isArray(value.ref.path))
        out.ref = { ...out.ref, path: statePath(value.ref.path, namespace) };
    return out;
}
function transformGuard(value, namespace, symbols = { roles: new Map(), capabilities: new Map() }, typed = false) {
    if (typed) {
        if (value?.op === 'and' || value?.op === 'or')
            return { ...value, rules: value.rules.map((rule) => transformGuard(rule, namespace, symbols, true)) };
        if (value?.op === 'not')
            return { ...value, rule: transformGuard(value.rule, namespace, symbols, true) };
        if (value?.op === 'has_protocol_role')
            return { ...value, role: mappedSymbol(namespace, value.role, symbols.roles) };
        if (value?.op === 'has_capability')
            return { ...value, capability: mappedSymbol(namespace, value.capability, symbols.capabilities) };
        if (value?.op === 'exact_ref_list')
            return { ...value, ...(value.source === 'state' ? { path: statePath(value.path, namespace) } : {}), ...(typeof value.schema === 'string' ? { schema: qualify(namespace, value.schema, 80) } : {}) };
        if (value?.op === 'eq')
            return { ...value, left: transformSelector(value.left, namespace, true), right: transformSelector(value.right, namespace, true) };
        if (value?.op === 'in')
            return { ...value, value: transformSelector(value.value, namespace, true), set: value.set.map((item) => transformSelector(item, namespace, true)) };
        if (value?.op === 'exact_ref')
            return { ...value, ref: transformSelector(value.ref, namespace, true) };
        return structuredClone(value);
    }
    const out = transformSelector(value, namespace);
    if (value?.op === 'exact_ref_list') {
        if (value.source === 'state')
            out.path = statePath(value.path, namespace);
        if (typeof value.schema === 'string')
            out.schema = qualify(namespace, value.schema, 80);
    }
    if (value?.op === 'has_protocol_role' && typeof value.role === 'string')
        out.role = mappedSymbol(namespace, value.role, symbols.roles);
    if (value?.op === 'has_capability' && typeof value.capability === 'string')
        out.capability = mappedSymbol(namespace, value.capability, symbols.capabilities);
    return out;
}
function requireDeclaredReads(manifest) {
    const paths = new WeakMap();
    const collect = (value, out) => {
        if (Array.isArray(value)) {
            for (const item of value)
                collect(item, out);
            return;
        }
        if (!value || typeof value !== 'object')
            return;
        if (value.from === 'literal')
            return;
        if ((value.from === 'state' || value.from === 'ref' && value.source === 'state') && Array.isArray(value.path))
            out.push(value.path);
        if (value.from === 'resolved_entity' && value.ref?.source === 'state' && Array.isArray(value.ref.path))
            out.push(value.ref.path);
        if (value.op === 'exact_ref_list' && value.source === 'state' && Array.isArray(value.path))
            out.push(value.path);
        for (const child of Object.values(value))
            collect(child, out);
    };
    for (const action of manifest.actions) {
        const used = [];
        for (const variant of action.variants) {
            collect(variant.when, used);
            collect(variant.effects, used);
        }
        for (const path of used)
            if (!action.reads.some(declared => declared.length <= path.length && declared.every((part, index) => part === path[index])))
                reject('INVALID_PAYLOAD', 400, `action ${action.id} uses undeclared state read ${path.join('.')}`);
    }
}
function namespaceManifest(input, namespace, symbols = { roles: new Map(), capabilities: new Map() }, typed = false, occurrenceAlias = namespace) {
    requireDeclaredReads(input);
    const value = structuredClone(input);
    value.dependencies = [];
    value.initial_state = { [namespace]: value.initial_state };
    value.protocol_roles = value.protocol_roles.map((role) => mappedSymbol(namespace, role, symbols.roles));
    value.capabilities = value.capabilities.map((capability) => mappedSymbol(namespace, capability, symbols.capabilities));
    if (value.execution_requirements)
        value.execution_requirements = { ...value.execution_requirements, ports: value.execution_requirements.ports.map((port) => ({ ...port, import_path: [occurrenceAlias, ...port.import_path], action_id: qualify(namespace, port.action_id) })) };
    value.role_conflicts = (value.role_conflicts ?? []).map((pair) => pair.map(role => mappedSymbol(namespace, role, symbols.roles)));
    value.historical_role_conflicts = (value.historical_role_conflicts ?? []).map((pair) => pair.map(role => mappedSymbol(namespace, role, symbols.roles)));
    if (value.role_conflicts.some((pair) => pair[0] === pair[1]) || value.historical_role_conflicts.some((pair) => pair[0] === pair[1]))
        reject('COMPOSITION_CONFLICT', 409, 'role mapping collapses a declared conflict');
    const oldToNew = new Map();
    for (const action of value.actions) {
        oldToNew.set(action.id, qualify(namespace, action.id));
        action.id = qualify(namespace, action.id);
        action.reads = action.reads.map((path) => statePath(path, namespace));
        action.writes = action.writes.map((path) => statePath(path, namespace));
        if (action.inputs)
            for (const field of Object.values(action.inputs.fields))
                if (field.type === 'exact_ref' && field.schema !== '*')
                    field.schema = qualify(namespace, field.schema, 80);
        for (const variant of action.variants) {
            variant.when = variant.when.map((guard) => transformGuard(guard, namespace, symbols, typed));
            variant.effects = variant.effects.map((effect) => {
                const next = transformSelector(effect, namespace, typed);
                if (effect.op === 'set')
                    next.path = statePath(effect.path, namespace);
                if (effect.op === 'append') {
                    next.schema = qualify(namespace, effect.schema, 80);
                    next.relations = (effect.relations ?? []).map((relation) => ({ ...transformSelector(relation, namespace), kind: qualify(namespace, relation.kind, 80) }));
                }
                return next;
            });
        }
    }
    const schemas = {};
    for (const [name, schema] of Object.entries(value.record_schemas))
        schemas[qualify(namespace, name, 80)] = schema;
    value.record_schemas = schemas;
    const constraints = {};
    for (const [id, rules] of Object.entries(value.constraints ?? {}))
        constraints[oldToNew.get(id) ?? qualify(namespace, id)] = rules.map(rule => transformGuard(rule, namespace, symbols, typed));
    value.constraints = constraints;
    return manifestSchema.parse(value);
}
function namespacedEntry(namespace, manifest, symbols, typed = false, occurrenceAlias = namespace) { return namespaceManifest(manifest, namespace, symbols, typed, occurrenceAlias); }
function mappingsFor(parent, alias, dependency) {
    const roles = new Map(), capabilities = new Map();
    if (parent.source.format !== PROTOCOL_SOURCE_FORMAT_V2)
        return { roles, capabilities };
    for (const mapping of parent.source.role_mappings ?? [])
        if (mapping.from.import === alias) {
            if (!dependency.protocol_roles.includes(mapping.from.role) || !parent.source.manifest.protocol_roles.includes(mapping.to))
                reject('INVALID_PAYLOAD', 400, 'role mapping must reference declared symbols');
            if (roles.has(mapping.from.role))
                reject('INVALID_PAYLOAD', 400, 'duplicate role mapping');
            roles.set(mapping.from.role, mapping.to);
        }
    for (const mapping of parent.source.capability_mappings ?? [])
        if (mapping.from.import === alias) {
            if (!dependency.capabilities.includes(mapping.from.capability) || !parent.source.manifest.capabilities.includes(mapping.to))
                reject('INVALID_PAYLOAD', 400, 'capability mapping must reference declared symbols');
            if (capabilities.has(mapping.from.capability))
                reject('INVALID_PAYLOAD', 400, 'duplicate capability mapping');
            capabilities.set(mapping.from.capability, mapping.to);
        }
    return { roles, capabilities };
}
function sourceMapFor(pkg, namespace = '') {
    const map = {};
    for (const action of pkg.source.manifest.actions) {
        const id = namespace ? qualify(namespace, action.id) : action.id;
        map[`actions/${id}`] = [{ packageDigest: pkg.packageDigest, path: 'protocol.source.json#/manifest/actions', operation: 'source' }];
    }
    for (const schemaName of Object.keys(pkg.source.manifest.record_schemas)) {
        const name = namespace ? qualify(namespace, schemaName, 80) : schemaName;
        map[`record_schemas/${name}`] = [{ packageDigest: pkg.packageDigest, path: 'protocol.source.json#/manifest/record_schemas', operation: 'source' }];
    }
    for (const parameter of pkg.source.parameters)
        if (parameter.binding) {
            const key = `actions/${namespace ? qualify(namespace, parameter.binding.action_id) : parameter.binding.action_id}`;
            (map[key] ??= []).push({ packageDigest: pkg.packageDigest, path: `protocol.source.json#/parameters/${parameter.name}/binding`, operation: 'bind-parameter' });
        }
    for (const derivation of pkg.source.derive) {
        const key = `actions/${namespace ? qualify(namespace, derivation.action_id) : derivation.action_id}`;
        (map[key] ??= []).push({ packageDigest: pkg.packageDigest, path: 'protocol.source.json#/derive', operation: 'add-constraint' });
    }
    return map;
}
function mergeSourceMap(target, source, namespace = '') {
    for (const [path, locations] of Object.entries(source)) {
        const mapped = namespace ? path.replace(/^(actions|record_schemas)\//, `$1/${namespace}.`) : path;
        (target[mapped] ??= []).push(...locations);
    }
}
function statePaths(value, out = []) {
    if (Array.isArray(value)) {
        for (const item of value)
            statePaths(item, out);
        return out;
    }
    if (!value || typeof value !== 'object')
        return out;
    if (value.from === 'literal')
        return out;
    if (value.from === 'state' && Array.isArray(value.path))
        out.push(value.path);
    if (value.from === 'ref' && value.source === 'state' && Array.isArray(value.path))
        out.push(value.path);
    if (value.op === 'exact_ref_list' && value.source === 'state' && Array.isArray(value.path))
        out.push(value.path);
    for (const child of Object.values(value))
        statePaths(child, out);
    return out;
}
function resolveSourceOutput(context, name, seen = new Set()) {
    const pkg = context.pkg;
    const key = `${pkg.packageDigest}\0${name}`;
    if (seen.has(key))
        reject('DEPENDENCY_CYCLE', 409, 'interface forwarding cycle');
    seen.add(key);
    const output = pkg.source.interfaces?.outputs.find(item => item.name === name);
    if (!output)
        return undefined;
    if (output.selector.from === 'state')
        return output.type === 'exact_ref' ? { type: 'exact_ref', path: output.selector.path, schema: output.schema, scope: output.scope, available_when: output.available_when } : { type: 'actor_id', path: output.selector.path, available_when: output.available_when };
    const selector = output.selector;
    if (selector.from !== 'import')
        return undefined;
    const imported = pkg.source.imports.find(item => item.alias === selector.alias), dependency = imported && context.imports.get(imported.alias);
    if (!imported || !dependency)
        reject('DEPENDENCY_MISSING', 409, 'forwarded interface dependency is missing');
    const inner = resolveSourceOutput(dependency, selector.output, seen);
    if (!inner)
        reject('INVALID_PAYLOAD', 400, 'forwarded interface output does not exist');
    if (inner.type !== output.type)
        reject('COMPOSITION_CONFLICT', 409, 'forwarded interface declaration differs from source type');
    if (inner.type === 'exact_ref' && (output.type !== 'exact_ref' || inner.scope !== output.scope || qualify(imported.namespace, inner.schema, 80) !== output.schema))
        reject('COMPOSITION_CONFLICT', 409, 'forwarded interface declaration differs from source type');
    const symbols = mappingsFor(pkg, imported.alias, dependency.manifest), nestedAvailability = transformGuard(inner.available_when, imported.namespace, symbols, pkg.lock.compiler_version === PROTOCOL_COMPILER_VERSION_V3);
    return inner.type === 'exact_ref' ? { type: 'exact_ref', path: [imported.namespace, ...inner.path], schema: qualify(imported.namespace, inner.schema, 80), scope: inner.scope, available_when: { op: 'and', rules: [structuredClone(output.available_when), nestedAvailability] } } : { type: 'actor_id', path: [imported.namespace, ...inner.path], available_when: { op: 'and', rules: [structuredClone(output.available_when), nestedAvailability] } };
}
function applyConnections(parent, units) {
    if (parent.source.format !== PROTOCOL_SOURCE_FORMAT_V2)
        return;
    for (const connection of parent.source.connections ?? []) {
        const from = units.get(connection.from.import), to = units.get(connection.to.import);
        if (!from || !to)
            reject('INVALID_PAYLOAD', 400, 'connection import missing');
        const declaredOutput = from.pkg.source.interfaces?.outputs.find(item => item.name === connection.from.output), resolvedOutput = resolveSourceOutput(from.context, connection.from.output), actualInput = to.pkg.source.interfaces?.inputs.find(item => item.action === connection.to.action && item.variant === connection.to.variant && item.name === connection.to.input);
        if (!declaredOutput || !resolvedOutput || !actualInput)
            reject('INVALID_PAYLOAD', 400, 'connection references an unknown public interface');
        if (declaredOutput.type !== actualInput.type || resolvedOutput.type !== actualInput.type)
            reject('COMPOSITION_CONFLICT', 409, 'connected interface types are incompatible');
        const action = to.manifest.actions.find(item => item.id === qualify(to.namespace, actualInput.action)), variant = action?.variants[actualInput.variant];
        if (!action || !variant)
            reject('INVALID_PAYLOAD', 400, 'connection targets missing action variant');
        const outputSymbols = mappingsFor(parent, connection.from.import, from.context.manifest), available = transformGuard(resolvedOutput.available_when, from.namespace, outputSymbols, parent.lock.compiler_version === PROTOCOL_COMPILER_VERSION_V3);
        if (actualInput.type === 'actor_id' && resolvedOutput.type === 'actor_id') {
            const actorField = actualInput.action_body.fields[actualInput.body_path[0]], field = action.inputs?.fields[actualInput.body_path[0]];
            if (!actorField || actorField.type !== 'actor_id' || actorField.input !== actualInput.name || !field || field.type !== 'actor_id')
                reject('COMPOSITION_CONFLICT', 409, 'actor-id interface input is not a typed body field');
            const sourcePath = statePath(resolvedOutput.path, from.namespace), bodyActor = { from: 'body', path: actualInput.body_path }, authActor = { from: 'auth', field: 'actorId' };
            variant.when.push({ op: 'eq', left: bodyActor, right: { from: 'state', path: sourcePath } }, { op: actualInput.relation === 'same_actor' ? 'eq' : 'not', ...(actualInput.relation === 'same_actor' ? { left: bodyActor, right: authActor } : { rule: { op: 'eq', left: bodyActor, right: authActor } }) }, { op: 'and', rules: [available] });
            action.reads.push(sourcePath, ...statePaths(available));
            const unique = new Map(action.reads.map(path => [JSON.stringify(path), path]));
            action.reads = [...unique.values()];
            continue;
        }
        if (actualInput.type !== 'exact_ref' || resolvedOutput.type !== 'exact_ref')
            reject('COMPOSITION_CONFLICT', 409, 'connected interface types or scopes are incompatible');
        const portField = actualInput.action_body.fields[actualInput.body_path[0]];
        if (!portField || portField.type !== 'exact_ref' || portField.input !== actualInput.name)
            reject('INVALID_PAYLOAD', 400, 'connected input field is not a typed reference port');
        const schema = qualify(from.namespace, resolvedOutput.schema, 80), field = action.inputs?.fields[actualInput.body_path[0]];
        if (!field || field.type !== 'exact_ref' || field.schema !== '*')
            reject('COMPOSITION_CONFLICT', 409, 'input reference port is not unresolved');
        field.schema = schema;
        const outputPath = statePath(resolvedOutput.path, from.namespace), bodyRef = { from: 'ref', source: 'body', path: actualInput.body_path, scope: actualInput.scope, schema };
        variant.when.push({ op: 'exact_ref', ref: bodyRef }, { op: 'eq', left: bodyRef, right: { from: 'ref', source: 'state', path: outputPath, scope: resolvedOutput.scope, schema } }, { op: 'and', rules: [available] });
        action.reads.push(outputPath, ...statePaths(available));
        const unique = new Map(action.reads.map(path => [JSON.stringify(path), path]));
        action.reads = [...unique.values()];
        const hook = actualInput.provenance_hook;
        if (!hook)
            continue;
        const schemaName = qualify(to.namespace, hook.record_schema, 80), relationKind = qualify(to.namespace, hook.relation_kind, 80), targetPath = actualInput.body_path;
        const appends = variant.effects.filter((effect) => effect.op === 'append' && effect.recordSlot === hook.record_slot && effect.schema === schemaName);
        if (appends.length !== 1)
            reject('COMPOSITION_CONFLICT', 409, 'provenance hook does not identify one output record');
        const append = appends[0];
        if (append.relations.some((relation) => relation.kind === relationKind))
            reject('COMPOSITION_CONFLICT', 409, 'provenance relation would overwrite an existing relation');
        append.relations.push({ kind: relationKind, target: { from: 'ref', source: 'body', path: targetPath, scope: actualInput.scope, schema } });
    }
}
function compileRaw(pkg, provided, session, stack) {
    if (stack.includes(pkg.packageDigest))
        reject('DEPENDENCY_CYCLE', 409, 'package dependency cycle');
    if (++session.steps > MAX_COMPILE_STEPS)
        reject('RESOURCE_EXHAUSTED', 429, 'package compiler work limit exceeded');
    const values = valuesFor(pkg, provided), dependencies = [], unresolvedInputs = [], inputRequirements = [], loadMap = new Map(), sourceMap = sourceMapFor(pkg), inheritedScenarios = [], inheritedDispositions = [], importedUnits = new Map(), interfaceImports = new Map(), connected = new Set((pkg.source.connections ?? []).map(connection => `${connection.to.import}\0${connection.to.action}\0${connection.to.variant}\0${connection.to.input}`));
    for (const imp of pkg.source.imports) {
        const dep = session.packages.get(imp.package_digest);
        if (!dep)
            reject('DEPENDENCY_MISSING', 409, 'exact package dependency is missing');
        const mapped = {};
        for (const binding of pkg.source.bindings.filter(item => item.import_alias === imp.alias)) {
            const slot = dep.source.exports.find(item => item.slot === binding.slot);
            if (!slot)
                reject('INVALID_PAYLOAD', 400, `unknown imported binding slot ${binding.slot}`);
            mapped[slot.parameter] = values[binding.parameter];
        }
        const compiled = compileRaw(dep, mapped, session, [...stack, pkg.packageDigest]);
        interfaceImports.set(imp.alias, compiled.interfaceContext);
        for (const port of compiled.inputRequirements) {
            const direct = port.importPath.length === 0 && dep.source.interfaces?.inputs.some(input => input.action === port.actionId && input.variant === port.variant && input.name === port.inputName), bound = port.bound || Boolean(direct && connected.has(`${imp.alias}\0${port.actionId}\0${port.variant}\0${port.inputName}`)), mapped = { ...port, actionId: qualify(imp.namespace, port.actionId), importPath: [imp.alias, ...port.importPath], bound };
            inputRequirements.push(mapped);
            if (!bound)
                unresolvedInputs.push({ packageDigest: dep.packageDigest, importPath: mapped.importPath, actionId: mapped.actionId, variant: mapped.variant, inputName: mapped.inputName, required: mapped.required, type: mapped.type });
        }
        // A compiled dependency manifest is already the flattened, validated view of
        // its exact package closure. Namespace that composition unit once; adding its
        // closure manifests again duplicates every reducer inherited by the aggregate
        // and makes a reusable derived package impossible to import a second time.
        const symbols = mappingsFor(pkg, imp.alias, compiled.manifest), namespacedManifests = [namespacedEntry(imp.namespace, compiled.manifest, symbols, pkg.lock.compiler_version === PROTOCOL_COMPILER_VERSION_V3, imp.alias)];
        for (const namespaced of namespacedManifests) {
            importedUnits.set(imp.alias, { pkg: dep, namespace: imp.namespace, manifest: namespaced, context: compiled.interfaceContext });
            const dependencyDigest = manifestDigest(namespaced).digest, prior = loadMap.get(dependencyDigest);
            if (prior && !same(prior, namespaced))
                reject('DEPENDENCY_MISMATCH', 409, 'namespaced dependency digest collision');
            if (!prior) {
                loadMap.set(dependencyDigest, namespaced);
                dependencies.push(namespaced);
            }
        }
        inheritedScenarios.push(...compiled.fixtureScenarios.map(scenario => ({ id: `${imp.alias}/${scenario.id}`, fixture: transformFixture(scenario.fixture, imp.namespace, symbols), originPackageDigest: scenario.originPackageDigest, importPath: [imp.alias, ...scenario.importPath] })));
        for (const row of compiled.fixtureResults)
            if (row.disposition)
                inheritedDispositions.push({ origin: { package_digest: row.disposition.origin.package_digest, import_path: [imp.alias, ...row.disposition.origin.import_path], fixture_id: row.disposition.origin.fixture_id }, expected_rejection: row.disposition.expectedRejection, rationale: row.disposition.rationale, replacement_scenario_id: `${imp.alias}/${row.disposition.replacementScenarioId}` });
        mergeSourceMap(sourceMap, compiled.sourceMap, imp.namespace);
    }
    applyConnections(pkg, importedUnits);
    loadMap.clear();
    for (const dependency of dependencies) {
        const digest = manifestDigest(dependency).digest, prior = loadMap.get(digest);
        if (prior && !same(prior, dependency))
            reject('DEPENDENCY_MISMATCH', 409, 'connected dependency digest collision');
        loadMap.set(digest, dependency);
    }
    const own = applyInterfaceInputs(pkg, applyParameters(pkg, values, pkg.source.manifest));
    requireDeclaredReads(own);
    const root = structuredClone(own);
    root.dependencies = [];
    for (const input of pkg.source.interfaces?.inputs ?? []) {
        const requirement = { importPath: [], actionId: input.action, variant: input.variant, inputName: input.name, required: input.required, type: input.type, bound: false };
        inputRequirements.push(requirement);
        unresolvedInputs.push({ packageDigest: pkg.packageDigest, ...requirement });
    }
    const availableActions = new Set([...root.actions.map((action) => action.id), ...dependencies.flatMap(dependency => dependency.actions.map(action => action.id))]);
    const availableRoles = new Set([...root.protocol_roles, ...dependencies.flatMap(dependency => dependency.protocol_roles)]), availableCapabilities = new Set([...root.capabilities, ...dependencies.flatMap(dependency => dependency.capabilities)]);
    const added = Object.assign(Object.create(null), root.constraints ?? {});
    for (const derivation of pkg.source.derive) {
        if (!availableActions.has(derivation.action_id))
            reject('COMPOSITION_CONFLICT', 409, `derivation targets missing action ${derivation.action_id}`);
        const rules = Object.hasOwn(added, derivation.action_id) ? added[derivation.action_id] : (added[derivation.action_id] = []);
        rules.push(derivation.guard);
    }
    const validateGuard = (guard) => { if (guard.op === 'has_protocol_role' && !availableRoles.has(guard.role))
        reject('INVALID_PAYLOAD', 400, `constraint uses undeclared protocol role ${guard.role}`); if (guard.op === 'has_capability' && !availableCapabilities.has(guard.capability))
        reject('INVALID_PAYLOAD', 400, `constraint uses undeclared capability ${guard.capability}`); if (guard.rules)
        for (const child of guard.rules)
            validateGuard(child); if (guard.rule)
        validateGuard(guard.rule); };
    for (const derivation of pkg.source.derive)
        validateGuard(derivation.guard);
    root.constraints = added;
    const dependencyIds = dependencies.map(dependency => manifestDigest(dependency).digest);
    root.dependencies = dependencyIds;
    for (const [id, rules] of Object.entries(root.constraints))
        for (const imp of pkg.source.imports)
            if (id.startsWith(`${imp.namespace}.`) && !dependencies.some(dependency => dependency.actions.some(action => action.id === id)))
                reject('COMPOSITION_CONFLICT', 409, `derivation targets missing action ${id}`);
    if (pkg.lock.compiler_version === PROTOCOL_COMPILER_VERSION_V3)
        root.execution_requirements = { format: 'peerwork.protocol-execution-requirements.v1', closure_complete: true, ports: inputRequirements.map(({ importPath, actionId, variant, inputName, type, required, bound }) => ({ import_path: importPath, action_id: actionId, variant, input_name: inputName, type, required, bound })) };
    const resolved = resolveProtocol(root, digest => loadMap.get(digest));
    requireDeclaredReads(resolved.manifest);
    const ownSource = manifestDigest(own).digest;
    mergeSourceMap(sourceMap, sourceMapFor(pkg));
    const resolvedDependencyManifests = resolved.dependencyClosure.map(protocolDigest => ({ protocolDigest, manifest: loadMap.get(protocolDigest) }));
    const fixtureScenarios = [...inheritedScenarios, ...pkg.fixtures.map(fixture => ({ id: fixture.id, fixture, originPackageDigest: pkg.packageDigest, importPath: [] }))];
    const fixtureResults = applyFixtureDispositions(pkg, fixtureScenarios, runFixtures(resolved.manifest, fixtureScenarios), inheritedDispositions);
    const interfaceContext = { pkg, manifest: resolved.manifest, imports: interfaceImports };
    return { manifest: resolved.manifest, sourceDigest: ownSource, protocolDigest: resolved.resolvedDigest, dependencyClosure: resolved.dependencyClosure, resolvedDependencyManifests, sourceMap, unresolvedInputs, inputRequirements, values, fixtureResults, fixtureScenarios, interfaceContext };
}
function transformFixture(fixture, namespace, symbols = { roles: new Map(), capabilities: new Map() }) {
    if ('kind' in fixture) {
        const state = fixture.state && typeof fixture.state === 'object' && !Array.isArray(fixture.state) ? { [namespace]: fixture.state } : fixture.state;
        return { ...fixture, state, steps: fixture.steps.map(step => ({ ...step, action_id: qualify(namespace, step.action_id), auth: { ...step.auth, protocolRoles: step.auth.protocolRoles.map(role => mappedSymbol(namespace, role, symbols.roles)), capabilities: step.auth.capabilities.map(capability => mappedSymbol(namespace, capability, symbols.capabilities)) }, expected: transformFixtureExpected(step.expected, namespace) })) };
    }
    const state = fixture.state && typeof fixture.state === 'object' && !Array.isArray(fixture.state) ? { [namespace]: fixture.state } : fixture.state;
    const auth = { ...fixture.auth, protocolRoles: fixture.auth.protocolRoles.map(role => mappedSymbol(namespace, role, symbols.roles)), capabilities: fixture.auth.capabilities.map(capability => mappedSymbol(namespace, capability, symbols.capabilities)) };
    const expected = transformFixtureExpected(fixture.expected, namespace);
    return { ...fixture, action_id: qualify(namespace, fixture.action_id), state, auth, exact_inputs: fixture.exact_inputs.map(input => ({ ...input, schema: qualify(namespace, input.schema, 80) })), expected };
}
function transformFixtureExpected(value, namespace) {
    const expected = structuredClone(value);
    if (expected.state && typeof expected.state === 'object' && !Array.isArray(expected.state))
        expected.state = { [namespace]: expected.state };
    if (Array.isArray(expected.records))
        expected.records = expected.records.map((record) => ({ ...record, schema: qualify(namespace, record.schema, 80), relations: (record.relations ?? []).map((relation) => ({ ...relation, kind: qualify(namespace, relation.kind, 80) })) }));
    if (expected.revisionEffects)
        expected.revisionEffects = { ...expected.revisionEffects, contentEntities: expected.revisionEffects.contentEntities.map((entity) => qualify(namespace, entity)) };
    if (Array.isArray(expected.headSelections))
        expected.headSelections = expected.headSelections.map((selection) => selection);
    return expected;
}
function runFixtures(manifest, fixtures) {
    return fixtures.map(({ id, fixture }) => {
        if ('kind' in fixture)
            return runSequenceFixture(manifest, fixture, id);
        const scenario = { ...fixture, state: mergeFixtureState(manifest.initial_state, fixture.state) };
        let observed;
        try {
            const result = evaluateAction({ manifest: { actions: manifest.actions }, actionId: scenario.action_id, state: scenario.state, body: scenario.body, auth: scenario.auth, exactInputs: scenario.exact_inputs, executionTimeMs: scenario.time_ms });
            observed = { accepted: true, state: result.nextState, records: result.records, headSelections: result.headSelections, revisionEffects: result.revisionEffects, ...result.evaluatedAt !== undefined ? { evaluated_at: result.evaluatedAt } : {} };
        }
        catch (error) {
            observed = { accepted: false, code: error instanceof ApiError ? error.code : 'INVALID_PAYLOAD' };
        }
        const expected = scenario.expected, fields = Object.keys(expected);
        const passed = fields.every(key => same(observed[key], expected[key]));
        return { id, passed, expected, observed };
    });
}
function applyFixtureDispositions(pkg, scenarios, results, inheritedDispositions = []) {
    const dispositions = [...(pkg.source.format === PROTOCOL_SOURCE_FORMAT_V2 ? pkg.source.fixture_dispositions ?? [] : []), ...inheritedDispositions];
    if (!dispositions.length)
        return results;
    const output = [...results], used = new Set();
    for (const disposition of dispositions) {
        const matches = scenarios.map((scenario, index) => ({ scenario, index })).filter(({ scenario }) => scenario.originPackageDigest === disposition.origin.package_digest && same(scenario.importPath, disposition.origin.import_path) && scenario.fixture.id === disposition.origin.fixture_id);
        if (matches.length !== 1)
            reject('INVALID_PAYLOAD', 400, 'fixture disposition must match exactly one final replay occurrence');
        const match = matches[0], row = output[match.index], sequenceRejection = Array.isArray(row?.observed) ? row.observed.map((step) => step?.observed).find((observed) => observed?.accepted === false && observed.code === disposition.expected_rejection) : undefined, singleRejection = row?.observed?.accepted === false && row?.observed?.code === disposition.expected_rejection;
        if (!row || used.has(match.index) || row.passed || (!singleRejection && !sequenceRejection))
            reject('EXAMPLE_FAILED', 409, 'fixture disposition rejection did not match final replay');
        const replacement = output.find(item => item.id === disposition.replacement_scenario_id);
        if (!replacement || !replacement.passed || replacement === row)
            reject('EXAMPLE_FAILED', 409, 'fixture disposition replacement scenario did not pass');
        used.add(match.index);
        output[match.index] = { ...row, passed: true, disposition: { origin: disposition.origin, expectedRejection: disposition.expected_rejection, rationale: disposition.rationale, replacementScenarioId: disposition.replacement_scenario_id } };
    }
    return output;
}
function runSequenceFixture(manifest, fixture, id) {
    let state = mergeFixtureState(manifest.initial_state, fixture.state);
    const refs = new Map(), observedSteps = [];
    let passed = true;
    for (let index = 0; index < fixture.steps.length; index++) {
        const step = fixture.steps[index], body = replaceFixtureRefs(step.body, refs), exactInputs = [];
        for (const name of step.exact_inputs) {
            const ref = refs.get(name);
            if (!ref)
                throw new ApiError('INVALID_PAYLOAD', 400, 'sequence references an unbound exact input');
            exactInputs.push(ref);
        }
        let result, observed;
        try {
            result = evaluateAction({ manifest: { actions: manifest.actions }, actionId: step.action_id, state, body, auth: step.auth, exactInputs, executionTimeMs: step.time_ms });
        }
        catch (error) {
            observed = { accepted: false, code: error instanceof ApiError ? error.code : 'INVALID_PAYLOAD' };
        }
        if (result) {
            // Build the next fixture environment off to the side. Missing/invalid record
            // bindings are harness errors and must never look like a protocol rejection.
            const nextRefs = new Map(refs), nextState = result.nextState;
            for (const binding of step.bind_refs) {
                const record = result.records.find(item => item.recordSlot === binding.record_slot);
                if (!record)
                    reject('INVALID_PAYLOAD', 400, 'sequence output record slot was not produced');
                const recordId = Buffer.from(hash(`${id}:${index}:${binding.name}`), 'hex').toString('base64url');
                let revision = 1, entityId;
                if (record.entity?.mode === 'new')
                    entityId = Buffer.from(hash(`${id}:${index}:${record.entity.slot}`), 'hex').toString('base64url');
                else if (record.entity?.mode === 'revise') {
                    const parent = record.entity.parent, parentInput = [...nextRefs.values()].find(ref => ref.recordId === parent?.recordId && ref.revision === parent?.revision);
                    if (!parentInput?.entityId)
                        reject('INVALID_PAYLOAD', 400, 'sequence revised record parent is not a bound entity ref');
                    entityId = parentInput.entityId;
                    revision = parent.revision + 1;
                }
                nextRefs.set(binding.name, { recordId, revision, schema: record.schema, payload: record.payload, scope: 'INSTANCE', ...(entityId ? { entityId } : {}) });
            }
            let committedState = nextState;
            for (const binding of step.bind_refs) {
                const ref = nextRefs.get(binding.name);
                committedState = replaceProducedRefs(committedState, binding.record_slot, ref.recordId, ref.revision);
            }
            refs.clear();
            for (const [name, ref] of nextRefs)
                refs.set(name, ref);
            state = committedState;
            observed = { accepted: true, state: committedState, records: result.records, headSelections: result.headSelections, revisionEffects: result.revisionEffects, ...result.evaluatedAt !== undefined ? { evaluated_at: result.evaluatedAt } : {} };
        }
        const expected = replaceExpectedRefs(step.expected, refs), stepPassed = Object.keys(expected).every(key => same(observed[key], expected[key]));
        passed = passed && stepPassed;
        observedSteps.push({ expected, observed, passed: stepPassed });
        // Continue after an expected rejection (which commits no state/ref changes);
        // stop only when the fixture itself diverges from its declared outcome.
        if (!observed.accepted && !stepPassed)
            break;
    }
    return { id, passed, expected: fixture.steps.map(step => step.expected), observed: observedSteps, executedSteps: observedSteps.length, totalSteps: fixture.steps.length, notRunSteps: fixture.steps.length - observedSteps.length };
}
function replaceFixtureRefs(value, refs) {
    if (Array.isArray(value))
        return value.map(item => replaceFixtureRefs(item, refs));
    if (!value || typeof value !== 'object')
        return value;
    if (Object.keys(value).length === 1 && typeof value.$fixture_ref === 'string') {
        const ref = refs.get(value.$fixture_ref);
        if (!ref)
            throw new ApiError('INVALID_PAYLOAD', 400, 'sequence body references an unbound exact input');
        return { record_id: ref.recordId, revision: ref.revision };
    }
    const result = {};
    for (const [key, item] of Object.entries(value))
        result[key] = replaceFixtureRefs(item, refs);
    return result;
}
function replaceExpectedRefs(value, refs) {
    if (Array.isArray(value))
        return value.map(item => replaceExpectedRefs(item, refs));
    if (!value || typeof value !== 'object')
        return value;
    if (Object.keys(value).length === 1 && typeof value.$fixture_ref === 'string') {
        const ref = refs.get(value.$fixture_ref);
        if (!ref)
            throw new ApiError('INVALID_PAYLOAD', 400, 'sequence expected output references an unbound exact input');
        return { recordId: ref.recordId, revision: ref.revision };
    }
    const result = {};
    for (const [key, item] of Object.entries(value))
        result[key] = replaceExpectedRefs(item, refs);
    return result;
}
function replaceProducedRefs(value, slot, recordId, revision) {
    if (Array.isArray(value))
        return value.map(item => replaceProducedRefs(item, slot, recordId, revision));
    if (!value || typeof value !== 'object')
        return value;
    if (value.$produced === 'record' && (!slot || value.slot === slot))
        return { record_id: recordId, revision };
    const result = {};
    for (const [key, item] of Object.entries(value))
        result[key] = replaceProducedRefs(item, slot, recordId, revision);
    return result;
}
function mergeFixtureState(initial, provided) {
    if (!initial || typeof initial !== 'object' || Array.isArray(initial) || !provided || typeof provided !== 'object' || Array.isArray(provided))
        return structuredClone(provided);
    const result = structuredClone(initial);
    for (const [key, value] of Object.entries(provided))
        result[key] = Object.hasOwn(result, key) ? mergeFixtureState(result[key], value) : structuredClone(value);
    return result;
}
function verifyPackageTree(pkg, session, verified = new Set(), active = new Set()) {
    if (verified.has(pkg.packageDigest))
        return;
    if (active.has(pkg.packageDigest))
        reject('DEPENDENCY_CYCLE', 409, 'package dependency cycle');
    active.add(pkg.packageDigest);
    for (const imp of pkg.source.imports) {
        const dep = session.packages.get(imp.package_digest);
        if (!dep)
            reject('DEPENDENCY_MISSING', 409, 'exact package dependency is missing');
        verifyPackageTree(dep, session, verified, active);
    }
    const baseline = compileRaw(pkg, pkg.lock.baseline_bindings, session, []);
    if (baseline.protocolDigest !== pkg.lock.output_protocol_digest)
        reject('DEPENDENCY_MISMATCH', 409, 'package baseline lock output digest mismatch');
    const results = baseline.fixtureResults;
    if (results.some(result => !result.passed))
        reject('EXAMPLE_FAILED', 409, `package ${pkg.metadata.package_id} fixture validation failed`);
    session.baselineReports.set(pkg.packageDigest, results);
    active.delete(pkg.packageDigest);
    verified.add(pkg.packageDigest);
}
export function compileProtocolPackage(value, options) {
    const root = packageValue(value), compilerVersion = options.compilerVersion ?? root.lock.compiler_version;
    if (![PROTOCOL_COMPILER_VERSION, PROTOCOL_COMPILER_VERSION_V3].includes(compilerVersion) || root.lock.compiler_version !== compilerVersion)
        reject('FORMAT_UNSUPPORTED', 409, 'unsupported package compiler version');
    const { packages, closure } = loadClosure(root, options.loadExactPackage), session = { packages, closure, steps: 0, sourceMap: {}, baselineReports: new Map() };
    for (const pkg of packages.values()) {
        if (![PROTOCOL_COMPILER_VERSION, PROTOCOL_COMPILER_VERSION_V3].includes(pkg.lock.compiler_version) || pkg.source.format === PROTOCOL_SOURCE_FORMAT_V2 && pkg.lock.compiler_version !== PROTOCOL_COMPILER_VERSION_V3 || compilerVersion === PROTOCOL_COMPILER_VERSION && pkg.lock.compiler_version !== PROTOCOL_COMPILER_VERSION)
            reject('FORMAT_UNSUPPORTED', 409, 'dependency requires unsupported compiler version');
    }
    verifyPackageTree(root, session);
    const supplied = options.bindings ?? root.lock.baseline_bindings, compiled = compileRaw(root, supplied, session, []), fixtureResults = compiled.fixtureResults, passed = fixtureResults.every(result => result.passed);
    const bindingDigest = hash(canonical(compiled.values)), lock = compilerLockSchema.parse({ format: 'peerwork.compilation-lock.v1', compiler_version: compilerVersion, semantics: SEMANTICS, root_package_digest: root.packageDigest, dependencies: root.source.imports.map(item => ({ alias: item.alias, package_digest: item.package_digest, namespace: item.namespace })), bindings: compiled.values, source_digest: compiled.sourceDigest, protocol_digest: compiled.protocolDigest });
    const unresolvedRequiredInputs = compiled.unresolvedInputs.filter(input => input.required);
    return { packageDigest: root.packageDigest, sourceDigest: compiled.sourceDigest, protocolDigest: compiled.protocolDigest, manifest: compiled.manifest, packageClosure: closure, dependencyClosure: compiled.dependencyClosure, resolvedDependencyManifests: compiled.resolvedDependencyManifests, sourceMap: compiled.sourceMap, unresolvedInputs: compiled.unresolvedInputs, unresolvedRequiredInputs, interfacesComplete: unresolvedRequiredInputs.length === 0, lock, bindingDigest, fixtureResults, passed, validation: { compilerVersion, semantics: SEMANTICS, checkedPackages: packages.size, fixtureCount: fixtureResults.length, baselineLockVerified: true, passed: passed && [...session.baselineReports.values()].every(rows => rows.every(result => result.passed)) } };
}
// Authoring preview derives the runtime digest before release.lock.json is frozen.
// Catalog publication must use compileProtocolPackage, which also verifies every baseline lock.
export function previewProtocolPackage(value, options) {
    const root = packageValue(value), compilerVersion = options.compilerVersion ?? root.lock.compiler_version;
    if (![PROTOCOL_COMPILER_VERSION, PROTOCOL_COMPILER_VERSION_V3].includes(compilerVersion) || root.lock.compiler_version !== compilerVersion)
        reject('FORMAT_UNSUPPORTED', 409, 'unsupported package compiler version');
    const { packages, closure } = loadClosure(root, options.loadExactPackage), session = { packages, closure, steps: 0, sourceMap: {}, baselineReports: new Map() };
    for (const pkg of packages.values()) {
        if (![PROTOCOL_COMPILER_VERSION, PROTOCOL_COMPILER_VERSION_V3].includes(pkg.lock.compiler_version) || pkg.source.format === PROTOCOL_SOURCE_FORMAT_V2 && pkg.lock.compiler_version !== PROTOCOL_COMPILER_VERSION_V3 || compilerVersion === PROTOCOL_COMPILER_VERSION && pkg.lock.compiler_version !== PROTOCOL_COMPILER_VERSION)
            reject('FORMAT_UNSUPPORTED', 409, 'dependency requires unsupported compiler version');
    }
    for (const imported of root.source.imports) {
        const dependency = packages.get(imported.package_digest);
        if (!dependency)
            reject('DEPENDENCY_MISSING', 409, 'exact package dependency is missing');
        verifyPackageTree(dependency, session);
    }
    const compiled = compileRaw(root, options.bindings ?? root.lock.baseline_bindings, session, []), fixtureResults = compiled.fixtureResults, passed = fixtureResults.every(result => result.passed);
    const unresolvedRequiredInputs = compiled.unresolvedInputs.filter(input => input.required);
    return { preview: true, packageDigest: root.packageDigest, sourceDigest: compiled.sourceDigest, protocolDigest: compiled.protocolDigest, manifest: compiled.manifest, packageClosure: closure, dependencyClosure: compiled.dependencyClosure, resolvedDependencyManifests: compiled.resolvedDependencyManifests, sourceMap: compiled.sourceMap, unresolvedInputs: compiled.unresolvedInputs, unresolvedRequiredInputs, interfacesComplete: unresolvedRequiredInputs.length === 0, bindingDigest: hash(canonical(compiled.values)), fixtureResults, passed, validation: { compilerVersion, semantics: SEMANTICS, checkedPackages: packages.size, fixtureCount: fixtureResults.length, baselineLockVerified: false, passed: false } };
}
export function assertPublishableCompilation(result) { if (('preview' in result) || !result.validation.baselineLockVerified || !result.validation.passed || !result.passed)
    reject('EXAMPLE_FAILED', 409, 'protocol package validation failed'); return result; }
export function assertExecutableCompilation(result) { if (!result.interfacesComplete)
    reject('COMPOSITION_CONFLICT', 409, 'protocol package has unresolved required interface inputs'); return result; }
