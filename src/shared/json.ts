export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonPath = (string | number)[];
export const JSON_LIMITS = { depth: 64, nodes: 20_000, bytes: 1_048_576 };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

export function checkJson(value: unknown): asserts value is Json {
  let nodes = 0;
  let bytes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > JSON_LIMITS.nodes || depth > JSON_LIMITS.depth) throw new Error('JSON exceeds 64 levels or 20,000 values.');
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (typeof item === 'string') { bytes += item.length; }
    else if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); }
    else if (typeof item === 'object' && item && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      for (const [key, child] of Object.entries(item)) { bytes += key.length; visit(child, depth + 1); }
    } else throw new Error('Invalid JSON value.');
    if (bytes > JSON_LIMITS.bytes) throw new Error('JSON exceeds the size limit.');
  };
  visit(value, 0);
}

export function formatPath(path: JsonPath): string {
  return path.reduce<string>((text, part) => typeof part === 'number' ? `${text}[${part}]`
    : /^[A-Za-z_$][\w$]*$/.test(part) ? `${text}.${part}` : `${text}[${JSON.stringify(part)}]`, '$');
}

export function parsePath(value: string): JsonPath {
  if (!value || value.length > 2048) throw new Error('Path is empty or too long.');
  const source = value.startsWith('$') ? value.slice(1) : `.${value}`;
  const parts: JsonPath = [];
  const token = /(?:\.([A-Za-z_$][\w$]*)|\[(0|[1-9]\d*|"(?:\\.|[^"\\])*")\])/y;
  let offset = 0;
  while (offset < source.length) {
    token.lastIndex = offset;
    const match = token.exec(source);
    if (!match) throw new Error('Invalid path. Use $.campo[0] or $["nome.com.ponto"].');
    const part: string | number = match[1] ?? JSON.parse(match[2]!) as string | number;
    if (typeof part === 'string' && forbidden.has(part)) throw new Error('Reserved properties cannot be changed.');
    if (typeof part === 'number' && (!Number.isSafeInteger(part) || part > JSON_LIMITS.nodes)) throw new Error('Invalid index.');
    parts.push(part); offset = token.lastIndex;
  }
  if (!parts.length || parts.length > JSON_LIMITS.depth) throw new Error('Provide a property path with up to 64 levels.');
  return parts;
}

export interface TransformOperation { id: string; enabled: boolean; type: 'set' | 'delete' | 'rename'; path: string; value?: Json; name?: string }
export interface TransformResult { value?: Json; error?: { step: number; message: string } }

export function validateOperations(value: unknown): asserts value is TransformOperation[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Use up to 100 operations.');
  const ids = new Set<string>();
  for (const op of value as TransformOperation[]) {
    if (!op || typeof op.id !== 'string' || op.id.length > 100 || ids.has(op.id) || typeof op.enabled !== 'boolean'
      || !['set', 'delete', 'rename'].includes(op.type) || typeof op.path !== 'string') throw new Error('Invalid or duplicate operation.');
    ids.add(op.id); parsePath(op.path);
    if (op.type === 'set') checkJson(op.value);
    if (op.type === 'rename' && (typeof op.name !== 'string' || !op.name || op.name.length > 1024 || forbidden.has(op.name))) throw new Error('Invalid new name.');
  }
}

export function transform(original: unknown, operations: TransformOperation[]): TransformResult {
  let step = 0;
  try {
    checkJson(original);
    const result = JSON.parse(JSON.stringify(original)) as Json;
    if (operations.length > 100) throw new Error('Use up to 100 operations.');
    for (const [index, op] of operations.entries()) {
      step = index + 1;
      validateOperations([op]);
      if (!op.enabled) continue;
      const path = parsePath(op.path);
      const key = path.pop()!;
      let parent: Json = result;
      for (const part of path) {
        if (!parent || typeof parent !== 'object' || (Array.isArray(parent) ? typeof part !== 'number' : typeof part !== 'string')
          || !Object.hasOwn(parent, part)) throw new Error('Missing or incompatible parent property.');
        parent = (parent as Record<string | number, Json>)[part]!;
      }
      if (!parent || typeof parent !== 'object') throw new Error('The destination is not an object or array.');
      if (Array.isArray(parent)) {
        if (typeof key !== 'number' || key > parent.length) throw new Error('Use an existing index, or the next index to append.');
        if (op.type === 'rename') throw new Error('Rename supports object properties, not array indices.');
        if (op.type === 'delete') {
          if (key >= parent.length) throw new Error('Missing index.');
          parent.splice(key, 1);
        } else parent[key] = JSON.parse(JSON.stringify(op.value)) as Json;
      } else {
        if (typeof key !== 'string') throw new Error('Use an object property.');
        if (op.type !== 'set' && !Object.hasOwn(parent, key)) throw new Error('Missing property.');
        if (op.type === 'rename') {
          if (Object.hasOwn(parent, op.name!)) throw new Error('The new name already exists.');
          Object.defineProperty(parent, op.name!, { value: parent[key], enumerable: true, configurable: true, writable: true });
          delete parent[key];
        } else if (op.type === 'delete') delete parent[key];
        else Object.defineProperty(parent, key, { value: JSON.parse(JSON.stringify(op.value)) as Json, enumerable: true, configurable: true, writable: true });
      }
      checkJson(result);
    }
    return { value: result };
  } catch (error) { return { error: { step, message: error instanceof Error ? error.message : 'Invalid transformation.' } }; }
}
