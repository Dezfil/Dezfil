import { afterEach, describe, expect, it, vi } from 'vitest';
import { testClient } from './test-client';
import * as executor from '@/lib/tools/execute';
import { ERROR_CATALOGUE } from '@/lib/api/error-catalogue';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { sanitizeFailure } from './errors';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const secret = '/private/seed/metadata.sqlite at frameThatMustNotEscape';
function decode(result: unknown) {
  const wire = result as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
  expect(wire.isError).toBe(true);
  expect(JSON.stringify(wire)).not.toContain(secret);
  const body = JSON.parse(wire.content[0].text);
  expect(wire.structuredContent).toEqual({ result: body, history: null });
  return body.error;
}
describe('coded known-tool errors', () => {
  it('schema-invalid input dispatches nothing and returns catalogue code/copy in both forms', async () => {
    let dispatched = 0;
    const client = await testClient(() => { dispatched++; return Response.json({}); });
    try {
      const error = decode(await client.callTool({ name: 'read_table_catalogue', arguments: { columns: -1 } }));
      expect(error).toEqual({ code: 'invalid_request', message: ERROR_CATALOGUE.invalid_request, issues: [{ message: expect.stringMatching(/columns.*>= 0/) }] });
      expect(dispatched).toBe(0);
    } finally { await client.close(); }
  });
  it('a missing required argument is named without dispatch', async () => {
    let dispatched = 0;
    const client = await testClient(() => { dispatched++; return Response.json({}); });
    try {
      const error = decode(await client.callTool({ name: 'get_map', arguments: {} }));
      expect(error.issues).toEqual([{ message: expect.stringMatching(/required property 'id'/) }]);
      expect(dispatched).toBe(0);
    } finally { await client.close(); }
  });
  it('coded failures conform to every listed output schema, including SQL and issue diagnostics', async () => {
    const client = await testClient(() => Response.json({ error: { code: 'sql_rejected', message: 'Only read-only SQL is allowed.', position: { line: 1, column: 1 } } }, { status: 400 }));
    try {
      const refusal = await client.callTool({ name: 'run_sql', arguments: { sql: 'DELETE FROM example' } });
      expect(decode(refusal).code).toBe('sql_rejected');
      const invalid = await client.callTool({ name: 'read_table_catalogue', arguments: { columns: -1 } });
      expect(decode(invalid).code).toBe('invalid_request');
      const issues = [
        { result: { error: { code: 'geometry_choice_invalid', message: 'Choose a projection.', issues: [{ code: 'projection_required', message: 'A projection is required.' }] } }, history: null },
        { result: { error: { code: 'invalid_request', message: ERROR_CATALOGUE.invalid_request, issues: [{ path: ['features', 0, 'geometry'], message: 'Expected an object.' }] } }, history: null },
      ];
      for (const tool of (await client.listTools()).tools) {
        const schema = fromJsonSchema(tool.outputSchema!);
        for (const content of [refusal.structuredContent, invalid.structuredContent, ...issues]) {
          expect((await schema['~standard'].validate(content)).issues, tool.name).toBeUndefined();
        }
      }
    } finally { await client.close(); }
  });
  it('keeps count-limit diagnostics only for their documented code and valid values', () => {
    const capacity = { key: 'mapsLimit', limit: 2, count: 3 };
    const envelope = (fields: object) => sanitizeFailure({ ok: false, status: 409, body: { error: {
      code: 'instance_limit_reached', message: 'The instance is full.', ...fields,
    } } });
    expect(envelope(capacity).body).toEqual({ error: { code: 'instance_limit_reached', message: 'The instance is full.', ...capacity } });
    for (const invalid of [{ key: secret }, { limit: 0 }, { limit: 1.5 }, { count: -1 }, { count: Number.MAX_SAFE_INTEGER + 1 }, { code: 'not_found' }]) {
      const result = envelope({ ...capacity, ...invalid });
      expect(result.body).not.toHaveProperty('error.key');
      expect(result.body).not.toHaveProperty('error.limit');
      expect(result.body).not.toHaveProperty('error.count');
    }
  });
  it('an error envelope on a success response is still unusable', async () => {
    let dispatched = 0;
    const client = await testClient(() => { dispatched++; return Response.json({ error: { code: 'not_found', message: 'Missing.' } }); });
    try {
      expect(decode(await client.callTool({ name: 'check_health', arguments: {} })).code).toBe('mcp_response_invalid');
      expect(dispatched).toBe(1);
    } finally { await client.close(); }
  });
  it('an unknown upstream code uses the internal default status while a retained code keeps its status', () => {
    expect(sanitizeFailure({ ok: false, status: 400, body: { error: { code: 'unknown_seed', message: secret } } })).toEqual({
      ok: false, status: 502, body: { error: { code: 'internal', message: ERROR_CATALOGUE.internal } },
    });
    expect(sanitizeFailure({ ok: false, status: 404, body: { error: { code: 'not_found', message: 'Missing.' } } }).status).toBe(404);
  });
  for (const [name, code] of [['run_sql', 'mcp_read_failed'], ['create_map', 'mcp_transport_failed']] as const) it(`${name}: upstream transport failure while caller remains connected`, async () => {
    let dispatched = 0;
    const client = await testClient(() => { dispatched++; throw new TypeError(secret); });
    try {
      const error = decode(await client.callTool({ name, arguments: name === 'run_sql' ? { sql: 'SELECT 1' } : { name: 'Changed' } }));
      expect(error.code).toBe(code);
      if (name === 'run_sql') expect(error.message).not.toMatch(/uncertain|changed|repeat/i);
      expect(dispatched).toBe(1);
    } finally { await client.close(); }
  });
  it('an internal executor exception is sanitized', async () => {
    vi.spyOn(executor, 'executeTool').mockRejectedValue(new Error(secret));
    const client = await testClient(() => { throw new Error('Unexpected dispatch'); });
    try { expect(decode(await client.callTool({ name: 'check_health', arguments: {} }))).toEqual({ code: 'internal', message: ERROR_CATALOGUE.internal }); }
    finally { await client.close(); }
  });
  it('a schema-invalid success is coded, sanitized and never retried', async () => {
    let dispatched = 0;
    const client = await testClient(() => { dispatched++; return Response.json({ status: secret }); });
    try {
      const error = decode(await client.callTool({ name: 'check_health', arguments: {} }));
      expect(error.code).toBe('mcp_response_invalid');
      expect(error.message).not.toMatch(/retry|safely|did not change/i);
      expect(dispatched).toBe(1);
    } finally { await client.close(); }
  });
  it('an internal API refusal cannot leak seeded runtime details', async () => {
    const client = await testClient(() => Response.json({ error: { code: 'internal', message: secret, stack: secret } }, { status: 500 }));
    try { expect(decode(await client.callTool({ name: 'get_map', arguments: { id: 'a' } }))).toEqual({ code: 'internal', message: ERROR_CATALOGUE.internal }); }
    finally { await client.close(); }
  });
  it('a documented SQL refusal retains diagnostic locations and identifiers', async () => {
    const diagnostic = 'Column "missing_identifier" does not exist. LINE 1: SELECT missing_identifier';
    const client = await testClient(() => Response.json({ error: { code: 'sql_error', message: diagnostic, position: { line: 1, column: 8 }, details: 'undocumented' } }, { status: 400 }));
    try { expect(decode(await client.callTool({ name: 'run_sql', arguments: { sql: 'SELECT missing_identifier' } }))).toEqual({ code: 'sql_error', message: diagnostic, position: { line: 1, column: 8 } }); }
    finally { await client.close(); }
  });
  it('a failed plan read carries no mutation uncertainty', async () => {
    const client = await testClient(() => { throw new TypeError(secret); });
    try { expect(decode(await client.callTool({ name: 'run_recipe', arguments: { id: 'recipe', plan: true } })).code).toBe('mcp_read_failed'); }
    finally { await client.close(); }
  });
  it('an unusable deletion subject dispatches no mutation', async () => {
    const methods: string[] = [];
    const client = await testClient(request => { methods.push(request.method); return Response.json({ id: 'layer' }); });
    try {
      expect(decode(await client.callTool({ name: 'delete_layer', arguments: { id: 'layer', change_group: 'group', expected_revision: '0'.repeat(32) } })).code).toBe('mcp_response_invalid');
      expect(methods).toEqual(['GET']);
    } finally { await client.close(); }
  });
  it('unknown tools remain protocol errors', async () => {
    let dispatched = 0;
    const client = await testClient(() => { dispatched++; return Response.json({}); });
    try { await expect(client.callTool({ name: 'does_not_exist', arguments: {} })).rejects.toThrow(); expect(dispatched).toBe(0); }
    finally { await client.close(); }
  });
});
