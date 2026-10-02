// Run only against an isolated store. Seed once, replace the server, then verify
// the saved credentials again. The state file contains synthetic credentials.
import assert from 'node:assert/strict';
import { captureBasis } from './revision-fixtures.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { connect } from './mcp-process-probe.mjs';

const missing = 'never-created-resource';
const expectStatus = (response, status) => {
  assert.equal(response.status, status, JSON.stringify(response.json));
  return response.json;
};
const query = (api, sql) => api('POST', '/api/query', { body: { sql } });
async function upload(api, name, sentinel) {
  const form = new FormData();
  form.append('file', new Blob([`sentinel,lon,lat\n${sentinel},13.4,52.5\n`]), `${name}.csv`);
  const table = expectStatus(await api('POST', '/api/tables', { form }), 201);
  assert.equal(table.name, name, 'another owner cannot reserve or suffix this name');
  return table;
}
async function invite(base, admin, name) {
  const email = `${name}@example.test`, password = 'field notebooks at dawn';
  const invitation = expectStatus(await admin('POST', '/api/users', { body: { name, email } }), 201);
  const secret = new URLSearchParams(new URL(invitation.signInUrl).hash.slice(1)).get('secret');
  const redeemed = await fetch(base + '/api/auth/redeem', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ secret, password }) });
  assert.equal(redeemed.status, 200); await redeemed.body?.cancel();
  return provisionJourney(base, { name, email, password });
}

export async function seedOwnership(base) {
  const entry = expectStatus(await journeyApi(base)('GET', '/api/auth/entry'), 200);
  assert.equal(entry.setupRequired, true, 'seed requires an empty scratch instance');
  const admin = await provisionJourney(base);
  const adminApi = journeyApi(base, { token: admin.token });
  const accounts = [admin, await invite(base, adminApi, 'alice'), await invite(base, adminApi, 'bob')];
  const owners = [];
  for (const [index, credential] of accounts.entries()) {
    const api = journeyApi(base, { token: credential.token }), sentinel = `owner_${index}`;
    const table = await upload(api, 'roads', sentinel);
    const hidden = await upload(api, `only_${index}`, sentinel);
    const map = expectStatus(await api('POST', '/api/maps', { body: { name: sentinel } }), 201);
    const layer = expectStatus(await api('POST', `/api/maps/${map.id}/layers`, { basis: captureBasis(map), body: { name: 'Roads', sql: 'SELECT * FROM roads' } }), 201);
    const recipe = expectStatus(await api('POST', '/api/recipes', { body: { name: sentinel } }), 201).recipe;
    const step = expectStatus(await api('POST', `/api/recipes/${recipe.id}/steps`, { basis: captureBasis(recipe), body: {
      operation: 'sql_step', parameters: { name: 'roads_copy', sql: 'SELECT * FROM roads' },
    } }), 201).step;
    const run = expectStatus(await api('POST', `/api/recipes/${recipe.id}/steps/${step.id}/run`), 202).run;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const current = expectStatus(await api('GET', `/api/recipes/${recipe.id}/runs/${run.id}`), 200).run;
      if (current.outcome) { assert.equal(current.outcome, 'completed'); break; }
      assert.ok(Date.now() < deadline, 'workflow completed within the journey bound');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const project = expectStatus(await api('POST', '/api/projects', { body: { name: sentinel,
      members: { addMaps: [map.id], addRecipes: [recipe.id], addTables: [table.id], expectedRevisions: { [`map:${map.id}`]: captureBasis((await api('GET', `/api/maps/${map.id}`)).json).editRevision, [`workflow:${recipe.id}`]: captureBasis((await api('GET', `/api/recipes/${recipe.id}`)).json).editRevision } } } }), 201);
    const publication = expectStatus(await api('POST', `/api/maps/${map.id}/publish`, { basis: captureBasis((await api('GET', `/api/maps/${map.id}`)).json) }), 201);
    owners.push({ accountId: credential.account.id, token: credential.token, cookie: credential.cookie,
      sentinel, tableId: table.id, hidden: hidden.name, mapId: map.id, layerId: layer.id,
      recipeId: recipe.id, stepId: step.id, runId: run.id, projectId: project.id, publication: publication.token });
  }
  assert.equal(new Set(owners.map(owner => owner.tableId)).size, 3);
  return { owners };
}

export async function verifyOwnership(base, { owners }) {
  const anonymous = journeyApi(base);
  let comparisons = 0;
  for (const [index, owner] of owners.entries()) {
    const foreign = owners[(index + 1) % owners.length];
    for (const credential of [{ token: owner.token }, { cookie: owner.cookie }]) {
      const api = journeyApi(base, credential);
      assert.equal(expectStatus(await api('GET', '/api/account'), 200).account.id, owner.accountId);
      assert.deepEqual(expectStatus(await api('GET', '/api/maps'), 200).map(map => map.id), [owner.mapId], 'map listing stays owner-only');
      assert.deepEqual(expectStatus(await api('GET', '/api/projects'), 200).map(project => project.id), [owner.projectId]);
      assert.deepEqual(expectStatus(await api('GET', '/api/recipes'), 200).recipes.map(recipe => recipe.id), [owner.recipeId]);
      assert.deepEqual(expectStatus(await api('GET', '/api/tables'), 200).map(table => table.name).sort(), [owner.hidden, 'roads', 'roads_copy'].sort());
      for (const sql of ['SELECT sentinel FROM roads', 'SELECT sentinel FROM main.roads', "SELECT sentinel FROM query_table('roads')", 'SELECT sentinel FROM roads_copy']) {
        assert.deepEqual(expectStatus(await query(api, sql), 200).preview, [{ sentinel: owner.sentinel }]);
      }
      const absent = await query(api, `SELECT * FROM ${missing.replaceAll('-', '_')}`);
      expectStatus(absent, 400); assert.equal(absent.json.error.code, 'sql_error');
      assert.deepEqual(await query(api, `SELECT * FROM ${foreign.hidden}`), absent);
      for (const file of ['/not-present.parquet', 'tables/roads.parquet']) {
        assert.equal(expectStatus(await query(api, `SELECT * FROM read_parquet('${file}')`), 400).error.code, 'sql_rejected');
      }
      const pairs = [
        [id => `/api/maps/${id}`, foreign.mapId],
        [id => `/api/layers/${id}`, foreign.layerId],
        [id => `/api/maps/${id}/history`, foreign.mapId],
        [id => `/api/projects/${id}/members`, foreign.projectId],
        [id => `/api/recipes/${id}`, foreign.recipeId],
        [id => `/api/recipes/${foreign.recipeId}/steps/${id}`, foreign.stepId],
        [id => `/api/recipes/${foreign.recipeId}/runs/${id}`, foreign.runId],
        [id => `/api/tables/${id}`, foreign.hidden],
        [id => `/api/tables/${id}/export?format=csv`, foreign.hidden],
      ];
      for (const [url, id] of pairs) {
        const hidden = await api('GET', url(id)), absent = await api('GET', url(missing));
        expectStatus(hidden, 404); assert.equal(hidden.json.error.code, 'not_found');
        assert.deepEqual(hidden, absent); comparisons++;
      }
      for (const method of ['PATCH', 'DELETE']) {
        const options = method === 'PATCH' ? { body: { name: 'Unwanted change' } } : {};
        const hidden = await api(method, `/api/maps/${foreign.mapId}`, options);
        expectStatus(hidden, 404);
        assert.deepEqual(hidden, await api(method, `/api/maps/${missing}`, options)); comparisons++;
      }
      const membersUrl = `/api/projects/${owner.projectId}/members`;
      const before = await api('GET', membersUrl);
      const compound = id => api('PATCH', membersUrl, { body: { removeMaps: [owner.mapId], addMaps: [id] } });
      const hidden = await compound(foreign.mapId); expectStatus(hidden, 404);
      assert.deepEqual(hidden, await compound(missing)); assert.deepEqual(await api('GET', membersUrl), before);
      const downloaded = await api('GET', '/api/tables/roads/export?format=csv', { raw: true });
      assert.equal(downloaded.status, 200); assert.ok((await downloaded.text()).includes(owner.sentinel));
      assert.equal(expectStatus(await api('GET', `/api/maps/${owner.mapId}`), 200).name, owner.sentinel);
    }
    const mcp = await connect(base, fetch, owner.token);
    try {
      assert.equal((await mcp.call('get_map', { id: owner.mapId })).id, owner.mapId);
      assert.deepEqual((await mcp.call('run_sql', { sql: 'SELECT sentinel FROM roads' })).preview, [{ sentinel: owner.sentinel }]);
      for (const [tool, hiddenArgs, absentArgs] of [
        ['get_map', { id: foreign.mapId }, { id: missing }],
        ['get_layer', { id: foreign.layerId }, { id: missing }],
        ['get_project', { id: foreign.projectId }, { id: missing }],
        ['get_recipe', { id: foreign.recipeId }, { id: missing }],
        ['get_recipe_run', { id: foreign.recipeId, runId: foreign.runId }, { id: foreign.recipeId, runId: missing }],
        ['inspect_table', { name: foreign.hidden }, { name: missing }],
        ['delete_map', { id: foreign.mapId, expected_revision: '0'.repeat(32) }, { id: missing, expected_revision: '0'.repeat(32) }],
      ]) {
        assert.deepEqual(await mcp.call(tool, hiddenArgs, 'not_found'), await mcp.call(tool, absentArgs, 'not_found')); comparisons++;
      }
      assert.deepEqual(await mcp.call('run_sql', { sql: `SELECT * FROM ${foreign.hidden}` }, 'sql_error'),
        await mcp.call('run_sql', { sql: 'SELECT * FROM never_imported' }, 'sql_error'));
    } finally { await mcp.client.close(); }
    for (const api of [anonymous, journeyApi(base, { token: foreign.token })]) {
      const projection = expectStatus(await api('GET', `/api/published/${owner.publication}`), 200);
      assert.deepEqual(projection.layers[0].render.geojson.features.map(feature => feature.properties.sentinel), [owner.sentinel]);
      const text = JSON.stringify(projection);
      for (const secret of [owner.accountId, owner.token, owner.cookie, 'owner_id', 'ownerId', 'sourceParams']) assert.ok(!text.includes(secret), 'projection contains no private account or source details');
    }
  }
  // Requests alternate across scopes and then overlap on the same SQL name.
  await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const owner = owners[index % owners.length], api = journeyApi(base, { token: owner.token });
    assert.deepEqual(expectStatus(await query(api, 'SELECT sentinel FROM roads'), 200).preview, [{ sentinel: owner.sentinel }]);
  }));
  expectStatus(await anonymous('GET', '/api/maps'), 401);
  expectStatus(await query(anonymous, 'SELECT * FROM roads'), 401);
  return { accounts: owners.length, comparisons, concurrentQueries: 12 };
}

if (process.argv[1]?.endsWith('/ownership-journey.mjs')) {
  const [mode, base, stateFile] = process.argv.slice(2);
  assert.ok(['seed', 'verify'].includes(mode) && base && stateFile, 'usage: seed|verify origin scratch-state.json');
  const url = new URL(base);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && Number(url.port) >= 3300, 'use an isolated loopback port, never 3000');
  const state = mode === 'seed' ? await seedOwnership(base) : JSON.parse(await readFile(stateFile, 'utf8'));
  if (mode === 'seed') await writeFile(stateFile, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ label: 'confirmed', mode, ...await verifyOwnership(base, state) }));
}
