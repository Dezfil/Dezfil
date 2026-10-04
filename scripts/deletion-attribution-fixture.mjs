// Test-only legacy attribution fixture. All reads still go through real routes.
// Restore the immutable-initiator trigger inside the same fixture transaction.
import assert from 'node:assert/strict';
export function clearFixtureAttribution(db, { mapId, recipeId, runId }) {
  db.transaction(() => {
    assert.equal(db.prepare('UPDATE maps SET last_changed_by = NULL WHERE id = ?').run(mapId).changes, 1);
    db.prepare('UPDATE map_history SET author_id = NULL WHERE map_id = ?').run(mapId);
    assert.equal(db.prepare('UPDATE recipes SET last_changed_by = NULL WHERE id = ?').run(recipeId).changes, 1);
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'cascade_runs_initiator_fixed'").get();
    assert.ok(trigger?.sql);
    db.exec('DROP TRIGGER cascade_runs_initiator_fixed');
    assert.equal(db.prepare('UPDATE cascade_runs SET initiator_id = NULL WHERE id = ? AND recipe_id = ?').run(runId, recipeId).changes, 1);
    db.exec(trigger.sql);
  })();
}
