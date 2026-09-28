// Executable migration, restore and restart proof. Never accepts an existing
// data directory: it creates an old store and upgrades only a scratch copy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { assertEvidenceWorktree } from './dezfil-plugin-safety.mjs';
import { createLegacyStore, legacy, legacyFiles, legacyRows, readLegacyPassword } from './legacy-store-fixture.mjs';
import { provisionJourney, journeyAccount } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';

const root = process.cwd(); assertEvidenceWorktree(root);
const port = Number(process.argv[2] ?? '3389'); assert.ok(port >= 3300 && port <= 65535);
await mkdir(path.join(root, '.claude'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.claude/account-upgrade-'));
const source = path.join(directory, 'old-source'), copy = path.join(directory, 'upgrade-copy'), restored = path.join(directory, 'restored-copy');
await mkdir(source); await createLegacyStore(source);
const originalFiles = await legacyFiles(source);
const original = new Database(path.join(source, 'metadata.sqlite'), { readonly: true });
const originalRows = legacyRows(original); assert.equal(original.pragma('user_version', { simple: true }), legacy.version); original.close();
await cp(source, copy, { recursive: true }); await mkdir(path.join(copy, 'tmp'));
const base = `http://127.0.0.1:${port}`, anonymous = journeyApi(base);
let server, serverOutput = '', boots = 0;
async function boot() {
  const env = { ...process.env, DEZFIL_DATA_DIR: copy, TMPDIR: path.join(copy, 'tmp'), NEXT_TELEMETRY_DISABLED: '1', DEZFIL_TRUSTED_PROXIES: '' };
  delete env.DEZFIL_SECRET_KEY;
  server = spawn(process.execPath, ['--import=./scripts/ingress-preload.mjs', './node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', bytes => serverOutput += bytes); server.stderr.on('data', bytes => serverOutput += bytes);
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error('Proof server exited: ' + serverOutput);
    if (await fetch(base + '/api/health').then(response => response.ok).catch(() => false)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'anonymous readiness after boot'); boots++;
  return server.pid;
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const ended = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM'); await ended;
}
try {
  const firstPid = await boot();
  const entry = await anonymous('GET', '/api/auth/entry'); assert.equal(entry.status, 200);
  assert.deepEqual(entry.json, { instanceName: legacy.instance, setupRequired: true, prefillName: legacy.name });
  assert.equal((await anonymous('GET', `/api/published/${legacy.token}`)).status, 200, 'old publication remains anonymous before adoption');
  assert.equal((await anonymous('GET', '/api/maps')).status, 401);
  let db = new Database(path.join(copy, 'metadata.sqlite'));
  assert.deepEqual(legacyRows(db), originalRows, 'startup migration preserves every legacy resource row'); db.close();
  const first = await provisionJourney(base, { ...journeyAccount, name: legacy.name });
  assert.equal(first.setupRequired, true); assert.equal(first.account.isOriginal, true);
  const api = journeyApi(base, { token: first.token });
  const settings = await api('GET', '/api/settings');
  assert.equal(settings.json.displayName, legacy.name); assert.equal(settings.json.instanceName, legacy.instance); assert.deepEqual(settings.json.viewPrefs, legacy.preferences);
  db = new Database(path.join(copy, 'metadata.sqlite'));
  assert.deepEqual(legacyRows(db), originalRows, 'adoption does not rewrite resources or credentials');
  assert.equal(db.prepare("SELECT count(*) AS n FROM workspace_settings WHERE key IN ('display_name', 'view_prefs')").get().n, 0);
  assert.equal(await readLegacyPassword(copy, db), legacy.password, 'copied key decrypts the original connection envelope');
  for (const [table, column, secret] of [['auth_sessions', 'secret_hash', first.cookie.split('=')[1]], ['auth_tokens', 'secret_hash', first.token]]) {
    const digest = createHash('sha256').update(secret).digest('hex');
    assert.ok(db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(digest));
    assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes(secret), 'credential rows contain digests only');
  }
  db.close();
  assert.equal((await api('GET', `/api/maps/${legacy.map}`)).json.layers[0].id, legacy.layer);
  assert.equal((await api('GET', `/api/tables/${legacy.table}`)).status, 200);
  const query = await api('POST', '/api/query', { body: { sql: `SELECT name, value, ST_X(geometry) AS x FROM ${legacy.table}` } });
  assert.equal(query.status, 200); assert.deepEqual(query.json.preview, [{ name: 'station', value: 7, x: 13.4 }]);
  for (const endpoint of [`/api/projects/${legacy.project}`, `/api/recipes/${legacy.workflow}`]) assert.equal((await api('GET', endpoint)).status, 200, endpoint);
  const connectionRead = await api('GET', '/api/connections/postgis');
  assert.equal(connectionRead.status, 200); assert.ok(connectionRead.json.some(connection => connection.id === legacy.connection));
  assert.ok(!JSON.stringify(connectionRead.json).includes(legacy.password));
  const publication = await anonymous('GET', `/api/published/${legacy.token}`); assert.equal(publication.status, 200); assert.equal(publication.json.layers[0].render.geojson.features.length, 1);
  assert.equal((await legacyFiles(copy))['tables/legacy.parquet'], originalFiles['tables/legacy.parquet']);
  console.log('confirmed: seeded old-store COPY enters setup; old publication works before/after; name/preferences adopted, legacy keys retired; every resource row and GeoParquet bytes preserved, SQL/project/workflow/connection APIs usable, original credential decrypts, session/token storage is hashed');

  const secondSession = await provisionJourney(base);
  assert.equal((await journeyApi(base, { cookie: secondSession.cookie })('POST', '/api/auth/sign-out')).status, 200);
  const revoked = await api('POST', '/api/account/tokens', { body: { name: 'Revoked before restart' } }); assert.equal(revoked.status, 201);
  assert.equal((await api('DELETE', `/api/account/tokens/${revoked.json.id}`)).status, 200);
  const invitation = await api('POST', '/api/users', { body: { name: 'Second admin', email: 'second-admin@example.test', isAdmin: true } }); assert.equal(invitation.status, 201);
  const link = new URLSearchParams(new URL(invitation.json.signInUrl).hash.slice(1)).get('secret');
  assert.equal((await fetch(base + '/api/auth/redeem', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ secret: link, password: 'paper cranes at sunrise' }) })).status, 200);
  const second = await provisionJourney(base, { name: 'Second admin', email: 'second-admin@example.test', password: 'paper cranes at sunrise' });
  const admin = journeyApi(base, { token: second.token });
  assert.equal((await admin('PATCH', `/api/users/${first.account.id}`, { body: { isAdmin: false } })).status, 200);
  await stop(); assert.notEqual(await boot(), firstPid);
  for (const credential of [{ cookie: first.cookie }, { token: first.token }]) {
    const response = await journeyApi(base, credential)('GET', '/api/account');
    assert.equal(response.status, 200); assert.equal(response.json.account.id, first.account.id); assert.equal(response.json.account.isOriginal, true); assert.equal(response.json.account.isAdmin, false);
  }
  for (const credential of [{ cookie: secondSession.cookie }, { token: revoked.json.secret }]) assert.equal((await journeyApi(base, credential)('GET', '/api/maps')).status, 401);
  const users = await admin('GET', '/api/users'); assert.equal(users.status, 200);
  assert.equal(users.json.users.filter(user => user.isOriginal).length, 1); assert.equal(users.json.users.find(user => user.isOriginal).id, first.account.id);
  assert.deepEqual((await api('GET', '/api/settings')).json.viewPrefs, legacy.preferences);
  assert.equal((await anonymous('GET', `/api/published/${legacy.token}`)).status, 200);
  const run = await api('POST', `/api/recipes/${legacy.workflow}/steps/${legacy.step}/run`); assert.equal(run.status, 202);
  let finished;
  for (let i = 0; i < 120; i++) {
    finished = await api('GET', `/api/recipes/${legacy.workflow}/runs/${run.json.run.id}`);
    if (finished.json.run.outcome) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(finished.json.run.outcome, 'completed');
  assert.equal((await api('POST', '/api/query', { body: { sql: 'SELECT value FROM legacy_result' } })).json.preview[0].value, 7);
  console.log('confirmed: replacement PID preserves live sessions/tokens/preferences and original-account identity after another admin demotes it; revoked credentials stay refused; the old workflow runs against the old dataset');
  await stop();
  await cp(source, restored, { recursive: true });
  assert.deepEqual(await legacyFiles(source), originalFiles, 'old seed remains byte-for-byte untouched');
  assert.deepEqual(await legacyFiles(restored), originalFiles, 'restore uses the matching pre-adoption copy');
  const old = new Database(path.join(restored, 'metadata.sqlite'), { readonly: true });
  assert.equal(old.pragma('user_version', { simple: true }), legacy.version); assert.deepEqual(legacyRows(old), originalRows);
  assert.equal(await readLegacyPassword(restored, old), legacy.password); old.close();
  console.log('confirmed: restored copy matches every seed file hash and old-schema row; no automatic downgrade of the adopted store');
  await writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ boots, source, copy, restored, originalFiles, result: 'confirmed', limits: ['No live external PostGIS connection', 'No old-application HTTP restore boot', 'No browser or image rendering'] }, null, 2));
  console.log(JSON.stringify({ directory, boots, result: 'confirmed' }));
} finally { await stop(); await writeFile(path.join(directory, 'server.log'), serverOutput); }
