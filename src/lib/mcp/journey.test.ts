import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Tool } from '@modelcontextprotocol/client';
import type { Client } from '@modelcontextprotocol/client';
import { closeMetadataDb } from '@/lib/metadata/db';
import { cascadeSettled } from '@/lib/operations/cascade';
import { laneSettled, resetLane } from '@/lib/operations/lane';
import { resetLimiter } from '@/lib/geocode/limiter';
import { resetQueryInstance } from '@/lib/duckdb';
import { dispatchAssistantTestRoute } from '@/lib/assistant/testing/route-dispatch';
import { testClient } from './test-client';
import { coreJourney, journeyClient, newerJourney, pollRun } from '../../../scripts/mcp-journey-core.mjs';
const nativeFetch = globalThis.fetch;
let dir: string, client: Client, source: Server, hits: string[], mutations: string[];
let bodies: { path: string; body: Record<string, unknown> }[];
let cascades: string[];
let rewrite: ((request: Request) => Promise<Request>) | undefined;
beforeEach(async () => {
  await mkdir('.claude', { recursive: true }); dir = await mkdtemp(`${process.cwd()}/.tmp-journey-`);
  vi.stubEnv('DEZFIL_DATA_DIR', dir); vi.stubEnv('DEZFIL_OPERATION_TIMEOUT_S', '10'); vi.stubEnv('DEZFIL_EGRESS_ALLOWLIST', '127.0.0.1');
  closeMetadataDb(); resetQueryInstance(); hits = []; mutations = []; bodies = []; cascades = []; rewrite = undefined; resetLane(); resetLimiter();
  client = await testClient(async request => {
    if (new URL(request.url).port !== '3307') return nativeFetch(request);
    if (rewrite) request = await rewrite(request);
    const pathname = new URL(request.url).pathname;
    if (request.headers.get('content-type')?.includes('application/json')) bodies.push({ path: pathname, body: await request.clone().json() });
    if (!['GET', 'HEAD'].includes(request.method)) mutations.push(`${request.method} ${pathname}`);
    const response = await dispatchAssistantTestRoute(request);
    if (pathname.startsWith('/api/recipes/') && pathname.endsWith('/runs') && response.status === 202) cascades.push((await response.clone().json()).run.id);
    return response;
  });
});
afterEach(async () => {
  await Promise.all(cascades.map(cascadeSettled)); await laneSettled(); await client?.close(); source?.closeAllConnections(); if (source) await new Promise<void>(resolve => source.close(() => resolve()));
  closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true });
});
const readSubject = async (url: string) => {
  const response = await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`));
  expect(response.ok).toBe(true); return response.json();
};
it('core MCP journey uses fixed metric identities, styled layer readbacks and a listing-driven client gate', async () => {
  const journey = await journeyClient(client, readSubject);
  const result = await coreJourney(journey);
  expect(mutations.filter(p => p === `POST /api/maps/${result.mapId}/publish`)).toHaveLength(1);
  expect(journey.exercised.has('view_published_map')).toBe(true);
}, 30_000);
it('imports, materializes a spatial output and diagnoses failed/unstarted workflow members through MCP', async () => {
  source = createServer((req, res) => { hits.push(req.url!); res.writeHead(200, { 'content-type': 'text/csv' }); res.end('name,lon,lat\nremote_fixture,0,0\n'); });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
  const port = (source.address() as AddressInfo).port; expect(port).toBeGreaterThanOrEqual(3300);
  await newerJourney(await journeyClient(client, readSubject), `http://127.0.0.1:${port}/source.csv`);
  expect(hits.length).toBeGreaterThan(0);
  expect(bodies.filter(p => p.path.endsWith('/runs') && p.body.plan !== true)).toHaveLength(1);
  expect(bodies.filter(p => p.path.endsWith('/runs') && p.body.plan === true)).toHaveLength(2);
}, 30_000);

it('the independent metric oracle fails when the route is seeded with a wider distance', async () => {
  rewrite = async request => {
    if (new URL(request.url).pathname !== '/api/query') return request;
    const body = await request.clone().json();
    return new Request(request, { body: JSON.stringify({ ...body, sql: body.sql.replace(', 500))', ', 503))') }) });
  };
  await expect(coreJourney(await journeyClient(client, readSubject))).rejects.toThrow(/fixed 500 metre identities/);
}, 30_000);
it('a declined listed mutation makes zero mutation requests and approval makes exactly one', async () => {
  const journey = await journeyClient(client, readSubject);
  const map = await journey.call('create_map', { name: 'Boundary owner' });
  const before = mutations.length;
  const decline = await journey.gate('delete_map', { id: map.id }, false, { editRevision: map.editRevision });
  expect(decline.target).toBe('Delete Boundary owner?'); expect(decline.consequence).toBe('This deletes the map and its layers and stops its published link.');
  expect(mutations.length).toBe(before);
  expect((await journey.call('get_map', { id: map.id })).name).toBe('Boundary owner');
  await journey.gate('delete_map', { id: map.id }, true, { editRevision: map.editRevision });
  expect(mutations.slice(before)).toEqual([`DELETE /api/maps/${map.id}`]);
  await journey.call('get_map', { id: map.id }, 'not_found');
});
it('local search makes no external request; the listed external branches contact geocoder and Overpass', async () => {
  source = createServer((req, res) => {
    hits.push(req.url!); res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url?.startsWith('/overpass') ? JSON.stringify({ elements: [{ type: 'node', id: 207, lat: 0, lon: 0, tags: { amenity: 'cafe', name: 'Overpass fixture' } }] }) : JSON.stringify([{ place_id: 207, display_name: 'Provider fixture', lon: '0', lat: '0', licence: 'Fixture' }]));
  });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
  const port = (source.address() as AddressInfo).port; expect(port).toBeGreaterThanOrEqual(3300);
  vi.stubEnv('DEZFIL_GEOCODER_URL', `http://127.0.0.1:${port}`); vi.stubEnv('DEZFIL_GEOCODE_PACE_MS', '0');
  vi.stubEnv('DEZFIL_OVERPASS_URL', `http://127.0.0.1:${port}/overpass`);
  const journey = await journeyClient(client, readSubject);
  const map = await journey.call('create_map', { name: 'Local search' });
  await journey.call('search_map', { id: map.id, q: 'fixture' }); expect(hits).toEqual([]);
  const remote = await journey.call('search_map', { id: map.id, q: 'fixture', places: '1' });
  expect(remote.places.results[0].name).toBe('Provider fixture'); expect(hits).toHaveLength(1);
  const osm = await journey.call('import_table_from_osm', { selectors: ['amenity=cafe'], bbox: [-0.01, -0.01, 0.01, 0.01], name: 'mcp_osm' });
  expect(hits).toHaveLength(2); expect(hits[1]).toBe('/overpass');
  const data = await journey.call('inspect_table', { name: osm.tables[0].name });
  expect(data.preview[0].name).toBe('Overpass fixture');
  for (const name of ['search_map', 'import_table_from_osm']) expect(journey.tools.find((tool: Tool) => tool.name === name)?.annotations?.openWorldHint).toBe(true);
  // Both composite execution surfaces can take the external branch. Distinct
  // addresses keep the second probe independent of the first provider cache.
  for (const [index, owner] of ['operation', 'workflow'].entries()) {
    const input = await journey.call('upload_table', { filename: `${owner}_addresses.csv`, content_base64: Buffer.from(`address\n${owner}_fixture\n`).toString('base64') });
    const parameters = { input: input.name, column: 'address', name: `${owner}_located` };
    if (owner === 'operation') {
      const accepted = await journey.call('run_operation', { operation: 'geocode_addresses', parameters });
      expect((await pollRun(journey.call, 'get_operation_run', { id: accepted.run.id })).state).toBe('succeeded');
    } else {
      const recipe = (await journey.call('create_recipe', { name: 'External branch' })).recipe;
      await journey.call('add_recipe_step', { id: recipe.id, operation: 'geocode_addresses', parameters });
      const accepted = await journey.gate('run_recipe', { id: recipe.id }, true);
      expect((await pollRun(journey.call, 'get_recipe_run', { id: recipe.id, runId: accepted.body.run.id })).outcome).toBe('completed');
    }
    expect(hits).toHaveLength(3 + index);
    expect(new URL(hits.at(-1)!, 'http://fixture').searchParams.get('q')).toBe(`${owner}_fixture`);
    expect((await journey.call('inspect_table', { name: parameters.name })).preview[0].geocode_status).toBe('matched');
  }
  for (const name of ['run_operation', 'run_recipe']) expect(journey.tools.find((tool: Tool) => tool.name === name)?.annotations?.openWorldHint).toBe(true);
}, 30_000);

it('repeating identical accepted operation arguments mints two jobs with no output and two dispatches', async () => {
  const journey = await journeyClient(client, readSubject);
  const args = { operation: 'sql_step', parameters: { name: 'repeat_output', sql: 'SELECT missing_binding FROM range(1)' } };
  const first = await journey.call('run_operation', args);
  const second = await journey.call('run_operation', args);
  expect(first.run.id).not.toBe(second.run.id);
  await laneSettled();
  for (const id of [first.run.id, second.run.id]) {
    const { run } = await journey.call('get_operation_run', { id });
    expect(run.state).toBe('failed'); expect(run.error.code).toBe('sql_error');
  }
  expect(bodies.filter(request => request.path === '/api/operations/run')).toHaveLength(2);
  expect((await journey.call('list_tables')).some((table: { name: string }) => table.name === 'repeat_output')).toBe(false);
  expect(journey.tools.find((tool: Tool) => tool.name === 'run_operation')?.annotations?.idempotentHint).toBe(false);
});
