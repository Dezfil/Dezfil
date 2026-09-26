import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '@/lib/api/openapi';
import { buildTools } from '@/lib/tools/tools';
import { assertFacts, assertObligations, documentedTools, obligations } from './contract-oracle';

describe('independent whole-set oracle controls', () => {
  it('traverses every exposed operation and all success declarations, preserving existing inventories', () => {
    const document = buildOpenApiDocument();
    const operations = documentedTools(document);
    expect(operations.map(({ operation }) => operation['x-tool']).sort()).toEqual(buildTools().map(t => t.name).sort());
    for (const { path, operation } of operations) {
      const successes = Object.entries(operation.responses as Record<string, unknown>).filter(([status]) => /^2\d\d$/.test(status));
      expect(successes.length, path).toBeGreaterThan(0);
      for (const [, response] of successes) {
        const content = (response as { content?: Record<string, { schema?: unknown }> }).content ?? {};
        for (const declaration of Object.values(content)) {
          if (declaration.schema) expect(() => obligations(declaration.schema, document.components.schemas)).not.toThrow();
        }
      }
    }
  });
  for (const [keyword, value] of Object.entries({ minimum: 2, maximum: 8, enum: [2, 4], required: ['x'], minLength: 2, pattern: '^x', format: 'uuid', maxItems: 4 })) {
    it(`rejects a seeded dropped ${keyword}, after a conforming input control`, () => {
      const source = { type: 'object', properties: { x: { [keyword]: value } } };
      expect(() => assertObligations(source, structuredClone(source))).not.toThrow();
      expect(() => assertObligations(source, { type: 'object', properties: { x: {} } })).toThrow(`/${keyword}=`);
    });
  }
  it('detects a lost intersection even when the overlapping property remains', () => {
    const source = { allOf: [{ properties: { x: { minimum: 2 } } }, { properties: { x: { maximum: 8 } } }] };
    expect(() => assertObligations(source, { properties: { x: { minimum: 2, maximum: 8 } } })).not.toThrow();
    expect(() => assertObligations(source, { properties: { x: { maximum: 8 } } })).toThrow('/minimum=2');
  });
  it('detects a dropped success branch', () => {
    const source = { anyOf: [{ type: 'object' }, { type: 'array', items: { type: 'string' } }] };
    expect(() => assertObligations(source, structuredClone(source))).not.toThrow();
    expect(() => assertObligations(source, { anyOf: [{ type: 'object' }] })).toThrow('/anyOf/1/');
  });
  it('detects missing and wrong nonempty hints independently of method and confirmation', () => {
    const source = { 'x-effects': { readOnly: true }, 'x-mcp': { destructiveHint: false, openWorldHint: true } };
    const listing = { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } };
    expect(() => assertFacts(source, listing)).not.toThrow();
    expect(() => assertFacts({ 'x-effects': { readOnly: true } }, listing)).toThrow('Missing');
    expect(() => assertFacts(source, { annotations: { ...listing.annotations, destructiveHint: true } })).toThrow('destructiveHint');
    expect(() => assertFacts(source, { annotations: { ...listing.annotations, readOnlyHint: false } })).toThrow('readOnlyHint');
  });
});
