import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { transportProbe } from './transport-probe.mjs';
import { exchange, assertNoTruncation } from './transport-probe-support.mjs';
import { mcpBodyControl } from './mcp-body-control.mjs';
import { seedBodyFixtures, invalidBody, concreteBodyPath } from './body-probe-fixtures.mjs';
import { sizedJson, chunksOf, assertByteRefusal, assertValidation, assertNoBodyMutation } from './body-probe-support.mjs';

/** Full served probe. The injectable transport is only for route-level tests;
 * the command always uses real HTTP, production fixtures and the transport arms.
 * @param {string} base
 * @param {{serverLog: string, exchangeImpl?: typeof exchange, runTransport?: boolean}} options
 */
export async function bodyProbe(base, { serverLog, exchangeImpl = exchange, runTransport = true }) {
  assert.ok(process.env.DEZFIL_DATA_DIR, 'DEZFIL_DATA_DIR must name the isolated server data directory');
  assert.ok(serverLog, '--server-log is required'); await readFile(serverLog);
  const started = Date.now();
  if (runTransport) await transportProbe(base, { serverLog });
  const credentials = await provisionJourney(base), api = journeyApi(base, { token: credentials.token }), publicApi = journeyApi(base);
  const fixture = await seedBodyFixtures(api, publicApi);
  const document = (await api('GET', '/api/openapi.json')).json;
  const operations = Object.entries(document.paths).flatMap(([template, methods]) => Object.entries(methods)
    .filter(([, operation]) => operation.requestBody?.content?.['application/json'])
    .map(([method, operation]) => ({ template, method: method.toUpperCase(), operation })));
  assert.ok(operations.length >= 50, 'exercise the complete JSON contract');
  const state = async () => {
    const urls = ['/api/maps', '/api/projects', '/api/tables', '/api/recipes', '/api/settings', '/api/users', '/api/account/tokens', `/api/maps/${fixture.mapId}`, `/api/maps/${fixture.mapId}/history`, `/api/recipes/${fixture.recipeId}`, `/api/recipes/${fixture.recipeId}/layout`];
    const values = [];
    for (const url of urls) { const result = await api('GET', url); assert.equal(result.status, 200, url); values.push(result.json); }
    return JSON.parse(JSON.stringify(values, (key, value) => key === 'lastUsedAt' ? undefined : value));
  };
  const before = await state(), evidence = [];
  for (const { template, method, operation } of operations) {
    const limit = operation.requestBody['x-byte-limit']; assert.ok([65_536, 131_072, 16_777_216].includes(limit), template);
    const pathname = concreteBodyPath(template, fixture, credentials.account);
    const headers = { origin: new URL(base).origin, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(!template.startsWith('/api/published/') && !template.startsWith('/api/auth/') ? { authorization: `Bearer ${credentials.token}` } : {}) };
    if (template.startsWith('/api/maps/') || template.startsWith('/api/layers/')) headers['x-edit-revision'] = (await api('GET', `/api/maps/${fixture.mapId}`)).json.editRevision;
    if (template.startsWith('/api/recipes/')) headers['x-edit-revision'] = (await api('GET', `/api/recipes/${fixture.recipeId}`)).json.recipe.editRevision;
    const value = template === '/api/mcp' ? { jsonrpc: '2.0', id: 1, method: 'body_probe_unknown' } : invalidBody;
    const control = Buffer.from(JSON.stringify({ ...value, _padding: '' }));
    const expected = await exchangeImpl(base + pathname, { method, headers, chunks: [control] });
    assert.ok(expected.status >= 400 && expected.status < 500 || template === '/api/mcp' && expected.json?.error, `${method} ${template}: control must refuse without work: ${expected.text}`);
    assert.notEqual(expected.json?.error?.code, 'authentication_required', template);
    assert.notEqual(expected.json?.error?.code, 'assistant_disabled', 'enable the assistant with a synthetic provider key; no provider call is made');
    for (const declared of [true, false]) for (const encoding of ['utf8', 'escaped']) for (const delta of [-1, 0, 1]) {
      const bytes = limit + delta, body = sizedJson(value, bytes, encoding);
      const result = await exchangeImpl(base + pathname, { method, headers: { ...headers, ...(declared ? { 'content-length': String(bytes) } : {}) }, chunks: chunksOf(body) });
      if (delta <= 0) assertValidation(result, expected);
      else assertByteRefusal(result, limit, { code: operation.requestBody['x-byte-error'], workflow: template.startsWith('/api/recipes') && !template.endsWith('/transfer'),
        ...(template === '/api/assistant/messages' ? { message: 'The assistant submission exceeds 128 KiB.' } : {}) });
      evidence.push({ method, template, bytes, declared, encoding, status: result.status });
    }
    assertNoBodyMutation(before, await state());
  }
  const mcp = await mcpBodyControl(base, { authorization: `Bearer ${credentials.token}` });
  assertNoTruncation(await readFile(serverLog, 'utf8'));
  const result = { label: 'confirmed', mode: 'body', operations: operations.length, checks: evidence.length, elapsedSeconds: (Date.now() - started) / 1000, fixtures: fixture.bytes, mcp, evidence };
  console.log(JSON.stringify(result, null, 2)); return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), at = args.indexOf('--server-log');
    assert.ok(args[0]?.startsWith('http') && at > 0, 'Usage: body-probe.mjs ORIGIN --server-log PATH');
    await bodyProbe(args[0], { serverLog: args[at + 1] });
  } catch (error) { console.error(JSON.stringify({ label: 'failed', message: error.message }, null, 2)); process.exitCode = 1; }
}
