import { describe, expect, it } from 'vitest';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { buildOpenApiDocument } from '@/lib/api/openapi';
import { buildTools, deriveTools } from './tools';
import { documentedTools, assertObligations } from '@/lib/mcp/contract-oracle';

function fixture(schema: unknown, components = {}) {
  return deriveTools({ components: { schemas: components }, paths: { '/fixture': { post: {
    'x-tool-output': { envelope: 'result-history' }, 'x-tool': 'fixture', 'x-display': { verb: 'Read a fixture' },
    'x-effects': { readOnly: true, writes: [] },
    'x-mcp': { destructiveHint: false, openWorldHint: false, idempotentHint: true },
    requestBody: { required: true, content: { 'application/json': { schema } } },
    responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } },
  } } } } as unknown as ReturnType<typeof buildOpenApiDocument>)[0];
}
async function accepts(schema: unknown, value: unknown) {
  const result = await fromJsonSchema(schema as Parameters<typeof fromJsonSchema>[0])['~standard'].validate(value);
  return !result.issues;
}
const tool = (name: string) => buildTools().find(entry => entry.name === name)!;

describe('input losses, each independently red before projection repair', () => {
  it('every path/query parameter retains every documented keyword', () => {
    const document = buildOpenApiDocument();
    for (const { operation } of documentedTools(document)) {
      const generated = tool(operation['x-tool'] as string);
      for (const param of (operation.parameters ?? []) as { in: string; name: string; schema: unknown }[]) {
        if (!['path', 'query'].includes(param.in)) continue;
        assertObligations(param.schema, generated.inputSchema.properties[param.name], document.components.schemas, `${generated.name}/${param.name}`);
      }
    }
  });
  for (const [label, schema, good, bad] of [
    ['parameter integer', { type: 'integer', minimum: 0, maximum: 10 }, 0, '0'],
    ['parameter minimum', { type: 'integer', minimum: 0 }, 0, -1],
    ['parameter maximum', { type: 'integer', maximum: 10 }, 10, 11],
    ['parameter enum', { type: 'string', enum: ['a', 'b'] }, 'a', 'c'],
    ['parameter length', { type: 'string', minLength: 1 }, 'a', ''],
  ] as const) {
    it(label, async () => {
      const document = structuredClone(buildOpenApiDocument());
      const operation = documentedTools(document).find(row => row.operation['x-tool'] === 'get_map')!.operation;
      operation.parameters = [{ name: 'id', in: 'path', required: true, schema }];
      const generated = deriveTools(document).find(t => t.name === 'get_map')!;
      if (label === 'parameter minimum') expect(generated.inputSchema.properties.id).toHaveProperty('minimum', 0);
      if (label === 'parameter maximum') expect(generated.inputSchema.properties.id).toHaveProperty('maximum', 10);
      expect(await accepts(generated.inputSchema, { id: good })).toBe(true);
      expect(await accepts(generated.inputSchema, { id: bad })).toBe(false);
    });
  }
  for (const name of ['set_table_geometry', 'preview_table_geometry', 'preview_postgis_relation']) {
    it(`${name} retains body-root closure`, () => {
      expect(tool(name).inputSchema).toHaveProperty('additionalProperties', false);
    });
  }
  const intersecting = { type: 'object', properties: { n: { type: 'integer', minimum: 2 } }, required: ['n'], allOf: [{ properties: { n: { maximum: 4 } } }] };
  for (const position of ['root', 'nested', 'reference', 'array'] as const) {
    it(`intersection at ${position} retains both bounds`, async () => {
      const root = position === 'root' ? intersecting : { type: 'object', properties: { value: position === 'nested' ? intersecting : position === 'reference' ? { $ref: '#/components/schemas/Range' } : { type: 'array', items: { $ref: '#/components/schemas/Range' } } }, required: ['value'] };
      const generated = fixture(root, { Range: intersecting });
      const wrap = (n: number) => position === 'root' ? { n } : { value: position === 'array' ? [{ n }] : { n } };
      expect(await accepts(generated.inputSchema, wrap(2))).toBe(true);
      expect(await accepts(generated.inputSchema, wrap(1))).toBe(false);
      expect(await accepts(generated.inputSchema, wrap(5))).toBe(false);
    });
  }
  for (const position of ['root', 'nested', 'array'] as const) {
    it(`reference sibling at ${position} retains length`, async () => {
      const constrained = { $ref: '#/components/schemas/Text', minLength: 2 };
      const body = { type: 'object', properties: { value: position === 'array' ? { type: 'array', items: constrained } : constrained }, required: ['value'] };
      const generated = fixture(position === 'root' ? { $ref: '#/components/schemas/Body', properties: { value: constrained } } : body, { Text: { type: 'string', maxLength: 4 }, Body: { type: 'object', properties: { value: { type: 'string' } } } });
      const wrap = (value: string) => ({ value: position === 'array' ? [value] : value });
      expect(await accepts(generated.inputSchema, wrap('ok'))).toBe(true);
      expect(await accepts(generated.inputSchema, wrap('x'))).toBe(false);
      expect(await accepts(generated.inputSchema, wrap('large'))).toBe(false);
    });
  }
  it('closed composition members remain closed', async () => {
    const generated = fixture({ allOf: [{ type: 'object', properties: { n: { type: 'integer' } }, additionalProperties: false }] });
    expect(await accepts(generated.inputSchema, { n: 1 })).toBe(true);
    expect(await accepts(generated.inputSchema, { n: 1, lost: true })).toBe(false);
  });
  it('each documented history header becomes a bounded optional group input', async () => {
    const qualifying = buildTools().filter(entry => entry.effects.history);
    expect(qualifying.map(entry => entry.name).sort()).toEqual(['create_layer', 'delete_layer', 'duplicate_layer', 'update_layer', 'update_map']);
    for (const generated of qualifying) {
      const schema = generated.inputSchema.properties.change_group;
      expect(schema, generated.name).toBeDefined();
      expect(await accepts(schema, 'a_0-z')).toBe(true);
      for (const invalid of ['', 'a'.repeat(65), 'a b']) expect(await accepts(schema, invalid)).toBe(false);
      expect(generated.inputSchema.required ?? []).not.toContain('change_group');
    }
  });
});
