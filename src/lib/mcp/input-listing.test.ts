import { afterEach, expect, it, vi } from 'vitest';
import { buildOpenApiDocument } from '@/lib/api/openapi';
import { assertObligations, documentedTools, type Contract } from './contract-oracle';
import { testClient } from './test-client';
afterEach(() => vi.unstubAllGlobals());
it('the received whole-set listing preserves every parameter and required JSON body obligation', async () => {
  let dispatches = 0;
  const client = await testClient(() => { dispatches++; return Response.json({}); });
  try {
    const { tools } = await client.listTools();
    const document = buildOpenApiDocument();
    const operations = documentedTools(document);
    expect(tools.map(t => t.name).sort()).toEqual(operations.map(({ operation }) => operation['x-tool']).sort());
    for (const { operation } of operations) {
      const listed = tools.find(t => t.name === operation['x-tool'])!;
      for (const parameter of operation.parameters as Contract[] ?? []) {
        const name = (parameter['x-tool-name'] ?? parameter.name) as string;
        assertObligations(parameter.schema, listed.inputSchema.properties?.[name], document.components.schemas, `${listed.name}/${name}`);
        if (parameter.required || parameter.in === 'path') expect(listed.inputSchema.required, listed.name).toContain(name);
      }
      const body = operation.requestBody as { required?: boolean; content?: Record<string, { schema?: unknown }> } | undefined;
      const schema = body?.content?.['application/json']?.schema;
      if (schema) assertObligations(schema, body?.required ? listed.inputSchema : (listed.inputSchema.anyOf as unknown[])[1], document.components.schemas, listed.name);
      if (body?.content?.['multipart/form-data']) {
        expect(operation['x-tool-input']).toEqual({ multipart: { field: 'file', filename: 'filename', content: 'content_base64' } });
        expect(listed.inputSchema.required).toEqual(expect.arrayContaining(['filename', 'content_base64']));
        expect(listed.inputSchema.properties?.file).toBeUndefined();
      }
    }
    expect(dispatches).toBe(0);
  } finally { await client.close(); }
});
