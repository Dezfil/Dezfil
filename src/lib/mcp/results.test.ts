import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromJsonSchema } from '@modelcontextprotocol/server';

vi.mock('@/lib/api/openapi', () => {
  const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
  const cases = {
    object: { '200': json({ type: 'object', properties: { count: { type: 'integer', minimum: 0 } }, required: ['count'], additionalProperties: false }) },
    array: { '200': json({ type: 'array', items: { type: 'integer' }, minItems: 1 }) },
    scalar: { '200': json({ type: 'number', minimum: 1 }) },
    empty: { '204': { description: 'Empty.' } },
    accepted: { '202': json({ type: 'object', properties: { run: { type: 'object', properties: { id: { type: 'string' }, state: { const: 'queued' } }, required: ['id', 'state'] } }, required: ['run'] }) },
    text: { '200': { content: { 'text/plain': { schema: { type: 'string', minLength: 1 } } } } },
    attachment: { '200': { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
    image: { '200': { content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } } },
    multi: { '200': json({ type: 'array', items: { type: 'string' } }), '202': json({ type: 'object', properties: { job: { type: 'string' } }, required: ['job'] }) },
  };
  return { buildOpenApiDocument: () => ({ components: { schemas: {} }, paths: Object.fromEntries(Object.entries(cases).map(([name, responses]) => [`/${name}`, { get: {
    'x-tool': name, 'x-display': { verb: `Read ${name}` }, 'x-effects': { readOnly: true, writes: [] },
    'x-mcp': { destructiveHint: false, openWorldHint: false, idempotentHint: true },
    'x-tool-output': { envelope: 'result-history', ...(name === 'attachment' || name === 'image' ? { binary: { representation: 'attachment', nativeImage: name === 'image' } } : {}) },
    responses,
  } }])) }) };
});
import { buildTools } from '@/lib/tools/tools';
import { testClient } from './test-client';
afterEach(() => vi.unstubAllGlobals());
const values: Record<string, unknown> = { object: { count: 0 }, array: [1, 2], scalar: 2, empty: null, accepted: { run: { id: 'job-0207', state: 'queued' } }, text: 'hello', multi: { job: 'accepted-0207' } };
const invalid: Record<string, unknown> = { object: { count: -1 }, array: [], scalar: 0, empty: {}, accepted: { run: { state: 'complete' } }, text: '', multi: false };
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
function response(name: string) {
  if (['attachment', 'image'].includes(name)) return new Response(bytes, { headers: { 'content-type': name === 'image' ? 'image/png' : 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.bin"' } });
  if (name === 'empty') return new Response(null, { status: 204 });
  if (name === 'text') return new Response('hello', { headers: { 'content-type': 'text/plain' } });
  return Response.json(values[name], { status: name === 'accepted' || name === 'multi' ? 202 : 200 });
}

describe('structured response classes and unchanged legacy consumers', () => {
  for (const name of Object.keys(values)) {
    it(`${name}: output schema accepts the independent value and refuses the invalid value`, async () => {
      const schema = (buildTools().find(tool => tool.name === name) as unknown as { outputSchema?: unknown }).outputSchema;
      expect(schema).toBeDefined();
      const validator = fromJsonSchema(schema as Parameters<typeof fromJsonSchema>[0]);
      expect((await validator['~standard'].validate({ result: values[name], history: null })).issues).toBeUndefined();
      expect((await validator['~standard'].validate({ result: invalid[name], history: null })).issues).toBeDefined();
    });
    it(`${name}: legacy text and additive structured results agree`, async () => {
      const client = await testClient(request => response(new URL(request.url).pathname.slice(1)));
      try {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.isError ?? false).toBe(false);
        const text = (result.content as { text: string }[])[0].text;
        expect(name === 'text' ? text : JSON.parse(text)).toEqual(values[name]);
        expect(result.structuredContent).toEqual({ result: values[name], history: null });
      } finally { await client.close(); }
    });
  }
  for (const name of ['attachment', 'image']) it(`${name}: metadata points to exact bytes without a third copy`, async () => {
    const client = await testClient(() => response(name));
    try {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError ?? false).toBe(false);
      const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
      const legacy = JSON.parse(content[0].text!).attachment;
      expect(Buffer.from(legacy.content_base64, 'base64')).toEqual(Buffer.from(bytes));
      const meta = (result.structuredContent as { result: { attachment: Record<string, unknown> } }).result.attachment;
      expect(meta).toEqual({ filename: 'fixture.bin', content_type: name === 'image' ? 'image/png' : 'application/octet-stream', size_bytes: bytes.length,
        content: name === 'image' ? { index: 1, type: 'image', field: 'data' } : { index: 0, type: 'text', jsonPointer: '/attachment/content_base64' } });
      expect(JSON.stringify(result.structuredContent)).not.toContain(legacy.content_base64);
      if (name === 'image') expect(content[1]).toEqual({ type: 'image', data: legacy.content_base64, mimeType: 'image/png' });
      expect(JSON.stringify(result).split(legacy.content_base64)).toHaveLength(name === 'image' ? 3 : 2);
    } finally { await client.close(); }
  });
});
