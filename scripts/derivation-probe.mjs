import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { publicationRequest } from './publication-probe-support.mjs';
import { assertAuthenticationBusy, assertDerivationSamples } from './derivation-probe-support.mjs';

/** The command uses real sockets. Injection is only for route-fixture tests.
 * @param {string} base
 * @param {{stateLog: string, requestImpl?: typeof publicationRequest}} options
 */
export async function derivationProbe(base, { stateLog, requestImpl = publicationRequest } = {}) {
  assert.ok(process.env.DEZFIL_DATA_DIR, 'DEZFIL_DATA_DIR must name the isolated server store');
  assert.ok(stateLog, '--state-log is required'); await readFile(stateLog);
  const account = { name: 'Derivation fixture', email: 'derivation@example.test', password: 'field notebooks in the rain' };
  let sequence = 0, authorization, cookie;
  const results = [];
  const send = async (tag, method, pathname, body, authenticated = false, source) => {
    const n = ++sequence;
    const headers = { origin: base, 'content-type': 'application/json', 'x-dezfil-test-derivation': tag,
      'x-forwarded-for': source ?? `198.18.${(n >>> 8) & 255}.${n & 255}`, ...(authenticated ? { authorization } : {}) };
    const response = await requestImpl(base, pathname, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    results.push({ tag, status: response.status, code: response.json?.error?.code }); return response;
  };
  const entry = await send('entry', 'GET', '/api/auth/entry'); assert.equal(entry.status, 200); assert.equal(entry.json.setupRequired, true, 'use a fresh store');
  const setups = await Promise.all(Array.from({ length: 12 }, (_, i) => send(`setup-${i}`, 'POST', '/api/auth/setup', account)));
  const accepted = setups.find(result => result.status === 200); assert.ok(accepted, 'setup eventually creates an account');
  for (const result of setups) {
    if (result.status === 503) assertAuthenticationBusy(result);
    else assert.ok(result.status === 200 || result.status === 409 && result.json.error.code === 'setup_complete');
  }
  cookie = accepted.headers['set-cookie']?.[0]?.split(';')[0]; assert.ok(cookie);
  const token = await requestImpl(base, '/api/account/tokens', { method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json', 'x-forwarded-for': '198.18.254.1' }, body: JSON.stringify({ name: 'Derivation probe' }) });
  assert.equal(token.status, 201); authorization = `Bearer ${token.json.secret}`;
  const signIn = (tag, email = account.email, source) => send(tag, 'POST', '/api/auth/sign-in', { email, password: account.password }, false, source);
  assert.equal((await signIn('timing-single')).status, 200);
  const pair = await Promise.all([signIn('timing-pair-0'), signIn('timing-pair-1')]); pair.forEach(result => assert.equal(result.status, 200));
  const profileBody = { email: account.email, currentPassword: account.password };
  assert.equal((await send('protected-control', 'PATCH', '/api/account', profileBody, true)).status, 200);
  const links = [];
  for (let i = 0; i < 4; i++) {
    const invited = await send(`invite-${i}`, 'POST', '/api/users', { name: `Recipient ${i}`, email: `recipient${i}@example.test` }, true);
    assert.equal(invited.status, 201); links.push(new URLSearchParams(new URL(invited.json.signInUrl).hash.slice(1)).get('secret'));
  }
  const ordinary = Array.from({ length: 40 }, (_, i) => ({ tag: `ordinary-${i}`, known: i % 2 === 0, source: `198.18.1.${i + 1}` }));
  const work = ordinary.map(item => signIn(item.tag, item.known ? account.email : `unknown${item.tag}@example.test`, item.source));
  const checks = Array.from({ length: 8 }, (_, i) => send(`protected-${i}`, 'PATCH', '/api/account', profileBody, true));
  const redemptions = links.map((secret, i) => send(`redeem-${i}`, 'POST', '/api/auth/redeem', { secret, password: account.password }));
  const [ordinaryResults, protectedResults, redeemedResults] = await Promise.all([Promise.all(work), Promise.all(checks), Promise.all(redemptions)]);
  for (const [i, result] of ordinaryResults.entries()) {
    if (result.status === 503) assertAuthenticationBusy(result);
    else assert.equal(result.status, ordinary[i].known ? 200 : 401, 'login limits must not masquerade as capacity');
  }
  for (const result of [...protectedResults, ...redeemedResults]) {
    if (result.status === 503) assertAuthenticationBusy(result); else assert.equal(result.status, 200);
  }
  assert.ok(ordinaryResults.some(result => result.status === 503), 'ordinary saturation must refuse with authentication_busy');
  assert.ok([...protectedResults, ...redeemedResults].some(result => result.status === 503), 'protected saturation must refuse with authentication_busy');
  // Every busy known sign-in retries from the same source before fifteen minutes.
  for (const [i, result] of ordinaryResults.entries()) if (result.status === 503 && ordinary[i].known) {
    assert.equal((await signIn(`retry-${i}`, account.email, ordinary[i].source)).status, 200, 'busy leaves no login lockout');
  }
  for (const [i, result] of redeemedResults.entries()) if (result.status === 503) {
    assert.equal((await send(`redeem-retry-${i}`, 'POST', '/api/auth/redeem', { secret: links[i], password: account.password })).status, 200, 'busy does not consume a link');
  }
  assert.equal((await send('password-change', 'POST', '/api/account/password', { currentPassword: account.password, password: account.password }, true)).status, 200);
  assert.equal((await signIn('password-retry')).status, 200);
  // Use the packaged recovery implementation in the image, and redeem over HTTP.
  const { recoverAdmin } = await import(pathToFileURL(path.resolve('src/lib/auth/recovery.mjs')));
  const recovered = recoverAdmin({ dataDir: process.env.DEZFIL_DATA_DIR, origin: base, email: account.email });
  const secret = new URLSearchParams(new URL(recovered.url).hash.slice(1)).get('secret');
  assert.equal((await send('recovery-redeem', 'POST', '/api/auth/redeem', { secret, password: account.password })).status, 200);
  assert.equal((await signIn('recovered-sign-in')).status, 200);
  const rows = (await readFile(stateLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const timing = assertDerivationSamples(rows);
  const result = { label: 'confirmed', timing, checks: results.length, busy: results.filter(row => row.code === 'authentication_busy').length,
    scope: 'upper bounds, capacity refusal and recovery; no exact saturation served-count assertion', results };
  console.log(JSON.stringify(result)); return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), index = args.indexOf('--state-log');
    assert.ok(args[0]?.startsWith('http://') && index > 0, 'Usage: derivation-probe.mjs ORIGIN --state-log PATH');
    await derivationProbe(args[0], { stateLog: args[index + 1] });
  } catch (error) { console.error(JSON.stringify({ label: 'failed', message: error.message })); process.exitCode = 1; }
}
