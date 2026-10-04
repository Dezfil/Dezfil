// Run by the checkout driver or inside the built image; all state is synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { until } from './mcp-probe-wait.mjs';
import { deletionFixture } from './deletion-journey-fixture.mjs';
import { assertErased, storeFiles } from './deletion-journey-store.mjs';
import { good, deletionRoads } from './deletion-journey-roads.mjs';
const [mode, base, stateFile, directory, controlDirectory, wirePort = '3404'] = process.argv.slice(2);
assert.ok(['seed', 'verify', 'recover'].includes(mode));
assert.ok(directory && path.isAbsolute(directory) && stateFile && path.isAbsolute(stateFile));
const Database = createRequire(path.join(process.cwd(), 'server.js'))('better-sqlite3');
const db = new Database(path.join(directory, 'metadata.sqlite'));
async function control(command, accountId) {
  const id = randomUUID(); writeFileSync(path.join(controlDirectory, 'request.json'), JSON.stringify({ id, command, accountId }));
  const reply = await until(async () => { try { return JSON.parse(readFileSync(path.join(controlDirectory, 'response.json'), 'utf8')); } catch { return null; } }, value => value?.id === id, 'built-process proof control');
  assert.equal(reply.error, undefined); assert.equal(reply.ok, true);
}
async function pages(fixture, refused) {
  for (const [route, target, cookie] of [
    [`/maps/${fixture.targetMap.id}`, true, fixture.control.cookie], ['/v/deletion-target-page', true], ['/v/deletion-target-page?embed=1', true],
    [`/maps/${fixture.controlMap.id}`, false, fixture.control.cookie], ['/v/deletion-control-page', false],
  ]) {
    const response = await fetch(base + route, { headers: cookie ? { cookie } : {}, redirect: 'manual' }), body = await response.text();
    if (target && refused) {
      assert.ok(response.status === 404 || body.includes('NEXT_HTTP_ERROR_FALLBACK;404'), `accepted owner must be absent from built page ${route}`);
      assert.ok(!body.includes(fixture.targetName), 'refused page contains no target material');
    } else { assert.equal(response.status, 200, `warm or independent page ${route}`); assert.ok(body.includes(target ? fixture.targetName : fixture.ledger.retained[0]), 'page positive content control'); }
  }
}
try {
  if (mode === 'seed') {
    const admin = await provisionJourney(base), api = journeyApi(base, { cookie: admin.cookie });
    const fixture = await deletionFixture(base, admin, directory, db);
    await pages(fixture, false);
    good(await api('PATCH', `/api/users/${fixture.target.id}`, { body: { status: 'deactivated' } }));
    const preview = good(await api('GET', `/api/users/${fixture.target.id}/deletion-preview`));
    assert.deepEqual(preview.totals, { datasets: fixture.owned.data_tables.length, maps: fixture.owned.maps.length, workflows: fixture.owned.recipes.length, projects: fixture.owned.projects.length, connections: fixture.owned.pg_connections.length, publishedLinks: 1 });
    assert.equal(preview.people, 1); assert.ok(!JSON.stringify(preview.totals).includes(fixture.targetName));
    await control('hold', fixture.target.id);
    const accepted = good(await api('DELETE', `/api/users/${fixture.target.id}`, { body: { confirm: true, confirmation: preview.confirmation, email: fixture.email } }));
    assert.equal(accepted.state, 'pending', 'held work prevents completion');
    assert.equal(db.prepare('SELECT status FROM accounts WHERE id=?').get(fixture.target.id).status, 'deleting');
    assert.ok(db.prepare('SELECT id FROM maps WHERE id=?').get(fixture.targetMap.id), 'page refusal is checked before rows are erased');
    await control('replay'); await pages(fixture, true);
    for (const route of ['/api/published/deletion-target-page', `/api/maps/${fixture.targetMap.id}`]) assert.equal((await journeyApi(base, fixture.control)('GET', route)).status, 404);
    // A second connection pins genuine old WAL frames through the compaction stage.
    db.exec('BEGIN'); db.prepare('SELECT name FROM accounts WHERE id=?').get(fixture.target.id);
    await control('release', fixture.target.id);
    const status = await until(async () => good(await api('GET', `/api/users/deletions/${accepted.id}`)), value => value.state === 'needs-retry', 'reader-blocked checkpoint remains unfinished', 20000);
    assert.equal(status.id, accepted.id);
    const journal = JSON.parse(readFileSync(path.join(directory, 'account-deletions', `${accepted.id}.json`), 'utf8'));
    assert.equal(journal.next, 10, 'real checkpoint blocked at compaction');
    db.exec('ROLLBACK');
    for (const file of fixture.ledger.removedFiles.filter(file => file.includes(fixture.foreignMap.id))) assert.ok(!existsSync(path.join(directory, file)), `recorded foreign card removed before restart: ${file}`);
    const foreignRow = db.prepare('SELECT * FROM maps WHERE id=?').get(fixture.foreignMap.id);
    assert.equal(foreignRow.project_id, null); assert.notEqual(foreignRow.edit_revision, fixture.foreignRevision);
    writeFileSync(stateFile, JSON.stringify({ admin, fixture, accepted, foreignRow }), { mode: 0o600 });
    console.log('PASS: confirmed acceptance, warm built-page refusal, live checkpoint blocking and independent pages');
  } else {
    const state = JSON.parse(readFileSync(stateFile, 'utf8')), { admin, fixture, accepted, foreignRow } = state;
    const api = journeyApi(base, { token: admin.token }), keep = journeyApi(base, fixture.control);
    if (mode === 'recover') {
      const secret = new URLSearchParams(new URL(readFileSync(path.join(controlDirectory, 'recovery-link'), 'utf8').trim()).hash.slice(1)).get('secret');
      const recovered = good(await journeyApi(base)('POST', '/api/auth/redeem', { body: { secret, password: 'recovered paper cranes before sunrise' } }));
      assert.equal(recovered.account.id, admin.account.id); assert.equal(recovered.account.isAdmin, true);
      assert.equal((await journeyApi(base, { cookie: admin.cookie })('GET', '/api/maps')).status, 401);
      assert.equal((await keep('GET', `/api/maps/${fixture.controlMap.id}`)).status, 200);
      console.log('PASS: confirmed packaged remaining-admin recovery after deletion');
    } else {
      assert.equal(good(await api('GET', `/api/users/deletions/${accepted.id}`)).state, 'needs-retry', 'replacement keeps same unfinished deletion');
      let finished = good(await api('POST', `/api/users/deletions/${accepted.id}/finish`));
      if (finished.state !== 'completed') {
        await until(() => api('GET', `/api/users/deletions/${accepted.id}`), response => response.status === 404 || response.json.state === 'needs-retry', 'continuation settles');
        const status = await api('GET', `/api/users/deletions/${accepted.id}`);
        assert.equal(status.status, 404, 'continuation really completes'); finished = { state: 'completed' };
      }
      assert.equal(finished.state, 'completed');
      assert.equal((await api('GET', `/api/users/deletions/${accepted.id}`)).status, 404);
      assertErased(directory, fixture.ledger); // The server still owns its open SQLite store.
      for (const file of storeFiles(directory).filter(file => file.startsWith('file-owners/') && file.endsWith('.json'))) {
        assert.notEqual(JSON.parse(readFileSync(path.join(directory, file), 'utf8')).accountId, fixture.target.id, 'no target-owned file obligation remains');
      }
      for (const [table, ids] of Object.entries(fixture.owned)) for (const id of ids) assert.equal(db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id), undefined, `owned ${table} erased by identity`);
      assert.deepEqual(db.prepare('SELECT * FROM maps WHERE id=?').get(fixture.controlMap.id), fixture.controlRow);
      assert.deepEqual(db.prepare('SELECT * FROM maps WHERE id=?').get(fixture.foreignMap.id), foreignRow, 'continuation never repeats dissolution');
      assert.equal(db.prepare('SELECT status FROM accounts WHERE id=?').get(fixture.target.id).status, 'deleted');
      assert.equal(existsSync(path.join(directory, 'account-deletions', `${accepted.id}.json`)), false);
      const missing = await keep('GET', `/api/layers/${fixture.layers.foreign}/render`);
      assert.equal(missing.json.error?.message, `The dataset "${fixture.target.sqlName}.same" is not available to you.`, 'surviving map reports its missing input');
      const workflow = good(await keep('GET', `/api/recipes/${fixture.survivorWorkflow.id}`));
      assert.ok(workflow.recipe.steps.some(step => step.missingInputs.some(input => input.tableId === `missing:${fixture.target.sqlName}.same` && input.tableName === `${fixture.target.sqlName}.same`)), 'surviving workflow reports its specific missing input');
      const query = await keep('POST', '/api/query', { body: { sql: `SELECT * FROM ${fixture.target.sqlName}.same` } });
      assert.equal(query.status, 400); assert.equal(query.json.error.message, 'The query refers to an unknown table.');
      assert.equal((await fetch(base + '/api/published/deletion-target-page')).status, 404);
      await pages(fixture, true);
      for (const result of await deletionRoads(base, admin, Number(wirePort))) {
        assert.equal(db.prepare('SELECT status FROM accounts WHERE id=?').get(result.accountId).status, 'deleted', 'transport deletion finalized');
        assert.equal(db.prepare('SELECT id FROM maps WHERE id=?').get(result.mapId), undefined, 'transport owned map erased');
      }
      console.log('PASS: confirmed live erasure, same-id continuation, missing inputs, public-link loss and independent owner');
    }
  }
} finally { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); }
