// Run on an isolated dual-stack listener with DEZFIL_TRUSTED_PROXIES=127.0.0.1.
// The full arm waits out the real published retry deadline without changing clocks.
import assert from 'node:assert/strict';
import http from 'node:http';
import { provisionJourney, journeyAccount } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';

export async function loginHttpProbe(port, { recovery = true } = {}) {
  const base = `http://127.0.0.1:${port}`, directOrigin = `http://[::1]:${port}`;
  const fixture = await provisionJourney(base), api = journeyApi(base, { token: fixture.token });
  const member = { name: 'Limit member', email: 'limit-member@example.test', password: 'marigold' };
  const invitation = await api('POST', '/api/users', { body: { name: member.name, email: member.email } }); assert.equal(invitation.status, 201);
  const secret = new URLSearchParams(new URL(invitation.json.signInUrl).hash.slice(1)).get('secret');
  const redeemed = await fetch(base + '/api/auth/redeem', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ secret, password: member.password }) }); assert.equal(redeemed.status, 200);
  const request = (peer, email, password, headers) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ email, password });
    const req = http.request({ host: peer, port, path: '/api/auth/sign-in', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, res => {
      let text = ''; res.on('data', bytes => text += bytes); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    }); req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('Sign-in timed out'))); req.end(body);
  });
  const proxy = source => ({ origin: 'https://maps.example', 'x-forwarded-for': source, 'x-forwarded-host': 'maps.example', 'x-forwarded-proto': 'https', 'x-forwarded-port': '443' });
  const forged = { origin: directOrigin, ...proxy('203.0.113.99'), forwarded: 'for=203.0.113.99;host=forged.example;proto=https', 'x-dezfil-ingress': 'caller-supplied' }; forged.origin = directOrigin;
  const plain = await request('::1', member.email, member.password, forged); assert.equal(plain.status, 200);
  assert.ok(!plain.headers['set-cookie'].some(value => /; Secure/i.test(value)), 'forged protocol cannot mark local HTTP secure');
  const secure = await request('127.0.0.1', member.email, member.password, proxy('198.51.100.50')); assert.equal(secure.status, 200);
  assert.ok(secure.headers['set-cookie'].some(value => /; Secure/i.test(value)), 'trusted HTTPS controls cookie security');
  assert.equal((await request('::1', member.email, member.password, { ...forged, origin: 'https://maps.example' })).status, 403, 'forged host/protocol cannot approve an unrelated Origin');
  for (const email of [journeyAccount.email, member.email]) {
    for (let i = 0; i < 5; i++) assert.equal((await request('127.0.0.1', email, 'incorrect', proxy(`198.51.100.${i + 1}`))).status, 401);
  }
  const account = await request('127.0.0.1', journeyAccount.email, journeyAccount.password, proxy('198.51.100.1'));
  assert.equal(account.status, 429);
  assert.equal((await request('127.0.0.1', member.email, 'incorrect', proxy('198.51.100.52'))).status, 401);
  assert.equal((await request('127.0.0.1', member.email, member.password, proxy('198.51.100.52'))).status, 429);
  assert.equal((await request('127.0.0.1', member.email, member.password, proxy('198.51.100.50'))).status, 200);
  for (let i = 0; i < 20; i++) assert.equal((await request('::1', `unknown-${i}@example.test`, 'incorrect', { ...forged, 'x-forwarded-for': `203.0.113.${i + 1}` })).status, 401);
  const source = await request('::1', member.email, member.password, forged); assert.equal(source.status, 429);
  assert.equal((await request('127.0.0.1', member.email, member.password, proxy('198.51.100.51'))).status, 200);
  for (const limited of [account, source]) {
    assert.equal(limited.body.error.code, 'rate_limited');
    assert.equal(Number(limited.headers['retry-after']), limited.body.error.retryAfter);
    assert.ok(limited.body.error.retryAfter > 0);
    assert.equal(limited.headers['cache-control'], 'private, no-store');
    assert.ok(Date.parse(limited.body.error.retryAt) > Date.now());
  }
  console.log('confirmed: clean-source correct passwords survive account failures, wrong passwords count, and sources with recent failures remain throttled; socket source budgets, forged forwarding refusal, retry deadline and secure-cookie truth');
  if (recovery) {
    const until = Math.max(Date.parse(account.body.error.retryAt), Date.parse(source.body.error.retryAt));
    console.log(`Waiting for the real retry deadline: ${new Date(until).toISOString()}`);
    while (Date.now() <= until) await new Promise(resolve => setTimeout(resolve, Math.min(5000, until - Date.now() + 100)));
    assert.equal((await request('127.0.0.1', journeyAccount.email, journeyAccount.password, proxy('198.51.100.1'))).status, 200);
    assert.equal((await request('::1', member.email, member.password, forged)).status, 200);
    console.log('confirmed: account and source recover at the advertised deadline without administrator action or clock changes');
  }
}
if (process.argv[1]?.endsWith('/login-http-probe.mjs')) await loginHttpProbe(Number(process.argv[2]), { recovery: !process.argv.includes('--no-wait') });
