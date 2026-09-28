import assert from 'node:assert/strict';
import { packageFetch } from './dezfil-client-auth.mjs';

// Synthetic credentials for isolated journey stores only. Never use this
// fixture to adopt an operator's instance.
export const journeyAccount = { name: 'Journey account', email: 'journey@example.test', password: 'field notebooks at dawn' };
export const browserAccount = { ...journeyAccount, name: 'Browser fixture', email: 'entry-browser@example.test' };

export function tokenFetch(base, token, fetchImpl = fetch) {
  return packageFetch({ url: base, tokenEnv: 'credential' }, { credential: token }, fetchImpl);
}

/** Set up a fresh store or sign into this fixture's existing account. */
export async function provisionJourney(base, account = journeyAccount) {
  const origin = new URL(base).origin;
  const entry = await fetch(`${origin}/api/auth/entry`, { redirect: 'manual' });
  assert.equal(entry.status, 200, 'anonymous entry is available');
  const { setupRequired } = await entry.json();
  const signed = await fetch(`${origin}/api/auth/${setupRequired ? 'setup' : 'sign-in'}`, {
    method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(setupRequired ? account : { email: account.email, password: account.password }),
  });
  assert.equal(signed.status, 200, 'fixture account signs in');
  const cookie = signed.headers.getSetCookie().find(value => value.startsWith('dezfil_session='))?.split(';')[0];
  assert.ok(cookie, 'sign-in issues a browser session');
  const identity = (await signed.json()).account;
  const issued = await fetch(`${origin}/api/account/tokens`, {
    method: 'POST', redirect: 'manual', headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Isolated journey' }),
  });
  assert.equal(issued.status, 201, 'signed-in account creates its own token');
  const token = await issued.json();
  assert.ok(token.secret, 'token secret is returned on creation');
  return { account: identity, cookie, token: token.secret, tokenId: token.id, setupRequired, fetch: tokenFetch(origin, token.secret) };
}
