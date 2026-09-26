/** Independent test oracle. No imports from tool/schema projection.
 * Walk every declared validation keyword at its data location. allOf is an
 * intersection at that location; alternative branches retain their identity.
 * Fixture validation separately proves interactions between those keywords.
 */
export type Contract = Record<string, unknown>;
export function documentedTools(document: { paths: unknown }) {
  return Object.entries(document.paths as Record<string, Contract>).flatMap(([path, methods]) =>
    Object.entries(methods).filter(([method]) => /^(get|post|put|patch|delete)$/.test(method))
      .map(([method, value]) => ({ path, method, operation: value as Contract }))
      .filter(({ operation }) => operation['x-tool'] !== false));
}
const annotations = new Set(['description', 'title', 'default', 'examples', 'example', 'deprecated', 'readOnly', 'writeOnly', '$schema', '$id']);
export function obligations(schema: unknown, components: Contract = {}, at = '$', trail: string[] = []): string[] {
  if (typeof schema === 'boolean') return [`${at}=${schema}`];
  if (!schema || typeof schema !== 'object') throw new Error(`Invalid schema at ${at}`);
  const result: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (annotations.has(key) || key.startsWith('x-')) continue;
    if (key === '$ref') {
      if (typeof value !== 'string' || !value.startsWith('#/components/schemas/') || trail.includes(value)) throw new Error(`Invalid reference at ${at}`);
      const name = value.slice('#/components/schemas/'.length);
      result.push(...obligations(components[name], components, at, [...trail, value]));
    } else if (['properties', 'patternProperties', '$defs', 'dependentSchemas'].includes(key)) {
      for (const [name, child] of Object.entries(value as Contract)) result.push(...obligations(child, components, `${at}/${key}/${name}`, trail));
    } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
      (value as unknown[]).forEach((child, index) => result.push(...obligations(child, components, key === 'allOf' ? at : `${at}/${key}/${index}`, trail)));
    } else if (['items', 'contains', 'not', 'if', 'then', 'else', 'propertyNames'].includes(key) || (['additionalProperties', 'unevaluatedProperties'].includes(key) && typeof value === 'object')) {
      result.push(...obligations(value, components, `${at}/${key}`, trail));
    } else if (key === 'required') {
      for (const name of value as string[]) result.push(`${at}/required=${JSON.stringify(name)}`);
    } else {
      result.push(`${at}/${key}=${JSON.stringify(value)}`);
    }
  }
  return [...new Set(result)].sort();
}
export function assertObligations(source: unknown, wire: unknown, components: Contract = {}, location = '$') {
  const offered = new Set(obligations(wire));
  for (const item of obligations(source, components)) {
    if (!offered.has(item)) throw new Error(`${location}: lost ${item}`);
  }
}
export function assertFacts(source: Contract, listed: Contract) {
  const effects = source['x-effects'] as Contract;
  const declared = source['x-mcp'] as Contract | undefined;
  if (!declared) throw new Error('Missing x-mcp declaration');
  const actual = listed.annotations as Contract;
  for (const [key, value] of Object.entries({ readOnlyHint: effects.readOnly, ...declared })) {
    if (key.endsWith('Hint') && actual?.[key] !== value) throw new Error(`Incorrect ${key}`);
  }
}
