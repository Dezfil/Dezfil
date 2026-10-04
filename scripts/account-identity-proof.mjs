// Run from a built, detached evidence checkout. --old-root must also be built.
// All stores are created here; neither command accepts a live data directory.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { assertEvidenceWorktree } from './dezfil-plugin-safety.mjs';
import { createLegacyStore, legacy, legacyFiles } from './legacy-store-fixture.mjs';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { captureBasis } from './revision-fixtures.mjs';
import { recoveryCommandLink } from './account-identity-recovery.mjs';

const { values } = parseArgs({ options: { 'old-root': { type: 'string' }, port: { type: 'string', default: '3391' }, seed: { type: 'string' } } });
const root = process.cwd(); assertEvidenceWorktree(root);
assert.ok(values['old-root'], 'Supply --old-root /path/to/built/pre-feature-checkout');
const oldRoot = path.resolve(values['old-root']);
assert.match(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: oldRoot, encoding: 'utf8' }), /^2aded21/, 'old checkout must be the pinned pre-feature application');
const port = Number(values.port); assert.ok(port >= 3300 && port <= 65535);
assert.ok(!values.seed || ['row', 'home', 'trigger', 'reservation', 'foreign-key', 'writer', 'recovery'].includes(values.seed), 'known seed');
const base = `http://127.0.0.1:${port}`;
await mkdir(path.join(root, '.claude'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.claude/identity-proof-'));
const source = path.join(directory, 'populated'), copy = path.join(directory, 'migrated'), backup = path.join(directory, 'backup'), restored = path.join(directory, 'restored');
await mkdir(source); await createLegacyStore(source);
let server, output = '', stage = 'old store setup';
async function start(checkout, store) {
  const env = { ...process.env, DEZFIL_DATA_DIR: store, NEXT_TELEMETRY_DISABLED: '1', DEZFIL_TRUSTED_PROXIES: '' };
  delete env.DEZFIL_SECRET_KEY;
  server = spawn(process.execPath, ['--import=./scripts/ingress-preload.mjs', 'node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)],
    { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => { output += b; }); server.stderr.on('data', b => { output += b; });
  for (let n = 0; n < 160; n++) {
    assert.equal(server.exitCode, null, 'proof server remains alive');
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('proof server readiness timeout');
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended;
}
function snapshot(store) {
  const db = new Database(path.join(store, 'metadata.sqlite'), { readonly: true });
  try {
    const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE NOT (type = 'table' AND name = 'accounts') ORDER BY type, name").all();
    const rows = Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    assert.deepEqual(db.pragma('foreign_key_check'), [], 'all account references hold');
    return { schema, rows, version: db.pragma('user_version', { simple: true }) };
  } finally { db.close(); }
}
async function recover(store) {
  const link = recoveryCommandLink(root, store, base, 'remaining@example.test');
  const secret = new URLSearchParams(new URL(link).hash.slice(1)).get('secret');
  const response = await fetch(base + '/api/auth/redeem', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ secret, password: 'recovered paper cranes at dawn' }) });
  assert.equal(response.status, 200, 'matching recovery link redeems');
  assert.equal((await response.json()).account.email, 'remaining@example.test');
  assert.ok(!output.includes(secret), 'recovery secret stays out of server logs');
}
try {
  await start(oldRoot, source);
  const first = await provisionJourney(base);
  const api = journeyApi(base, { token: first.token });
  const invited = await api('POST', '/api/users', { body: { name: 'Remaining admin', email: 'remaining@example.test', isAdmin: true } });
  assert.equal(invited.status, 201);
  const secret = new URLSearchParams(new URL(invited.json.signInUrl).hash.slice(1)).get('secret');
  assert.equal((await fetch(base + '/api/auth/redeem', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ secret, password: 'remaining paper cranes at dawn' }) })).status, 200);
  await stop();
  const before = snapshot(source); assert.equal(before.version, 46);
  await cp(source, backup, { recursive: true }); await cp(source, copy, { recursive: true });
  const hashes = await legacyFiles(backup);
  stage = 'populated upgrade'; await start(root, copy);
  const anonymous = journeyApi(base);
  assert.equal((await anonymous('GET', '/api/auth/entry')).json.setupRequired, false);
  if (values.seed && !['writer', 'recovery'].includes(values.seed)) {
    const db = new Database(path.join(copy, 'metadata.sqlite'));
    if (values.seed === 'row') db.exec("UPDATE accounts SET name = 'Wrong label'");
    if (values.seed === 'trigger') db.exec('DROP TRIGGER accounts_sql_name_fixed');
    if (values.seed === 'home') db.exec("DROP TRIGGER maps_home_fixed; UPDATE maps SET home_account_id = NULL");
    if (values.seed === 'reservation') db.exec("DROP TRIGGER accounts_sql_name_fixed; UPDATE accounts SET sql_name = 'changed' WHERE id = (SELECT account_id FROM original_account)");
    if (values.seed === 'foreign-key') db.exec("PRAGMA foreign_keys = OFF; UPDATE auth_tokens SET account_id = 'missing'");
    db.close();
  }
  let migrated = snapshot(copy); assert.equal(migrated.version, 47);
  assert.deepEqual(migrated.schema, before.schema, 'every non-accounts schema entry is byte-identical');
  assert.deepEqual(migrated.rows, before.rows, 'every populated row, home and fact is unchanged');
  assert.equal((await api('GET', `/api/maps/${legacy.map}`)).status, 200);
  migrated = snapshot(copy);
  await stop(); await start(root, copy);
  assert.equal((await anonymous('GET', '/api/auth/entry')).json.setupRequired, false);
  assert.deepEqual(snapshot(copy), migrated, 'repeat opening changes nothing'); await stop();
  console.log('confirmed: populated upgrade preserves all rows and non-accounts schema; repeat opening and foreign keys hold');

  stage = 'old application reads and writes'; await start(oldRoot, copy);
  const map = await api('GET', `/api/maps/${legacy.map}`); assert.equal(map.status, 200);
  if (values.seed !== 'writer') assert.equal((await api('PATCH', `/api/maps/${legacy.map}`, { basis: captureBasis(map.json), body: { name: 'Older writer persisted this' } })).status, 200);
  assert.equal((await api('GET', `/api/maps/${legacy.map}`)).json.name, 'Older writer persisted this', 'old writer changes are readable');
  const invitation = await api('POST', '/api/users', { body: { name: 'Older invitation', email: 'older@example.test' } }); assert.equal(invitation.status, 201);
  await stop(); await start(root, copy);
  assert.equal((await api('GET', `/api/maps/${legacy.map}`)).json.name, 'Older writer persisted this');
  assert.ok((await api('GET', '/api/users')).json.users.some(a => a.id === invitation.json.account.id));
  assert.ok(snapshot(copy).rows.accounts.every(a => !['deleting', 'deleted'].includes(a.status)));
  console.log('confirmed: pinned older application reads and writes migrated accounts and content; replacement preserves writes');

  stage = 'matching recovery command';
  if (values.seed === 'recovery') { const db = new Database(path.join(copy, 'metadata.sqlite')); db.pragma('user_version = 46'); db.close(); }
  await recover(copy); await stop();
  console.log('confirmed: matching terminal recovery command against migrated store redeems for remaining admin');
  stage = 'whole scratch restoration'; await cp(backup, restored, { recursive: true });
  assert.deepEqual(await legacyFiles(restored), hashes); assert.deepEqual(snapshot(restored), before);
  await start(oldRoot, restored);
  assert.equal((await api('GET', `/api/maps/${legacy.map}`)).json.name, before.rows.maps[0].name);
  assert.equal(snapshot(restored).version, 46); await stop();
  assert.deepEqual(await legacyFiles(backup), hashes, 'backup unchanged');
  assert.deepEqual(await readFile(path.join(restored, 'secret.key')), await readFile(path.join(backup, 'secret.key')));
  await writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ directory, result: 'confirmed', oldRoot, port, limits: ['No deletion exercised', 'No recovery claim for old application'] }, null, 2));
  console.log('confirmed: whole stopped scratch restore, key and artifacts match; old application reads restored store');
  console.log(`PASS: identity upgrade, compatibility, recovery and restore. Evidence: ${directory}`);
} catch (error) {
  console.error(`FAIL: ${stage}: ${error.message}`); process.exitCode = 1;
} finally { await stop(); await writeFile(path.join(directory, 'server.log'), output); }
