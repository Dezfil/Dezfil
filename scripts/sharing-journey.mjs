// Run only against an isolated store. Seed once (it shares, edits, runs,
// transfers and deactivates along the way), replace the server, then verify
// the shared state again with the saved credentials. The state file contains
// synthetic credentials. With --assistant-wire=<port> the assistant's tool
// path is driven through a scripted model wire on that loopback port; the
// instance must have been started with OPENAI_API_KEY set to any value,
// DEZFIL_AI_PROVIDER=openai and OPENAI_BASE_URL=http://127.0.0.1:<port>/v1.
import assert from 'node:assert/strict';
import { captureBasis } from './revision-fixtures.mjs';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { connect } from './mcp-process-probe.mjs';

const PASSWORD = 'field notebooks at dawn';
const PERMISSION = { error: { code: 'forbidden', message: 'You can view this but cannot make this change.' } };
const unavailable = name => ({ error: { code: 'sql_error', message: `The dataset "${name}" is not available to you.` } });
const missing = 'never-created-resource';
const POINT = 'ST_Point(0, 0) AS geom';
const CATALOGUE_PROBE = `SELECT view_name, ${POINT} FROM duckdb_views() WHERE NOT internal`;

const expectStatus = (response, status, label = '') => {
  assert.equal(response.status, status, `${label} ${JSON.stringify(response.json)}`);
  return response.json;
};
const sentinels = rows => rows.map(row => row.sentinel);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Every refusal compared, with its body, so the record says what was refused and how. */
function recorder() {
  const refusals = [];
  return {
    refusals,
    /** A refusal that must equal the expected body exactly, recorded with it. */
    refused(step, response, status, body) {
      assert.equal(response.status, status, `${step}: ${JSON.stringify(response.json)}`);
      assert.deepEqual(response.json, body, step);
      refusals.push({ step, status: response.status, body: response.json });
    },
    /** Hidden equals missing: the two answers are parsed-JSON-equal. */
    absent(step, hidden, never, status = 404) {
      assert.equal(hidden.status, status, `${step}: ${JSON.stringify(hidden.json)}`);
      assert.deepEqual(hidden, never, `${step}: hidden differs from missing`);
      refusals.push({ step, status: hidden.status, body: hidden.json });
    },
    /** Two refusals that must be one: a status of refusal and equal bodies. */
    alike(step, one, other) {
      assert.ok(one.status >= 400, `${step}: ${JSON.stringify(one.json)}`);
      assert.deepEqual(one, other, `${step}: the two refusals differ`);
      refusals.push({ step, status: one.status, body: one.json });
    },
  };
}

async function upload(api, name, sentinel) {
  const form = new FormData();
  form.append('file', new Blob([`sentinel,lon,lat\n${sentinel},13.4,52.5\n`]), `${name}.csv`);
  const table = expectStatus(await api('POST', '/api/tables', { form }), 201, `upload ${name}`);
  assert.equal(table.name, name, 'a same-named dataset of another person neither reserves nor suffixes the name');
  return table;
}

async function invite(base, admin, name) {
  const email = `${name}@example.test`;
  const invitation = expectStatus(await admin('POST', '/api/users', { body: { name, email } }), 201, `invite ${name}`);
  const secret = new URLSearchParams(new URL(invitation.signInUrl).hash.slice(1)).get('secret');
  const redeemed = await fetch(base + '/api/auth/redeem', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ secret, password: PASSWORD }) });
  assert.equal(redeemed.status, 200); await redeemed.body?.cancel();
  return signIn(base, name);
}

/** A fresh session and token for one of the journey's people. */
async function signIn(base, name) {
  const credential = await provisionJourney(base, { name, email: `${name}@example.test`, password: PASSWORD });
  const account = expectStatus(await journeyApi(base, { token: credential.token })('GET', '/api/account'), 200).account;
  return { id: account.id, name, sqlName: account.sqlName, token: credential.token, cookie: credential.cookie };
}

async function settle(api, recipeId, runId) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const run = expectStatus(await api('GET', `/api/recipes/${recipeId}/runs/${runId}`), 200).run;
    if (run.outcome) return run;
    assert.ok(Date.now() < deadline, 'workflow run settled within the journey bound');
    await delay(50);
  }
}

async function runWorkflow(api, recipeId, basis) {
  const started = expectStatus(await api('POST', `/api/recipes/${recipeId}/runs`, { body: {}, basis }), 202, 'run the workflow').run;
  const run = await settle(api, recipeId, started.id);
  assert.equal(run.outcome, 'completed', JSON.stringify(run));
  return run;
}

const render = async (api, layerId) => expectStatus(await api('GET', `/api/layers/${layerId}/render`), 200, `render ${layerId}`);
const drawn = async (api, layerId) => {
  const result = await render(api, layerId);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return sentinels(result.geojson.features.map(feature => feature.properties));
};
const query = async (api, sql) => api('POST', '/api/query', { body: { sql } });
const rowsOf = async (api, sql) => expectStatus(await query(api, sql), 200, sql).preview;

/** The entries of a zip archive, stored or deflated, read from its central directory. */
export function zipEntries(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'the export is a zip archive');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50, 'a central directory entry');
    const method = buffer.readUInt16LE(at + 10), size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    if (!name.endsWith('/')) entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

/**
 * The assistant's tool path through a scripted model wire: the model asks
 * for run_sql, the instance's assistant loop dispatches it with the
 * caller's own delegated credential, and the tool result is read back from
 * the run's event stream. The instance must point its OpenAI client here.
 */
export async function assistantWire(port) {
  const replies = [];
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/responses' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    for await (const chunk of req) void chunk;
    const next = replies.shift();
    if (!next) { res.writeHead(500).end('No scripted reply remains'); return; }
    const output = next.call
      ? [{ type: 'function_call', id: randomUUID(), call_id: randomUUID(), name: next.call.name, arguments: JSON.stringify(next.call.args), status: 'completed' }]
      : [{ type: 'message', id: randomUUID(), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: next.text, annotations: [] }] }];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (next.text) res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: next.text })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: randomUUID(), model: 'scripted-model', status: 'completed', output } })}\n\n`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  // One turn at a time: the scripted replies are a queue.
  let turn = Promise.resolve();
  return {
    port: address.port,
    async query(base, credential, sql) {
      const run = turn.then(async () => {
        replies.push({ call: { name: 'run_sql', args: { sql } } }, { text: 'Done.' });
        const api = journeyApi(base, credential);
        const reservation = expectStatus(await api('POST', '/api/assistant/runs'), 201, 'reserve an assistant run');
        const response = await api('POST', '/api/assistant/messages', { body: {
          runId: reservation.id, message: 'Run the query.', history: [],
          context: { page: 'sql', draft: sql, selection: null, lastExecution: null },
        }, raw: true });
        assert.equal(response.status, 200, 'the assistant run streams');
        const events = (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        replies.length = 0;
        const result = events.find(event => event.type === 'tool_result' && event.tool === 'run_sql');
        assert.ok(result, `the assistant dispatched run_sql: ${JSON.stringify(events.map(event => event.type))}`);
        return result;
      });
      turn = run.catch(() => {});
      return run;
    },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export async function seedSharing(base) {
  const book = recorder();
  const anonymous = journeyApi(base);
  const entry = expectStatus(await anonymous('GET', '/api/auth/entry'), 200);
  assert.equal(entry.setupRequired, true, 'seed requires an empty scratch instance');
  const admin = await provisionJourney(base);
  const adminApi = journeyApi(base, { token: admin.token });
  const people = {};
  for (const name of ['ada', 'eli', 'vic', 'nia']) people[name] = await invite(base, adminApi, name);
  for (const [name, person] of Object.entries(people)) assert.equal(person.sqlName, name, 'the SQL name is derived from the display name');
  const as = name => journeyApi(base, { token: people[name].token });
  const [ada, eli, vic, nia] = ['ada', 'eli', 'vic', 'nia'].map(as);

  // The owner's space: roads and rivers to share, parks and a map kept private.
  const tables = {
    'ada.roads': await upload(ada, 'roads', 'ada_roads'), 'ada.rivers': await upload(ada, 'rivers', 'ada_rivers'),
    'ada.parks': await upload(ada, 'parks', 'ada_parks'), 'eli.roads': await upload(eli, 'roads', 'eli_roads'),
    'eli.private': await upload(eli, 'notes', 'eli_notes'), 'vic.roads': await upload(vic, 'roads', 'vic_roads'),
    'nia.roads': await upload(nia, 'roads', 'nia_roads'),
  };
  const recipe = expectStatus(await ada('POST', '/api/recipes', { body: { name: 'Staging' } }), 201).recipe;
  const staged = expectStatus(await ada('POST', `/api/recipes/${recipe.id}/steps`, { basis: captureBasis(recipe), body: {
    operation: 'sql_step', parameters: { name: 'roads_out', sql: 'SELECT * FROM roads' },
  } }), 201);
  await runWorkflow(ada, recipe.id, captureBasis(staged));
  tables['ada.roads_out'] = expectStatus(await ada('GET', '/api/tables/roads_out'), 200);
  const map = expectStatus(await ada('POST', '/api/maps', { body: { name: 'Survey' } }), 201);
  let layerBasis = captureBasis(map);
  const layer = async (api, name, sql) => {
    const created = expectStatus(await api('POST', `/api/maps/${map.id}/layers`, { body: { name, sql }, basis: layerBasis }), 201, `layer ${name}`);
    layerBasis = captureBasis(created);
    return created;
  };
  const layers = {
    roads: (await layer(ada, 'Roads', 'SELECT * FROM roads')).id,
    rivers: (await layer(ada, 'Rivers', 'SELECT * FROM rivers')).id,
    output: (await layer(ada, 'Output', 'SELECT * FROM roads_out')).id,
  };
  const hiddenMap = expectStatus(await ada('POST', '/api/maps', { body: { name: 'Private' } }), 201);
  expectStatus(await ada('POST', `/api/maps/${hiddenMap.id}/layers`, { basis: captureBasis((await ada('GET', `/api/maps/${hiddenMap.id}`)).json), body: { name: 'Parks', sql: 'SELECT * FROM parks' } }), 201);
  const project = expectStatus(await ada('POST', '/api/projects', { body: { name: 'Survey', members: {
    expectedRevisions: { [`map:${map.id}`]: captureBasis((await ada('GET', `/api/maps/${map.id}`)).json).editRevision, [`workflow:${recipe.id}`]: captureBasis((await ada('GET', `/api/recipes/${recipe.id}`)).json).editRevision },
    addMaps: [map.id], addRecipes: [recipe.id],
    addTables: [tables['ada.roads'].id, tables['ada.rivers'].id, tables['ada.roads_out'].id],
  } } }), 201);
  const publication = expectStatus(await ada('POST', `/api/maps/${map.id}/publish`, { basis: captureBasis((await ada('GET', `/api/maps/${map.id}`)).json) }), 201).token;

  // Sharing: the person picker finds by name and by exact email, name and SQL name only.
  const byName = expectStatus(await ada('GET', '/api/accounts/search?q=VI'), 200).accounts;
  assert.deepEqual(byName, [{ name: 'vic', sqlName: 'vic' }]);
  assert.deepEqual(expectStatus(await ada('GET', '/api/accounts/search?q=%20ELI@example.test%20'), 200).accounts, [{ name: 'eli', sqlName: 'eli' }]);
  expectStatus(await ada('PUT', `/api/projects/${project.id}/people/vic`, { body: { role: 'viewer' } }), 200);
  const shared = expectStatus(await ada('PUT', `/api/projects/${project.id}/people/eli`, { body: { role: 'editor' } }), 200).people;
  assert.deepEqual(shared.map(person => [person.sqlName, person.role, person.deactivated]),
    [['ada', 'owner', false], ['eli', 'editor', false], ['vic', 'viewer', false]]);

  const ids = { project: project.id, map: map.id, hiddenMap: hiddenMap.id, recipe: recipe.id, layers, publication,
    tables: Object.fromEntries(Object.entries(tables).map(([key, table]) => [key, table.id])) };

  // The Viewer reads everything filed and changes nothing, refused alike on every write.
  const snapshot = async () => JSON.stringify([
    expectStatus(await ada('GET', `/api/maps/${map.id}`), 200), expectStatus(await ada('GET', `/api/recipes/${recipe.id}`), 200),
    expectStatus(await ada('GET', `/api/projects/${project.id}`), 200), expectStatus(await ada('GET', `/api/projects/${project.id}/people`), 200),
    (expectStatus(await ada('GET', '/api/tables'), 200)).map(table => [table.id, table.name, table.importedAt, table.projectIds]),
  ]);
  const before = await snapshot();
  const viewerWrites = [
    ['rename the map', 'PATCH', `/api/maps/${map.id}`, { name: 'Viewer was here' }],
    ['add a layer', 'POST', `/api/maps/${map.id}/layers`, { name: 'Viewer layer', sql: 'SELECT * FROM roads' }],
    ['restyle a layer', 'PATCH', `/api/layers/${layers.roads}`, { name: 'Viewer roads' }],
    ['delete the map', 'DELETE', `/api/maps/${map.id}`],
    ['undo on the map', 'POST', `/api/maps/${map.id}/undo`],
    ['publish the map', 'POST', `/api/maps/${map.id}/publish`],
    ['unpublish the map', 'DELETE', `/api/maps/${map.id}/publish`],
    ['run the workflow', 'POST', `/api/recipes/${recipe.id}/runs`, {}],
    ['add a workflow step', 'POST', `/api/recipes/${recipe.id}/steps`, { operation: 'sql_step', parameters: { name: 'viewer_out', sql: 'SELECT 1 AS one' } }],
    ['rename the workflow', 'PATCH', `/api/recipes/${recipe.id}`, { name: 'Viewer workflow' }],
    ['delete the owner\'s dataset', 'DELETE', `/api/tables/${tables['ada.roads'].id}`],
    ['file own dataset into the project', 'PATCH', `/api/projects/${project.id}/members`, { addTables: [tables['vic.roads'].id] }],
  ];
  for (const credential of [{ token: people.vic.token }, { cookie: people.vic.cookie }]) {
    const api = journeyApi(base, credential);
    for (const [step, method, url, body] of viewerWrites) {
      book.refused(`viewer: ${step} (${credential.token ? 'token' : 'session'})`, await api(method, url, body === undefined ? {} : { body }), 403, PERMISSION);
    }
  }
  assert.equal(await snapshot(), before, 'every refused viewer write left the store as it was');

  // The Editor edits the map, runs the workflow and files and draws their own dataset.
  const renameBasis = captureBasis(expectStatus(await eli('GET', `/api/maps/${map.id}`), 200));
  expectStatus(await eli('PATCH', `/api/maps/${map.id}`, { basis: renameBasis, body: { name: 'Survey, edited' } }), 200, 'editor renames the map');
  const ownerOutput = expectStatus(await ada('GET', `/api/tables/${tables['ada.roads_out'].id}`), 200);
  await runWorkflow(eli, recipe.id, captureBasis((await eli('GET', `/api/recipes/${recipe.id}`)).json));
  const editorOutput = expectStatus(await eli('GET', '/api/tables/roads_out'), 200);
  assert.equal(editorOutput.owner.sqlName, 'eli', 'the Editor\'s run output is the Editor\'s own dataset');
  assert.notEqual(editorOutput.id, ownerOutput.id);
  assert.ok((expectStatus(await eli('GET', '/api/tables'), 200)).find(table => table.id === editorOutput.id).projectIds.includes(project.id),
    'the Editor\'s output is filed in the workflow\'s project');
  const ownerAfter = expectStatus(await ada('GET', `/api/tables/${tables['ada.roads_out'].id}`), 200);
  assert.deepEqual([ownerAfter.id, ownerAfter.owner, ownerAfter.importedAt, ownerAfter.rowCount, ownerAfter.file],
    [ownerOutput.id, ownerOutput.owner, ownerOutput.importedAt, ownerOutput.rowCount, ownerOutput.file], 'the owner\'s earlier output is untouched');
  ids.tables['eli.roads_out'] = editorOutput.id;
  const dependencies = expectStatus(await ada('GET', `/api/maps/${map.id}/dependencies`), 200);
  assert.ok(JSON.stringify(dependencies).includes(ownerOutput.id) && !JSON.stringify(dependencies).includes(editorOutput.id),
    'the owner\'s map still draws the owner\'s output, never the Editor\'s');
  assert.deepEqual(await drawn(ada, layers.output), ['ada_roads']);
  expectStatus(await eli('PATCH', `/api/projects/${project.id}/members`, { body: { addTables: [tables['eli.roads'].id] } }), 200, 'editor files own dataset');
  // The Editor opens the map after filing, publication and the rename.
  const editorMap = expectStatus(await eli('GET', `/api/maps/${map.id}`), 200);
  const ownerMap = expectStatus(await ada('GET', `/api/maps/${map.id}`), 200);
  assert.equal(editorMap.editRevision, ownerMap.editRevision, 'owner and Editor read the same document revision');
  assert.equal(expectStatus(await eli('GET', '/api/maps'), 200).find(item => item.id === map.id).editRevision,
    editorMap.editRevision, 'the listing and document carry the same revision');
  layerBasis = captureBasis(editorMap);
  layers.editor = (await layer(eli, 'Eli roads', 'SELECT * FROM eli.roads')).id;
  for (const api of [eli, ada, vic]) assert.deepEqual(await drawn(api, layers.editor), ['eli_roads']);
  const layersBefore = expectStatus(await ada('GET', `/api/maps/${map.id}`), 200).layers.map(l => l.id);
  book.refused('editor: save SQL naming the owner\'s unfiled dataset', await eli('POST', `/api/maps/${map.id}/layers`, { basis: captureBasis((await eli('GET', `/api/maps/${map.id}`)).json), body: { name: 'Parks', sql: 'SELECT * FROM parks' } }), 400, unavailable('parks'));
  book.refused('editor: save SQL naming a dataset that never existed', await eli('POST', `/api/maps/${map.id}/layers`, { basis: captureBasis((await eli('GET', `/api/maps/${map.id}`)).json), body: { name: 'Nothing', sql: 'SELECT * FROM never_imported' } }), 400, unavailable('never_imported'));
  assert.deepEqual(expectStatus(await ada('GET', `/api/maps/${map.id}`), 200).layers.map(l => l.id), layersBefore, 'refused saves added nothing');
  const publicationWrites = [
    ['change the published fields', 'PATCH', `/api/layers/${layers.roads}`, { publishedFields: [] }],
    ['change the publication theme', 'POST', `/api/maps/${map.id}/publish`, { theme: 'light' }],
    ['turn off widget publication', 'PATCH', `/api/maps/${map.id}`, { widgetsPublished: false }],
    ['revoke the publication', 'DELETE', `/api/maps/${map.id}/publish`],
  ];
  for (const [step, method, url, body] of publicationWrites) {
    book.refused(`editor: ${step}`, await eli(method, url, body === undefined ? {} : { body }), 403, PERMISSION);
  }
  assert.equal(expectStatus(await anonymous('GET', `/api/published/${publication}`), 200).layers.length, 4, 'the link survives every refused publication write');

  // The owner removes a dataset from the project: the dependent layer fails by name for the members only.
  expectStatus(await ada('PATCH', `/api/projects/${project.id}/members`, { body: { removeTables: [tables['ada.rivers'].id] } }), 200);
  for (const api of [eli, vic]) {
    const rivers = await render(api, layers.rivers);
    assert.deepEqual([rivers.ok, rivers.error], [false, unavailable('rivers').error], 'the dependent layer fails by name for a member');
    for (const id of [layers.roads, layers.output, layers.editor]) assert.equal((await render(api, id)).ok, true, 'nothing else fails');
  }
  assert.deepEqual(await drawn(ada, layers.rivers), ['ada_rivers'], 'the owner still renders it');
  layers.catalogue = (await layer(eli, 'Catalogue', CATALOGUE_PROBE)).id;

  const state = { ids, admin: { token: admin.token }, people };
  await linkHolds(base, state, 'before the transfer');

  // Transfers: the map to the Editor, then the project; nothing rebinds.
  const handedMap = expectStatus(await ada('POST', `/api/maps/${map.id}/transfer`, { basis: captureBasis((await ada('GET', `/api/maps/${map.id}`)).json), body: { to: 'eli' } }), 200, 'transfer the map');
  assert.equal(handedMap.owner.sqlName ?? handedMap.owner, 'eli');
  await linkHolds(base, state, 'after the map\'s transfer');
  expectStatus(await ada('POST', `/api/projects/${project.id}/transfer`, { body: { to: 'eli' } }), 200, 'transfer the project');
  assert.deepEqual(expectStatus(await eli('GET', `/api/projects/${project.id}/people`), 200).people.map(person => [person.sqlName, person.role]),
    [['eli', 'owner'], ['ada', 'editor'], ['vic', 'viewer']]);
  // A member reads the owner and themselves; the roster is the owner's.
  assert.deepEqual(expectStatus(await vic('GET', `/api/projects/${project.id}/people`), 200).people.map(person => [person.sqlName, person.role]),
    [['eli', 'owner'], ['vic', 'viewer']]);
  for (const api of [ada, eli, vic]) {
    assert.deepEqual(await drawn(api, layers.roads), ['ada_roads'], 'the map keeps its home: plain roads stays the home\'s');
    assert.deepEqual(sentinels(await rowsOf(api, `SELECT sentinel FROM ${api === ada ? 'roads' : 'ada.roads'}`)), ['ada_roads']);
  }

  // Deactivation: a member's reach is inert; a deactivated owner's project is frozen but reachable.
  const setStatus = async (name, status) => expectStatus(await adminApi('PATCH', `/api/users/${people[name].id}`, { body: { status } }), 200, `${name} ${status}`);
  await setStatus('vic', 'deactivated');
  expectStatus(await vic('GET', `/api/projects/${project.id}`), 401, 'a deactivated member\'s token');
  assert.deepEqual(expectStatus(await eli('GET', `/api/projects/${project.id}/people`), 200).people.find(person => person.sqlName === 'vic'),
    { name: 'vic', sqlName: 'vic', role: 'viewer', deactivated: true });
  book.alike('owner: give a deactivated member a role, as for nobody at all',
    await eli('PUT', `/api/projects/${project.id}/people/vic`, { body: { role: 'editor' } }),
    await eli('PUT', `/api/projects/${project.id}/people/nobody_here`, { body: { role: 'editor' } }));
  await setStatus('vic', 'active');
  await setStatus('eli', 'deactivated');
  for (const api of [ada, vic]) {
    expectStatus(await api('GET', `/api/projects/${project.id}`), 200, 'a frozen project stays reachable');
    assert.deepEqual(await drawn(api, layers.roads), ['ada_roads']);
  }
  book.refused('editor: edit a frozen owner\'s map', await ada('PATCH', `/api/maps/${map.id}`, { body: { name: 'Frozen edit' } }), 403, PERMISSION);
  book.refused('editor: file into a frozen project', await ada('PATCH', `/api/projects/${project.id}/members`, { body: { addTables: [tables['ada.parks'].id] } }), 403, PERMISSION);
  book.absent('admin: membership of a frozen project', await adminApi('PUT', `/api/projects/${project.id}/people/vic`, { body: { role: 'editor' } }),
    await adminApi('PUT', `/api/projects/${missing}/people/vic`, { body: { role: 'editor' } }));
  await setStatus('eli', 'active');
  const reactivatedBasis = captureBasis(expectStatus(await ada('GET', `/api/maps/${map.id}`), 200));
  expectStatus(await ada('PATCH', `/api/maps/${map.id}`, { basis: reactivatedBasis, body: { name: 'Survey, edited' } }), 200, 'reactivation restores the editor\'s edit');
  // Deactivation ended their sessions: everyone signs in afresh for the verify run.
  for (const name of ['eli', 'vic']) people[name] = await signIn(base, name);
  return { ...state, seedRefusals: book.refusals };
}

/** The published link shows the map's data and nothing else of anyone's space. */
async function linkHolds(base, { ids }, when) {
  const projection = expectStatus(await journeyApi(base)('GET', `/api/published/${ids.publication}`), 200, `the link ${when}`);
  const layer = name => projection.layers.find(l => l.name === name).render;
  assert.deepEqual(sentinels(layer('Roads').geojson.features.map(f => f.properties)), ['ada_roads'], `the link draws the home's roads ${when}`);
  assert.deepEqual(sentinels(layer('Eli roads').geojson.features.map(f => f.properties)), ['eli_roads']);
  assert.deepEqual([layer('Catalogue').ok, layer('Catalogue').error?.code], [false, 'catalogue_not_published'],
    `the catalogue probe through the link is refused ${when}`);
  const text = JSON.stringify(projection);
  for (const secret of ['ada_parks', 'parks', 'eli_notes', 'notes', 'vic_roads', 'nia_roads', ids.tables['ada.parks'], ids.tables['eli.private']]) {
    assert.ok(!text.includes(secret), `the link discloses nothing outside the map ${when}: ${secret}`);
  }
}

export async function verifySharing(base, state, { wire } = {}) {
  const { ids, people } = state;
  const book = recorder();
  const anonymous = journeyApi(base);
  let comparisons = 0;
  const transports = { console: 0, mcp: 0, assistant: 0 };
  const credentials = name => [{ token: people[name].token }, { cookie: people[name].cookie }];

  // Who reaches what: the project, its people and the map's home after both transfers.
  for (const name of ['ada', 'eli', 'vic']) {
    for (const credential of credentials(name)) {
      const api = journeyApi(base, credential);
      assert.equal(expectStatus(await api('GET', '/api/account'), 200).account.sqlName, name);
      const projects = expectStatus(await api('GET', '/api/projects'), 200);
      const project = projects.find(p => p.id === ids.project);
      assert.ok(project, `${name} reaches the project`);
      assert.deepEqual([project.owner.sqlName, project.role], ['eli', { ada: 'editor', eli: 'owner', vic: 'viewer' }[name]]);
      const map = expectStatus(await api('GET', '/api/maps'), 200).find(m => m.id === ids.map);
      assert.ok(map, `${name} lists the shared map`);
      assert.deepEqual([map.owner.sqlName, map.home], ['eli', 'ada'], 'the map keeps its SQL home across transfer');
      assert.ok(expectStatus(await api('GET', '/api/recipes'), 200).recipes.some(r => r.id === ids.recipe), `${name} lists the workflow`);
      const listed = expectStatus(await api('GET', '/api/tables'), 200);
      const roads = listed.filter(t => t.name === 'roads').map(t => [t.qualifiedName, t.owner.sqlName, t.id]).sort();
      const typed = { ada: [['roads', 'ada'], ['eli.roads', 'eli']], eli: [['roads', 'eli'], ['ada.roads', 'ada']],
        vic: [['roads', 'vic'], ['ada.roads', 'ada'], ['eli.roads', 'eli']] }[name];
      assert.deepEqual(roads, typed.map(([as, owner]) => [as, owner, ids.tables[`${owner}.roads`]]).sort(), `${name}'s listing tells every roads apart`);
      if (name !== 'ada') {
        const how = credential.token ? 'token' : 'session';
        for (const hidden of ['parks', 'rivers']) assert.ok(!listed.some(t => t.id === ids.tables[`ada.${hidden}`]), `the owner's unfiled ${hidden} is invisible to ${name}`);
        book.absent(`${name}: the owner's unfiled map (${how})`, await api('GET', `/api/maps/${ids.hiddenMap}`), await api('GET', `/api/maps/${missing}`));
        book.absent(`${name}: the owner's unfiled dataset (${how})`, await api('GET', '/api/tables/ada.parks'), await api('GET', '/api/tables/ada.never_imported'));
        book.absent(`${name}: SQL naming the owner's unfiled dataset (${how})`, await query(api, 'SELECT * FROM ada.parks'), await query(api, 'SELECT * FROM ada.never_imported'), 400);
        comparisons += 3;
      }
    }
  }

  // The console, MCP and the assistant read the right roads beside one's own.
  const expectations = name => [
    ['SELECT sentinel FROM roads', [{ sentinel: `${name}_roads` }]],
    ['SELECT sentinel FROM ada.roads', [{ sentinel: 'ada_roads' }]],
    ['SELECT sentinel FROM eli.roads', [{ sentinel: 'eli_roads' }]],
    ['SELECT a.sentinel AS mine, b.sentinel AS theirs FROM roads a, ada.roads b', [{ mine: `${name}_roads`, theirs: 'ada_roads' }]],
  ];
  for (const name of ['vic', 'eli']) {
    for (const credential of credentials(name)) {
      for (const [sql, rows] of expectations(name)) { assert.deepEqual(await rowsOf(journeyApi(base, credential), sql), rows, `${name} console: ${sql}`); transports.console++; }
    }
    const mcp = await connect(base, fetch, people[name].token);
    try {
      for (const [sql, rows] of expectations(name)) { assert.deepEqual((await mcp.call('run_sql', { sql })).preview, rows, `${name} MCP: ${sql}`); transports.mcp++; }
      const catalogue = await mcp.call('list_tables');
      assert.deepEqual(catalogue.filter(t => t.name === 'roads').map(t => [t.qualifiedName, t.owner.sqlName]).sort(),
        (name === 'vic' ? [['roads', 'vic'], ['ada.roads', 'ada'], ['eli.roads', 'eli']] : [['roads', 'eli'], ['ada.roads', 'ada']]).sort(),
        `${name}'s MCP catalogue tells the roads apart`);
      assert.deepEqual(await mcp.call('get_map', { id: ids.hiddenMap }, 'not_found'), await mcp.call('get_map', { id: missing }, 'not_found')); comparisons++;
      assert.deepEqual(await mcp.call('inspect_table', { name: 'ada.parks' }, 'not_found'), await mcp.call('inspect_table', { name: 'ada.never_imported' }, 'not_found')); comparisons++;
    } finally { await mcp.client.close(); }
    if (wire) {
      for (const [sql, rows] of expectations(name)) {
        const result = await wire.query(base, { token: people[name].token }, sql);
        assert.equal(result.ok, true, JSON.stringify(result.body));
        assert.deepEqual(result.body.preview, rows, `${name} assistant: ${sql}`); transports.assistant++;
      }
    }
  }

  // The Viewer's writes stay refused, and the project export tells the two roads apart.
  const vic = journeyApi(base, { token: people.vic.token });
  book.refused('viewer: rename the map', await vic('PATCH', `/api/maps/${ids.map}`, { body: { name: 'Viewer was here' } }), 403, PERMISSION);
  book.refused('viewer: run the workflow', await vic('POST', `/api/recipes/${ids.recipe}/runs`, { body: {} }), 403, PERMISSION);
  const exported = await vic('POST', `/api/projects/${ids.project}/export`, { body: { file: 'p', maps: [ids.map], workflows: [ids.recipe],
    datasets: [ids.tables['ada.roads'], ids.tables['eli.roads']] }, raw: true });
  assert.equal(exported.status, 200, 'the Viewer exports the project');
  const archive = zipEntries(Buffer.from(await exported.arrayBuffer()));
  assert.deepEqual([...archive.keys()].filter(n => n.startsWith('p.dezfil/datasets/')).sort(), ['p.dezfil/datasets/ada.roads.parquet', 'p.dezfil/datasets/eli.roads.parquet']);
  const manifest = JSON.parse(archive.get('p.dezfil/project.json').toString('utf8'));
  assert.deepEqual(manifest.contents.datasets.map(d => [d.id, d.qualifiedName, d.owner.sqlName]).sort(),
    [[ids.tables['ada.roads'], 'ada.roads', 'ada'], [ids.tables['eli.roads'], 'eli.roads', 'eli']].sort());
  const mapDocument = [...archive.entries()].find(([n]) => n.startsWith('p.dezfil/maps/'));
  assert.equal(JSON.parse(mapDocument[1].toString('utf8')).home, 'ada', 'the exported map carries its home');

  // The removed dataset still fails by name for the members only, and nothing rebinds after transfer.
  for (const name of ['eli', 'vic']) {
    const api = journeyApi(base, { token: people[name].token });
    const rivers = await render(api, ids.layers.rivers);
    assert.deepEqual([rivers.ok, rivers.error], [false, unavailable('rivers').error]);
    assert.deepEqual(await drawn(api, ids.layers.roads), ['ada_roads']);
    assert.deepEqual(await drawn(api, ids.layers.editor), ['eli_roads']);
  }
  assert.deepEqual(await drawn(journeyApi(base, { token: people.ada.token }), ids.layers.rivers), ['ada_rivers']);
  await linkHolds(base, state, 'on verify');

  // A non-member sees nothing: hidden equals missing across session and token, and over MCP.
  const outsiderAnswers = [];
  for (const credential of credentials('nia')) {
    const nia = journeyApi(base, credential);
    const how = credential.token ? 'token' : 'session';
    const answers = [];
    outsiderAnswers.push(answers);
    for (const [label, url] of [['project', id => `/api/projects/${id}`], ['people', id => `/api/projects/${id}/people`], ['map', id => `/api/maps/${id}`],
      ['layer', id => `/api/layers/${id}`], ['workflow', id => `/api/recipes/${id}`], ['runs', id => `/api/recipes/${id}/runs`]]) {
      const id = { project: ids.project, people: ids.project, map: ids.map, layer: ids.layers.roads, workflow: ids.recipe, runs: ids.recipe }[label];
      const hidden = await nia('GET', url(id));
      book.absent(`non-member: ${label} (${how})`, hidden, await nia('GET', url(missing))); comparisons++;
      answers.push(hidden);
    }
    book.absent(`non-member: the owner's shared dataset (${how})`, await nia('GET', '/api/tables/ada.roads'), await nia('GET', '/api/tables/ada.never_imported')); comparisons++;
    book.absent(`non-member: SQL naming the shared dataset (${how})`, await query(nia, 'SELECT * FROM ada.roads'), await query(nia, 'SELECT * FROM ada.never_imported'), 400); comparisons++;
    book.absent(`non-member: export the project (${how})`, await nia('POST', `/api/projects/${ids.project}/export`, { body: { file: 'p', maps: [ids.map] } }),
      await nia('POST', `/api/projects/${missing}/export`, { body: { file: 'p', maps: [ids.map] } })); comparisons++;
    assert.deepEqual(expectStatus(await nia('GET', '/api/maps'), 200), [], 'a non-member lists no map');
    assert.deepEqual(expectStatus(await nia('GET', '/api/projects'), 200), []);
    assert.deepEqual(expectStatus(await nia('GET', '/api/tables'), 200).map(t => t.qualifiedName), ['roads']);
    assert.deepEqual(await rowsOf(nia, 'SELECT sentinel FROM roads'), [{ sentinel: 'nia_roads' }]);
  }
  assert.deepEqual(outsiderAnswers[0], outsiderAnswers[1], 'a non-member is answered alike by token and by session'); comparisons++;
  const outsider = await connect(base, fetch, people.nia.token);
  try {
    for (const [tool, args, absentArgs] of [['get_project', { id: ids.project }, { id: missing }], ['get_map', { id: ids.map }, { id: missing }],
      ['get_recipe', { id: ids.recipe }, { id: missing }], ['inspect_table', { name: 'ada.roads' }, { name: 'ada.never_imported' }]]) {
      assert.deepEqual(await outsider.call(tool, args, 'not_found'), await outsider.call(tool, absentArgs, 'not_found')); comparisons++;
    }
    assert.deepEqual(await outsider.call('run_sql', { sql: 'SELECT * FROM ada.roads' }, 'sql_error'), await outsider.call('run_sql', { sql: 'SELECT * FROM ada.never_imported' }, 'sql_error')); comparisons++;
  } finally { await outsider.client.close(); }

  // Members and a non-member evaluate the same SQL names at once; each sees their own reach.
  const absentRoads = (await query(journeyApi(base, { token: people.nia.token }), 'SELECT sentinel FROM ada.never_imported')).json;
  let concurrent = 0;
  await Promise.all(Array.from({ length: 24 }, async (_, index) => {
    const name = ['ada', 'eli', 'vic', 'nia'][index % 4];
    const api = journeyApi(base, { token: people[name].token });
    const own = await query(api, 'SELECT sentinel FROM roads');
    assert.deepEqual(expectStatus(own, 200).preview, [{ sentinel: `${name}_roads` }], `${name} reads their own roads under load`);
    const theirs = await query(api, 'SELECT sentinel FROM ada.roads');
    if (name === 'nia') assert.deepEqual(theirs.json, JSON.parse(JSON.stringify(absentRoads).replaceAll('never_imported', 'roads')), 'the outsider is refused as for a missing dataset');
    else assert.deepEqual(expectStatus(theirs, 200).preview, [{ sentinel: 'ada_roads' }]);
    concurrent += 2;
  }));
  expectStatus(await anonymous('GET', '/api/maps'), 401);
  return { accounts: 5, comparisons, concurrentQueries: concurrent, transports, refusals: book.refusals };
}

if (process.argv[1]?.endsWith('/sharing-journey.mjs')) {
  const args = process.argv.slice(2);
  const wireArg = args.find(arg => arg.startsWith('--assistant-wire='));
  const [mode, base, stateFile] = args.filter(arg => !arg.startsWith('--'));
  assert.ok(['seed', 'verify'].includes(mode) && base && stateFile, 'usage: seed|verify origin scratch-state.json [--assistant-wire=port]');
  const url = new URL(base);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && (Number(url.port) >= 3300 || url.port === '3183'), 'use an isolated loopback port, never 3000');
  const wire = wireArg ? await assistantWire(Number(wireArg.split('=')[1])) : undefined;
  try {
    const state = mode === 'seed' ? await seedSharing(base) : JSON.parse(await readFile(stateFile, 'utf8'));
    if (mode === 'seed') await writeFile(stateFile, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    const verified = await verifySharing(base, state, { wire });
    console.log(JSON.stringify({ label: 'confirmed', mode, ...verified, seedRefusals: mode === 'seed' ? state.seedRefusals : undefined }, null, 1));
  } finally { await wire?.close(); }
}
