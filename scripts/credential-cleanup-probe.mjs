import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCleanupSnapshot, snapshotCredentials, oldCounts, seedCleanupBacklog, seedCleanupControls, day } from './credential-cleanup-fixture.mjs';
const account = { name: 'Cleanup fixture', email: 'cleanup@example.test', password: 'field notebooks before sunrise' };

/** Direct row access is confined to this isolated probe's fixture store.
 * The assertions of live use always go through the credential HTTP operations. */
export async function cleanupProbe(mode, base, db, state, fetchImpl = fetch) {
  let checks = 0;
  const send = async (method, pathname, body, credential = {}) => {
    const response = await fetchImpl(base + pathname, { method, headers: { origin: base, 'content-type': 'application/json', ...credential },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    const json = await response.json(); checks++;
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return { status: response.status, json, cookie: response.headers.getSetCookie()[0]?.split(';')[0] };
  };
  if (mode === 'prepare') {
    const entry = await send('GET', '/api/auth/entry'); assert.equal(entry.status, 200); assert.equal(entry.json.setupRequired, true, 'use a fresh store');
    const first = await send('POST', '/api/auth/setup', account); assert.equal(first.status, 200); assert.ok(first.cookie);
    const token = await send('POST', '/api/account/tokens', { name: 'Cleanup live control' }, { cookie: first.cookie }); assert.equal(token.status, 201);
    state.accountId = first.json.account.id; state.cookie = first.cookie; state.token = token.json.secret;
    const initial = snapshotCredentials(db).sessions.length;
    for (let i = 0; i < 6; i++) {
      const signed = await send('POST', '/api/auth/sign-in', { email: account.email, password: account.password }); assert.equal(signed.status, 200); assert.ok(signed.cookie);
    }
    assert.equal(snapshotCredentials(db).sessions.length, initial + 6, 'each repeated sign-in issues one live session');
    const invited = await send('POST', '/api/users', { name: 'Link control', email: 'cleanup-link@example.test' }, { authorization: `Bearer ${state.token}` }); assert.equal(invited.status, 201);
    state.seededAt = Date.now();
    seedCleanupControls(db, state.accountId, invited.json.account.id, state.seededAt);
    seedCleanupBacklog(db, state.accountId, state.seededAt);
    state.before = snapshotCredentials(db);
    assert.deepEqual(oldCounts(state.before), { sessions: 1201, links: 1201, tokens: 1201 });
    return { label: 'confirmed', mode, checks, rows: Object.fromEntries(Object.entries(state.before).map(([kind, ids]) => [kind, ids.length])) };
  }
  assert.ok(mode === 'sweep' || mode === 'restart', 'unknown cleanup mode');
  const boot = snapshotCredentials(db);
  // No credential HTTP call before this snapshot: health never drives maintenance.
  assertCleanupSnapshot(state.before, boot, 'boot'); checks++;
  for (let i = 0; i < 8; i++) {
    const live = await send('GET', '/api/auth/session', undefined, i % 2 ? { authorization: `Bearer ${state.token}` } : { cookie: state.cookie });
    assert.equal(live.status, 200); assert.equal(live.json.account.id, state.accountId);
  }
  const drained = snapshotCredentials(db); assertCleanupSnapshot(state.before, drained, 'drain'); checks++;
  const rolled = db.prepare('SELECT expires_at FROM auth_sessions WHERE account_id = ? AND revoked_at IS NULL ORDER BY expires_at DESC LIMIT 1').get(state.accountId);
  assert.ok(rolled.expires_at >= state.seededAt + 30 * day, 'live session keeps its rolling lifetime');
  const tokens = await send('GET', '/api/account/tokens', undefined, { authorization: `Bearer ${state.token}` }); assert.equal(tokens.status, 200);
  assert.ok(tokens.json.tokens.some(row => row.id === 'cleanup-recent-token' && row.revokedAt), 'recent history retains revocation');
  assert.ok(!tokens.json.tokens.some(row => row.id.startsWith('cleanup-old-')), 'removed history disappears on refresh');
  for (const id of ['cleanup-old-00000', 'unknown-token']) {
    const removed = await send('DELETE', `/api/account/tokens/${id}`, undefined, { authorization: `Bearer ${state.token}` });
    assert.equal(removed.status, 404); assert.deepEqual(removed.json, { error: { code: 'not_found', message: 'Token not found.' } });
  }
  for (const secret of ['cleanup-recent-token', 'cleanup-old-00000']) {
    const refused = await send('GET', '/api/auth/session', undefined, { authorization: `Bearer ${secret}` });
    assert.equal(refused.status, 401); assert.equal(refused.json.error.code, 'authentication_required');
  }
  if (mode === 'sweep') {
    for (const secret of ['cleanup-ordinary', 'cleanup-recovery']) {
      const redeemed = await send('POST', '/api/auth/redeem', { secret, password: account.password }); assert.equal(redeemed.status, 200); assert.ok(redeemed.cookie);
      state.redeemedCookie = redeemed.cookie;
      assert.equal((await send('GET', '/api/auth/session', undefined, { cookie: redeemed.cookie })).status, 200);
    }
    seedCleanupBacklog(db, state.accountId, Date.now(), 11);
    state.before = snapshotCredentials(db);
  } else {
    assert.equal((await send('GET', '/api/auth/session', undefined, { cookie: state.redeemedCookie })).status, 200);
    for (const id of ['cleanup-ordinary', 'cleanup-recovery']) assert.ok(db.prepare('SELECT consumed_at FROM auth_links WHERE id = ?').get(id)?.consumed_at, 'consumed links retained until expiry plus margin');
  }
  return { label: 'confirmed', mode, checks, bootOld: oldCounts(boot), drainedOld: oldCounts(drained) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, base] = process.argv.slice(2), directory = process.env.DEZFIL_DATA_DIR;
    assert.ok(directory && base?.startsWith('http://'), 'Usage: DEZFIL_DATA_DIR=SCRATCH node credential-cleanup-probe.mjs prepare|sweep|restart ORIGIN');
    const Database = createRequire(path.join(process.cwd(), 'package.json'))('better-sqlite3');
    const db = new Database(path.join(directory, 'metadata.sqlite'), { fileMustExist: true }); db.pragma('foreign_keys = ON');
    const file = path.join(directory, 'cleanup-state.json');
    try {
      const state = mode === 'prepare' ? {} : JSON.parse(readFileSync(file, 'utf8'));
      const result = await cleanupProbe(mode, base, db, state);
      writeFileSync(file, JSON.stringify(state), { mode: 0o600 }); console.log(JSON.stringify(result));
    } finally { db.close(); }
  } catch (error) { console.error(JSON.stringify({ label: 'failed', message: error.message })); process.exitCode = 1; }
}
