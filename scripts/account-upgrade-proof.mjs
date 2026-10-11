import { captureBasis } from "./revision-fixtures.mjs";
// Executable migration, restore and restart proof. Never accepts an existing
// data directory: it creates an old store and upgrades only a scratch copy.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseArgs } from 'node:util';
import { deleteOriginal, assertSetupClosed, assertOriginalIdentity } from './deletion-recovery-checks.mjs';
import { recoveryCommandLink } from './account-identity-recovery.mjs';
import { assertEvidenceWorktree } from './dezfil-plugin-safety.mjs';
import { createLegacyStore, legacy, legacyFiles, legacyRows, readLegacyPassword, assertLegacyOwners } from './legacy-store-fixture.mjs';
import { provisionJourney, journeyAccount } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { withUpgradeStore } from './account-upgrade-store.mjs';

const root = process.cwd(); assertEvidenceWorktree(root);
const { values, positionals } = parseArgs({ allowPositionals: true, options: { container: { type: 'string' }, port: { type: 'string' } } });
const image = values.container, container = `dezfil-upgrade-${process.pid}-${Date.now()}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' });
const port = Number(values.port ?? positionals[0] ?? '3389'); assert.ok(port >= 3300 && port <= 65535);
await mkdir(path.join(root, '.claude'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.claude/account-upgrade-'));
const source = path.join(directory, 'old-source'), copy = path.join(directory, 'upgrade-copy'), restored = path.join(directory, 'restored-copy');
await mkdir(source); await createLegacyStore(source);
const originalFiles = await legacyFiles(source);
const original = new Database(path.join(source, 'metadata.sqlite'), { readonly: true });
const originalRows = legacyRows(original); assert.equal(original.pragma('user_version', { simple: true }), legacy.version); original.close();
await cp(source, copy, { recursive: true }); await mkdir(path.join(copy, 'tmp'));
const base = `http://127.0.0.1:${port}`, anonymous = journeyApi(base, { origin: new URL(base).origin });
const inspectStore = inspect => withUpgradeStore({ directory: copy, scratch: directory, container: image ? container : undefined, docker }, inspect);
let server, serverOutput = '', boots = 0;
async function boot() {
  const env = { ...process.env, DEZFIL_DATA_DIR: copy, TMPDIR: path.join(copy, 'tmp'), NEXT_TELEMETRY_DISABLED: '1', DEZFIL_TRUSTED_PROXIES: '' };
  delete env.DEZFIL_SECRET_KEY;
  if (image) {
    docker('run', '-d', '--name', container, '--user', `${process.getuid()}:${process.getgid()}`, '-v', `${copy}:/data`, '-p', `127.0.0.1:${port}:3000`, image);
  } else {
  server = spawn(process.execPath, ['--import=./scripts/ingress-preload.mjs', './node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', bytes => serverOutput += bytes); server.stderr.on('data', bytes => serverOutput += bytes);
  }
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (!image && server.exitCode !== null) throw new Error('Proof server exited: ' + serverOutput);
    if (await fetch(base + '/api/health').then(response => response.ok).catch(() => false)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'anonymous readiness after boot'); boots++;
  return image ? docker('inspect', '--format', '{{.Id}}', container).trim() : server.pid;
}
async function stop() {
  if (image) {
    try { serverOutput += docker('logs', container); docker('rm', '-f', '-v', container); } catch { return; }
    for (let i = 0; i < 30; i++) {
      try { docker('container', 'inspect', container); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Previous upgrade container name is still in use');
  }
  if (!server || server.exitCode !== null) return;
  const owners = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
  assert.deepEqual(owners, [server.pid], 'only the proof server owns the port');
  const ended = new Promise(resolve => server.once('exit', resolve));
  process.kill(owners[0], 'SIGTERM'); await ended;
}
try {
  const firstPid = await boot();
  const entry = await anonymous('GET', '/api/auth/entry'); assert.equal(entry.status, 200);
  // The upgrade's own claim: the old store enters setup under its name, its
  // display name offered to the first account. The read's other fields are
  // the sign-in screens' settings, whose whole shape the unit suite holds.
  const { instanceName, setupRequired, prefillName } = entry.json;
  assert.deepEqual({ instanceName, setupRequired, prefillName }, { instanceName: legacy.instance, setupRequired: true, prefillName: legacy.name });
  assert.equal((await anonymous('GET', `/api/published/${legacy.token}`)).status, 200, 'old publication remains anonymous before adoption');
  assert.equal((await anonymous('GET', '/api/maps')).status, 401);
  await inspectStore(db => {
    assert.deepEqual(legacyRows(db), originalRows, 'startup migration preserves every legacy resource row');
    assertLegacyOwners(db, null);
  });
  const first = await provisionJourney(base, { ...journeyAccount, name: legacy.name });
  assert.equal(first.setupRequired, true); assert.equal(first.account.isOriginal, true);
  const api = journeyApi(base, { token: first.token });
  const settings = await api('GET', '/api/settings');
  assert.equal(settings.json.displayName, legacy.name); assert.equal(settings.json.instanceName, legacy.instance); assert.deepEqual(settings.json.viewPrefs, legacy.preferences);
  await inspectStore(async db => {
    assert.deepEqual(legacyRows(db), originalRows, 'adoption does not rewrite resources or credentials');
    assertLegacyOwners(db, first.account.id);
    assert.equal(db.prepare("SELECT count(*) AS n FROM workspace_settings WHERE key IN ('display_name', 'view_prefs')").get().n, 0);
    assert.equal(await readLegacyPassword(copy, db), legacy.password, 'copied key decrypts the original connection envelope');
    for (const [table, column, secret] of [['auth_sessions', 'secret_hash', first.cookie.split('=')[1]], ['auth_tokens', 'secret_hash', first.token]]) {
      const digest = createHash('sha256').update(secret).digest('hex');
      assert.ok(db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(digest));
      assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes(secret), 'credential rows contain digests only');
    }
  });
  assert.equal((await api('GET', `/api/maps/${legacy.map}`)).json.layers[0].id, legacy.layer);
  assert.equal((await api('GET', `/api/tables/${legacy.table}`)).status, 200);
  const query = await api('POST', '/api/query', { body: { sql: `SELECT name, value, ST_X(geometry) AS x FROM ${legacy.table}` } });
  assert.equal(query.status, 200); assert.deepEqual(query.json.preview, [{ name: 'station', value: 7, x: 13.4 }]);
  for (const endpoint of [`/api/projects/${legacy.project}`, `/api/recipes/${legacy.workflow}`]) assert.equal((await api('GET', endpoint)).status, 200, endpoint);
  const connectionRead = await api('GET', '/api/connections/postgis');
  assert.equal(connectionRead.status, 200); assert.ok(connectionRead.json.some(connection => connection.id === legacy.connection));
  assert.ok(!JSON.stringify(connectionRead.json).includes(legacy.password));
  const publication = await anonymous('GET', `/api/published/${legacy.token}`); assert.equal(publication.status, 200); assert.equal(publication.json.layers[0].render.geojson.features.length, 1);
  assert.equal(createHash('sha256').update(await readFile(path.join(copy, 'tables/legacy.parquet'))).digest('hex'), originalFiles['tables/legacy.parquet']);
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
  for (const endpoint of [`/api/maps/${legacy.map}`, `/api/tables/${legacy.table}`, `/api/projects/${legacy.project}`, `/api/recipes/${legacy.workflow}`, '/api/operations/runs/legacy-job']) {
    assert.equal((await admin('GET', endpoint)).status, 404, 'another admin cannot read adopted work');
  }
  assert.deepEqual((await admin('GET', '/api/connections/postgis')).json, []);
  const hiddenSql = await admin('POST', '/api/query', { body: { sql: `SELECT * FROM ${legacy.table}` } });
  assert.equal(hiddenSql.status, 400);
  assert.deepEqual(hiddenSql, await admin('POST', '/api/query', { body: { sql: 'SELECT * FROM never_imported' } }));
  assert.equal((await admin('PATCH', `/api/users/${first.account.id}`, { body: { isAdmin: false } })).status, 200);
  await stop(); assert.notEqual(await boot(), firstPid);
  await inspectStore(db => {
    assertLegacyOwners(db, first.account.id);
    assert.deepEqual(legacyRows(db), originalRows, 'restart preserves identities, SQL, histories, memberships and lineage');
  });
  for (const credential of [{ cookie: first.cookie }, { token: first.token }]) {
    const response = await journeyApi(base, credential)('GET', '/api/account');
    assert.equal(response.status, 200); assert.equal(response.json.account.id, first.account.id); assert.equal(response.json.account.isOriginal, true); assert.equal(response.json.account.isAdmin, false);
  }
  for (const credential of [{ cookie: secondSession.cookie }, { token: revoked.json.secret }]) assert.equal((await journeyApi(base, credential)('GET', '/api/maps')).status, 401);
  const users = await admin('GET', '/api/users'); assert.equal(users.status, 200);
  assert.equal(users.json.users.filter(user => user.isOriginal).length, 1); assert.equal(users.json.users.find(user => user.isOriginal).id, first.account.id);
  assert.deepEqual((await api('GET', '/api/settings')).json.viewPrefs, legacy.preferences);
  assert.equal((await anonymous('GET', `/api/published/${legacy.token}`)).status, 200);
  assert.equal((await admin('GET', `/api/maps/${legacy.map}`)).status, 404);
  assert.equal((await api('GET', '/api/operations/runs/legacy-job')).status, 200);
  const download = await api('GET', `/api/tables/${legacy.table}/export?format=csv`, { raw: true });
  assert.equal(download.status, 200); assert.ok((await download.text()).includes('station'));
  const run = await api('POST', `/api/recipes/${legacy.workflow}/steps/${legacy.step}/run`, { basis: captureBasis((await api('GET', `/api/recipes/${legacy.workflow}`)).json) }); assert.equal(run.status, 202);
  let finished;
  for (let i = 0; i < 120; i++) {
    finished = await api('GET', `/api/recipes/${legacy.workflow}/runs/${run.json.run.id}`);
    if (finished.json.run.outcome) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(finished.json.run.outcome, 'completed');
  assert.equal((await api('POST', '/api/query', { body: { sql: 'SELECT value FROM legacy_result' } })).json.preview[0].value, 7);
  console.log('confirmed: replacement PID preserves live sessions/tokens/preferences, all resource owners, histories, memberships and lineage after another admin demotes the original account; cross-account and revoked credentials stay refused; the old dataset exports and workflow runs');
  // Transfer while the owner is active; SQL homes must survive its later erasure.
  assert.equal((await api('PUT', `/api/projects/${legacy.project}/people/${second.account.sqlName}`, { body: { role: 'editor' } })).status, 200);
  for (const [kind, id] of [['maps', legacy.map], ['recipes', legacy.workflow]]) {
    const response = await api('GET', `/api/${kind}/${id}`);
    const document = kind === 'recipes' ? response.json.recipe : response.json;
    assert.equal((await api('POST', `/api/${kind}/${id}/transfer`, { basis: captureBasis(document), body: { to: second.account.sqlName } })).status, 200);
  }
  await deleteOriginal((method, route, body) => admin(method, route, { body }), first.account);
  await assertSetupClosed((method, route, body) => anonymous(method, route, { body }));
  const homes = [['maps', legacy.map, second.account.id], ['recipes', legacy.workflow, second.account.id]];
  await inspectStore(db => assertOriginalIdentity(db, first.account.id, homes));
  await stop(); await boot();
  await assertSetupClosed((method, route, body) => anonymous(method, route, { body }));
  let recoveryLink;
  if (image) {
    const terminal = docker('exec', '-t', container, 'node', 'scripts/admin-recover.mjs', '--data-dir', '/data', '--origin', base, '--email', 'second-admin@example.test');
    const links = terminal.match(/https?:\/\/[^\s]+\/accept#secret=dz_link_[\w-]+/g) ?? [];
    assert.equal(links.length, 1, 'matching recovery command issues exactly one link'); recoveryLink = links[0];
  } else recoveryLink = recoveryCommandLink(root, copy, base, 'second-admin@example.test');
  const recoverySecret = new URLSearchParams(new URL(recoveryLink).hash.slice(1)).get('secret');
  const recovered = await anonymous('POST', '/api/auth/redeem', { body: { secret: recoverySecret, password: 'recovered paper cranes at sunrise' } });
  assert.equal(recovered.status, 200, 'remaining admin recovery redeems after original deletion');
  assert.equal(recovered.json.account.id, second.account.id);
  await inspectStore(db => assertOriginalIdentity(db, first.account.id, homes));
  console.log('confirmed: original-profile deletion keeps setup closed, adoption and transferred homes fixed; matching remaining-admin recovery redeems after restart');
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
} finally { await stop(); await writeFile(path.join(directory, 'server.log'), serverOutput); for (const store of [source, copy, restored]) await rm(store, { recursive: true, force: true }); }
