import { afterEach, expect, it, vi } from 'vitest';
import { buildOpenApiDocument } from '@/lib/api/openapi';
import { assertObligations, documentedTools, type Contract } from './contract-oracle';
import { testClient } from './test-client';
afterEach(() => vi.unstubAllGlobals());
it('every success status documents content or explicitly returns no content', () => {
  const missing: string[] = [];
  for (const { operation } of documentedTools(buildOpenApiDocument())) {
    for (const [status, response] of Object.entries(operation.responses as Record<string, { content?: Record<string, unknown> }>)) {
      if (/^2\d\d$/.test(status) && status !== '204' && !response.content) missing.push(`${operation['x-tool']}/${status}`);
    }
  }
  expect(missing).toEqual([]);
});
it('the received whole-set listing retains all declared success schema families', async () => {
  const client = await testClient(() => { throw new Error('Listing dispatched a product call'); });
  try {
    const { tools } = await client.listTools();
    const document = buildOpenApiDocument();
    for (const { operation } of documentedTools(document)) {
      const listed = tools.find(tool => tool.name === operation['x-tool'])!;
      expect(listed.outputSchema?.required, listed.name).toEqual(['result', 'history']);
      const binary = (operation['x-tool-output'] as { binary?: { representation: string } }).binary;
      const branches: unknown[] = [];
      for (const [status, response] of Object.entries(operation.responses as Record<string, { content?: Record<string, { schema?: Contract }> }>)) {
        if (!/^2\d\d$/.test(status)) continue;
        if (status === '204') branches.push({ type: 'null' });
        for (const { schema } of Object.values(response.content ?? {})) {
          if (schema?.format === 'binary' || binary?.representation === 'json-image') continue;
          branches.push(schema);
        }
      }
      const outputProperties = listed.outputSchema?.properties as Record<string, unknown>;
      const result = outputProperties.result as Contract;
      // Binary branches have a separately declared, independently fixture-tested adaptation.
      const available = result.anyOf as unknown[] ?? [result];
      for (const source of branches) {
        expect(available.some(candidate => { try { assertObligations(source, candidate, document.components.schemas, listed.name); return true; } catch { return false; } }), listed.name).toBe(true);
      }
      expect(outputProperties.history).toBeDefined();
    }
  } finally { await client.close(); }
});
it.each(['export_sql_result', 'export_project'])('%s documents its existing prepared JSON response', name => {
  const operation = documentedTools(buildOpenApiDocument()).find(row => row.operation['x-tool'] === name)!.operation;
  const response = (operation.responses as Record<string, { content: Record<string, { schema: unknown }> }>)['200'];
  expect(response.content['application/json']?.schema).toBeDefined();
  expect(operation['x-mcp']).toMatchObject({ idempotentHint: false });
});
