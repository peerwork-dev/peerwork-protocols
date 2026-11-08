import { ApiError } from './errors.js';
// Validate syntax with the platform parser, then reject duplicate member names,
// including escaped equivalents, before any authorization or mutation consumes it.
export function parseJson(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        throw new ApiError('INVALID_JSON', 400);
    }
    const stack = [];
    for (const token of text.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|[^\s{}\[\],:]+/gs) ?? []) {
        if (token === '{' || token === '[') {
            stack.push({ object: token === '{', key: token === '{', names: new Set() });
            continue;
        }
        if (token === '}' || token === ']') {
            stack.pop();
            continue;
        }
        const frame = stack.at(-1);
        if (!frame?.object)
            continue;
        if (token === ',') {
            frame.key = true;
            continue;
        }
        if (token === ':') {
            frame.key = false;
            continue;
        }
        if (frame.key && token.startsWith('"')) {
            const name = JSON.parse(token);
            if (frame.names.has(name))
                throw new ApiError('DUPLICATE_JSON_KEY', 400);
            frame.names.add(name);
            frame.key = false;
        }
    }
    return value;
}
