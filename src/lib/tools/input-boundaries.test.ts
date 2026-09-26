import { describe, expect, it } from 'vitest';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { projectInput } from './input-schema';

async function accepts(schema: unknown, value: unknown) {
  return !(await fromJsonSchema(schema as Parameters<typeof fromJsonSchema>[0])['~standard'].validate(value)).issues;
}
const cases: [string, unknown, unknown, unknown][] = [
  ['string pattern', { type: 'string', pattern: '^a+$' }, 'aa', 'ab'],
  ['known format', { type: 'string', format: 'uuid' }, '123e4567-e89b-12d3-a456-426614174000', 'wrong'],
  ['string maximum', { type: 'string', maxLength: 2 }, 'aa', 'aaa'],
  ['array minimum', { type: 'array', items: { type: 'integer' }, minItems: 1 }, [0], []],
  ['array maximum', { type: 'array', items: { type: 'integer' }, maxItems: 1 }, [0], [0, 1]],
  ['unique array', { type: 'array', items: { type: 'integer' }, uniqueItems: true }, [0, 1], [0, 0]],
  ['nested array item', { type: 'array', items: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 } } }, [[1]], [[0]]],
  ['nullable', { type: ['string', 'null'] }, null, 0],
  ['legacy nullable', { type: 'string', nullable: true }, null, 0],
  ['conditional', { type: 'object', properties: { kind: { type: 'string' }, value: {} }, if: { properties: { kind: { const: 'number' } }, required: ['kind'] }, then: { properties: { value: { type: 'number' } } }, else: { properties: { value: { type: 'string' } } } }, { kind: 'number', value: 0 }, { kind: 'number', value: '0' }],
];
describe('boundary-valid and invalid values', () => {
  for (const [label, value, good, bad] of cases) it(label, async () => {
    const { inputSchema } = projectInput({ requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { value }, required: ['value'] } } } } }, {}, label);
    expect(await accepts(inputSchema, { value: good })).toBe(true);
    expect(await accepts(inputSchema, { value: bad })).toBe(false);
    expect(await accepts(inputSchema, {})).toBe(false);
  });
  it('alternative properties do not narrow each other', async () => {
    const { inputSchema } = projectInput({ requestBody: { required: true, content: { 'application/json': { schema: {
      oneOf: [ { properties: { value: { type: 'string' } }, required: ['value'] }, { properties: { value: { type: 'integer' } }, required: ['value'] } ],
    } } } } }, {}, 'alternatives');
    expect(await accepts(inputSchema, { value: 'ok' })).toBe(true);
    expect(await accepts(inputSchema, { value: 0 })).toBe(true);
    expect(await accepts(inputSchema, { value: false })).toBe(false);
  });
  it('closed branches admit path/group arguments while bounding only body fields', async () => {
    const { inputSchema } = projectInput({ parameters: [
      { name: 'id', in: 'path', schema: { type: 'string' } },
      { name: 'group', in: 'header', schema: { type: 'string' } },
    ], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', allOf: [{ properties: { value: { type: 'integer' } }, additionalProperties: false, minProperties: 1, maxProperties: 1, propertyNames: { pattern: '^value$' } }] } } } } }, {}, 'closure');
    for (const extra of [{ id: 'a' }, { id: 'a', group: 'g' }]) {
      expect(await accepts(inputSchema, { ...extra, value: 0 })).toBe(true);
      expect(await accepts(inputSchema, { ...extra, value: 0, unknown: 1 })).toBe(false);
      expect(await accepts(inputSchema, extra)).toBe(false);
    }
  });
});
