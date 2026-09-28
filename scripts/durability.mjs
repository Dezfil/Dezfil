// Seed through the API, replace the process/container, then verify the saved
// credentials and resources. Keep the mode-0600 state file in scratch storage.
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';

const [mode, base = 'http://localhost:3000', stateFile = 'durability-state.json'] = process.argv.slice(2);
const anonymous = journeyApi(base);
assert.equal((await anonymous('GET', '/api/health')).status, 200, 'readiness needs no account');

if (mode === 'seed') {
  const credentials = await provisionJourney(base);
  const api = journeyApi(base, { token: credentials.token });
  const revokedSession = await provisionJourney(base);
  assert.equal((await journeyApi(base, { cookie: revokedSession.cookie })('POST', '/api/auth/sign-out')).status, 200);
  const revoked = await api('POST', '/api/account/tokens', { body: { name: 'Revoked before replacement' } });
  assert.equal(revoked.status, 201);
  assert.equal((await api('DELETE', `/api/account/tokens/${revoked.json.id}`)).status, 200);
  const form = new FormData();
  form.append('file', new Blob(['name,lon,lat\ndurable,10,20\n']), 'durability.csv');
  const up = await api('POST', '/api/tables', { form }); assert.equal(up.status, 201);
  const map = await api('POST', '/api/maps', { body: { name: 'Durable map' } }); assert.equal(map.status, 201);
  const layer = await api('POST', `/api/maps/${map.json.id}/layers`, { body: { name: 'L', sql: `SELECT * FROM ${up.json.name}` } }); assert.equal(layer.status, 201);
  const pub = await api('POST', `/api/maps/${map.json.id}/publish`); assert.equal(pub.status, 201);
  await writeFile(stateFile, JSON.stringify({ table: up.json.name, mapId: map.json.id, layerId: layer.json.id, publication: pub.json.token,
    accountId: credentials.account.id, cookie: credentials.cookie, token: credentials.token,
    revokedCookie: revokedSession.cookie, revokedToken: revoked.json.secret }), { mode: 0o600 });
  console.log('confirmed: seeded account, live and revoked credentials, table, map, layer and publication');
} else if (mode === 'verify') {
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const api = journeyApi(base, { token: state.token });
  for (const credential of [{ token: state.token }, { cookie: state.cookie }]) {
    const session = await journeyApi(base, credential)('GET', '/api/auth/session');
    assert.equal(session.status, 200); assert.equal(session.json.account.id, state.accountId);
  }
  for (const credential of [{ token: state.revokedToken }, { cookie: state.revokedCookie }]) {
    assert.equal((await journeyApi(base, credential)('GET', '/api/maps')).status, 401);
  }
  assert.equal((await api('GET', `/api/tables/${state.table}`)).status, 200);
  const map = await api('GET', `/api/maps/${state.mapId}`); assert.equal(map.status, 200);
  assert.equal(map.json.layers.length, 1); assert.equal(map.json.layers[0].id, state.layerId);
  const query = await api('POST', '/api/query', { body: { sql: `SELECT count(*) AS n FROM ${state.table}` } });
  assert.equal(query.status, 200); assert.equal(Number(query.json.preview[0].n), 1);
  assert.equal((await anonymous('GET', `/api/published/${state.publication}`)).status, 200);
  console.log('confirmed: account, live session/token and resources survived replacement; revoked credentials stayed refused; publication remained anonymous');
} else throw new Error('usage: durability.mjs seed|verify <base-url> <scratch-state-file>');
