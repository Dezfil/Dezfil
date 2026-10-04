import assert from 'node:assert/strict';
import { journeyApi } from './journey-http.mjs';
import { good } from './deletion-journey-roads.mjs';

export async function recoverRemainingAdmin(base, { admin, fixture }, link) {
  const secret = new URLSearchParams(new URL(link.trim()).hash.slice(1)).get('secret');
  const recovered = good(await journeyApi(base, { origin: new URL(base).origin })('POST', '/api/auth/redeem', { body: { secret, password: 'recovered paper cranes before sunrise' } }));
  assert.equal(recovered.account.id, admin.account.id); assert.equal(recovered.account.isAdmin, true);
  assert.equal((await journeyApi(base, { cookie: admin.cookie })('GET', '/api/maps')).status, 401);
  assert.equal((await journeyApi(base, fixture.control)('GET', `/api/maps/${fixture.controlMap.id}`)).status, 200);
}
