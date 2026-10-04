import assert from 'node:assert/strict';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
const PASSWORD = 'field notebooks at dawn';
const expectStatus = (response, status, label = '') => {
  assert.equal(response.status, status, `${label} ${JSON.stringify(response.json)}`);
  return response.json;
};

export async function invite(base, admin, name) {
  const email = `${name}@example.test`;
  const invitation = expectStatus(await admin('POST', '/api/users', { body: { name, email } }), 201, `invite ${name}`);
  const secret = new URLSearchParams(new URL(invitation.signInUrl).hash.slice(1)).get('secret');
  const redeemed = await fetch(base + '/api/auth/redeem', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ secret, password: PASSWORD }) });
  assert.equal(redeemed.status, 200); await redeemed.body?.cancel();
  return signIn(base, name);
}

/** A fresh session and token for one of the journey's people. */
export async function signIn(base, name) {
  const credential = await provisionJourney(base, { name, email: `${name}@example.test`, password: PASSWORD });
  const account = expectStatus(await journeyApi(base, { token: credential.token })('GET', '/api/account'), 200).account;
  return { id: account.id, name, sqlName: account.sqlName, token: credential.token, cookie: credential.cookie };
}

