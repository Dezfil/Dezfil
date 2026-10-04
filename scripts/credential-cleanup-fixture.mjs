import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const day = 86_400_000;
const hash = value => createHash('sha256').update(value).digest('hex');
export const kinds = ['sessions', 'links', 'tokens'];
const oldPrefix = 'cleanup-old-';

export function snapshotCredentials(db) {
  return Object.fromEntries(kinds.map(kind => [kind, db.prepare(`SELECT id FROM auth_${kind} ORDER BY id`).all().map(row => row.id)]));
}
export function oldCounts(snapshot) {
  return Object.fromEntries(kinds.map(kind => [kind, snapshot[kind].filter(id => id.startsWith(oldPrefix)).length]));
}
export function seedCleanupBacklog(db, accountId, now, count = 1201) {
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = oldPrefix + String(i).padStart(5, '0'), flag = i % 3;
      db.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, hash(id), accountId, now - 40 * day, now - 2 * day, now - 40 * day, flag ? now - 3 * day : null);
      db.prepare('INSERT INTO auth_links VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, accountId, flag ? 'reset' : 'invite', hash(id), now - 40 * day, now - 2 * day, flag === 1 ? now - 3 * day : null, flag === 2 ? now - 3 * day : null);
      db.prepare('INSERT INTO auth_tokens VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, accountId, id, hash(id), now - 40 * day, null, now - 31 * day);
    }
  })();
}
export function seedCleanupControls(db, accountId, recipientId, now) {
  db.transaction(() => {
    for (const [label, expiry] of [['margin', now - day / 2], ['future', now + 7 * day]]) {
      for (let flag = 0; flag < 3; flag++) {
        const id = `cleanup-${label}-${flag}`;
        db.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, hash(id), accountId, now - 40 * day, expiry, now - 40 * day, flag ? now - 35 * day : null);
        db.prepare('INSERT INTO auth_links VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, accountId, flag ? 'reset' : 'invite', hash(id), now - 40 * day, expiry, flag === 1 ? now - 35 * day : null, flag === 2 ? now - 35 * day : null);
      }
    }
    for (const [id, expiry] of [['cleanup-ordinary', now + 7 * day], ['cleanup-recovery', now + 15 * 60_000]]) {
      db.prepare('INSERT INTO auth_links VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, recipientId, 'reset', hash(id), now, expiry, null, null);
    }
    db.prepare('INSERT INTO auth_tokens VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('cleanup-recent-token', accountId, 'Recent revocation', hash('cleanup-recent-token'), now - 40 * day, null, now - day);
  })();
}

export function assertCleanupSnapshot(before, after, phase) {
  for (const kind of kinds) {
    const expected = before[kind].filter(id => !id.startsWith(oldPrefix));
    assert.deepEqual(after[kind].filter(id => !id.startsWith(oldPrefix)), expected, `${phase}: retained ${kind} must survive exactly`);
    const oldBefore = oldCounts(before)[kind], oldAfter = oldCounts(after)[kind];
    if (phase === 'boot') {
      assert.ok(oldBefore - oldAfter > 0 && oldBefore - oldAfter <= 500, `boot: bounded cleanup must remove 1..500 ${kind}`);
    } else assert.equal(oldAfter, 0, `${phase}: access must drain expired ${kind}`);
  }
}
