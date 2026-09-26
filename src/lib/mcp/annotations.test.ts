import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOpenApiDocument } from '@/lib/api/openapi';
import { deriveTools } from '@/lib/tools/tools';
import { assertFacts, documentedTools, type Contract } from './contract-oracle';
import { testClient } from './test-client';
afterEach(() => vi.unstubAllGlobals());
const independentCases = [
  ['run_sql', true, false, false],
  ['compute_fill', true, false, false],
  ['look_at_map', true, false, true],
  ['run_recipe', false, true, true],
  ['create_map', false, false, false],
  ['update_layer', false, true, false],
  ['update_map', false, true, true],
  ['delete_layer', false, true, false],
  ['publish_map', false, true, false],
  ['unpublish_map', false, true, false],
  ['run_operation', false, false, true],
  ['search_map', true, false, true],
  ['run_osm_query', true, false, true],
  // the two PostGIS catalogue reads record nothing about the
  // connection, so they list as reads; the probe that does record keeps
  // its destructive hint.
  ['list_postgis_tables', true, false, true],
  ['preview_postgis_relation', true, false, true],
  ['test_postgis_connection', false, true, true],
] as const;

describe('annotations follow factual declarations', () => {
  for (const [name, readOnlyHint, destructiveHint, openWorldHint] of independentCases) it(`${name}: independent effect/consequence/world expectations`, async () => {
    const client = await testClient(() => { throw new Error('Listing dispatched product work'); });
    try {
      const listed = (await client.listTools()).tools.find(t => t.name === name)!;
      expect(listed.annotations).toMatchObject({ readOnlyHint, destructiveHint, openWorldHint });
    } finally { await client.close(); }
  });
  it('every listing has exact declared hints and client confirmation metadata', async () => {
    const client = await testClient(() => { throw new Error('Listing dispatched product work'); });
    try {
      const { tools } = await client.listTools();
      for (const { operation } of documentedTools(buildOpenApiDocument())) {
        const listed = tools.find(t => t.name === operation['x-tool'])!;
        assertFacts(operation, listed as unknown as Contract);
        expect(listed._meta?.['dezfil/confirmation']).toEqual({ policy: operation['x-confirm'] === true ? 'required' : operation['x-confirm'] === 'when_wide' ? 'when_wide' : 'none', ...(operation['x-confirmation'] as object ?? {}) });
        expect(listed._meta?.['dezfil/effects']).toEqual(operation['x-effects']);
        expect(listed.description).not.toContain('Requires explicit user confirmation');
      }
    } finally { await client.close(); }
  });
  for (const corruption of ['missing', 'malformed'] as const) it(`refuses a ${corruption} declaration`, () => {
    const document = structuredClone(buildOpenApiDocument());
    const target = documentedTools(document).find(row => row.operation['x-tool'] === 'get_map')!.operation;
    target['x-mcp'] = { destructiveHint: false, openWorldHint: false, idempotentHint: true };
    expect(() => deriveTools(document)).not.toThrow();
    if (corruption === 'missing') delete target['x-mcp'];
    else target['x-mcp'] = { destructiveHint: 'no', openWorldHint: false };
    expect(() => deriveTools(document)).toThrow(/get_map.*x-mcp/);
  });
  it('a wrong nonempty destructive declaration fails the independent consequence assertion', () => {
    const document = structuredClone(buildOpenApiDocument());
    const target = documentedTools(document).find(row => row.operation['x-tool'] === 'update_layer')!.operation;
    const assertConsequence = () => expect(deriveTools(document).find(tool => tool.name === 'update_layer')!.mcp!.destructiveHint).toBe(true);
    assertConsequence();
    target['x-mcp'] = { destructiveHint: false, openWorldHint: false, idempotentHint: false };
    expect(assertConsequence).toThrow(/expected false to be true/);
  });
});
