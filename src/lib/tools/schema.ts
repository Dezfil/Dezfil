export type JsonSchema = boolean | { [key: string]: unknown };

/** Resolve only schema positions, never data held in enum/default/examples.
 * A reference and its siblings are an intersection, as in JSON Schema 2020-12.
 * Composition remains composition; the field index is for discoverability.
 */
export function resolveRefs(node: unknown, schemas: Record<string, unknown>, trail: string[] = []): JsonSchema {
  if (typeof node === 'boolean') return node;
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid JSON Schema declaration');
  const source = node as Record<string, unknown>;
  if (typeof source.$ref === 'string') {
    const ref = source.$ref;
    if (!ref.startsWith('#/components/schemas/') || trail.includes(ref)) throw new Error(`Unresolvable or cyclic $ref: ${ref}`);
    const name = ref.slice('#/components/schemas/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
    const { $ref: _, ...siblings } = source;
    void _;
    const target = resolveRefs(schemas[name], schemas, [...trail, ref]);
    return Object.keys(siblings).length ? intersect([target, resolveRefs(siblings, schemas, trail)]) : target;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (['properties', 'patternProperties', '$defs', 'dependentSchemas'].includes(key)) {
      result[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, resolveRefs(child, schemas, trail)]));
    } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
      if (!Array.isArray(value)) throw new Error(`Invalid schema ${key}`);
      result[key] = value.map(child => resolveRefs(child, schemas, trail));
    } else if (['items', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'additionalProperties', 'unevaluatedProperties'].includes(key)) {
      result[key] = resolveRefs(value, schemas, trail);
    } else result[key] = value;
  }
  if (result.nullable === true && typeof result.type === 'string') {
    result.type = [result.type, 'null'];
    delete result.nullable;
  }
  if (Array.isArray(result.allOf)) {
    const { allOf, ...own } = result;
    return intersect([own, ...allOf as JsonSchema[]]);
  }
  return result;
}

/** Keep each conjunct intact, with a conservative property/required index.
 * Duplicate properties intersect rather than letting a later member win.
 */
function intersect(parts: JsonSchema[]): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const part of parts) {
    if (typeof part === 'boolean') continue;
    for (const [key, value] of Object.entries(part.properties as Record<string, unknown> ?? {})) {
      properties[key] = key in properties ? { allOf: [properties[key], value] } : value;
    }
    for (const key of part.required as string[] ?? []) required.add(key);
  }
  const objectIndex = Object.keys(properties).length || required.size;
  return { ...(objectIndex ? { ...(parts.some(part => typeof part === 'object' && part.type === 'object') ? { type: 'object' } : {}), properties, ...(required.size ? { required: [...required] } : {}) } : {}), allOf: parts };
}
