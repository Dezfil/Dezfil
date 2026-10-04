import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
export async function deleteOriginal(api, original) {
  assert.equal((await api('PATCH', `/api/users/${original.id}`, { status: 'deactivated' })).status, 200);
  const preview = await api('GET', `/api/users/${original.id}/deletion-preview`);
  assert.equal(preview.status, 200);
  let result = await api('DELETE', `/api/users/${original.id}`, { confirm: true, confirmation: preview.json.confirmation, email: original.email });
  assert.ok([200, 202].includes(result.status), 'original deletion accepted');
  const id = result.json.id;
  for (let i = 0; result.json.state !== 'completed'; i++) {
    assert.ok(i < 100, 'original deletion completes'); await delay(100);
    result = await api('POST', `/api/users/deletions/${id}/finish`);
    if (result.status === 404) break; // Only the identifier returned by accepted deletion.
    assert.ok([200, 202].includes(result.status), 'original continuation accepted');
  }
  assert.equal((await api('GET', `/api/users/deletions/${id}`)).status, 404);
}
export async function assertSetupClosed(api) {
  assert.equal((await api('GET', '/api/auth/entry')).json.setupRequired, false, 'original-profile deletion must not reopen setup');
  const refused = await api('POST', '/api/auth/setup', { name: 'Must not adopt', email: 'new-adopter@example.test', password: 'paper cranes before sunrise' });
  assert.equal(refused.status, 409, 'deleted original never permits re-adoption');
  assert.equal(refused.json.error.code, 'setup_complete');
}
export function assertOriginalIdentity(db, originalId, homes) {
  assert.equal(db.prepare('SELECT account_id FROM original_account').get().account_id, originalId, 'adoption marker retained');
  const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(originalId);
  assert.equal(row.status, 'deleted', 'original profile really deleted');
  for (const key of ['name', 'email', 'password_hash', 'is_admin', 'created_at', 'updated_at', 'last_sign_in_at']) assert.equal(row[key], null, `original ${key} erased`);
  for (const [table, id, owner] of homes) assert.deepEqual(db.prepare(`SELECT owner_id,home_account_id FROM ${table} WHERE id=?`).get(id), { owner_id: owner, home_account_id: originalId }, 'transferred home and ownership retained');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
}
