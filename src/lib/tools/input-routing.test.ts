import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '@/lib/api/openapi';
import { deriveTools } from './tools';
import { executeTool } from './execute';

function fixture(upload = false) {
  return deriveTools({ components: { schemas: {} }, paths: { '/fixture/{id}': { post: {
    'x-tool-output': { envelope: 'result-history' }, 'x-tool': 'fixture', 'x-display': { verb: 'Read a fixture' }, 'x-effects': { readOnly: true, writes: [] },
    'x-mcp': { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: [
      { name: 'id', in: 'path', schema: { type: 'string' } },
      { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
      { name: 'enabled', in: 'query', schema: { type: 'boolean' } },
      { name: 'search', in: 'query', schema: { type: 'string' } },
      { name: 'X-Change-Group', in: 'header', 'x-tool-name': 'change_group', schema: { type: 'string', pattern: '^[\\w-]{1,64}$' } },
    ],
    ...(upload ? { 'x-tool-input': { multipart: { field: 'file', filename: 'filename', content: 'content_base64' } } } : {}),
    requestBody: { required: false, content: { [upload ? 'multipart/form-data' : 'application/json']: { schema: {
      type: 'object', properties: { value: { type: 'string' }, ...(upload ? { file: { type: 'string', format: 'binary' } } : {}) },
      ...(upload ? { required: ['file'] } : {}), additionalProperties: true,
    } } } }, responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } },
  } } } } as unknown as ReturnType<typeof buildOpenApiDocument>)[0];
}

describe('declared routing', () => {
  it('preserves zero, false and empty query values independently of omission', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetcher: typeof fetch = async (url, init) => { seen.push({ url: String(url), body: init?.body }); return Response.json({}); };
    await executeTool(fixture(), { id: 'a/b', offset: 0, enabled: false, search: '' }, 'http://localhost:3307', fetcher);
    expect(seen[0].url).toBe('http://localhost:3307/fixture/a%2Fb?offset=0&enabled=false&search=');
    await executeTool(fixture(), { id: 'a' }, 'http://localhost:3307', fetcher);
    expect(seen[1].url).toBe('http://localhost:3307/fixture/a');
    expect(seen[1].body).toBeUndefined();
  });
  it('forwards permitted extra body fields and declared headers to distinct locations', async () => {
    let sent: RequestInit | undefined;
    await executeTool(fixture(), { id: 'a', value: '', extra: false, change_group: 'external' }, 'http://localhost:3307', async (_url, init) => { sent = init; return Response.json({}); });
    expect(JSON.parse(String(sent?.body))).toEqual({ value: '', extra: false });
    expect(new Headers(sent?.headers).get('X-Change-Group')).toBe('external');
  });
  it('schema-invalid arguments dispatch nothing', async () => {
    const generated = fixture();
    let dispatched = 0;
    const result = await executeTool(generated, { id: 'a', offset: -1 }, 'http://localhost:3307', async () => { dispatched++; return Response.json({}); });
    expect(dispatched).toBe(0);
    expect(result).toMatchObject({ ok: false, body: { error: { code: 'invalid_request' } } });
  });
  it('multipart retains file bytes, requiredness and remaining fields', async () => {
    let sent: FormData | undefined;
    const generated = fixture(true);
    await executeTool(generated, { id: 'a', filename: 'fixture.csv', content_base64: 'eA==', value: 'kept' }, 'http://localhost:3307', async (_url, init) => { sent = init?.body as FormData; return Response.json({}); });
    expect(await (sent!.get('file') as File).text()).toBe('x');
    expect(sent!.get('value')).toBe('kept');
  });
});
