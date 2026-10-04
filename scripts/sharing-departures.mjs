// Fresh actors keep the repeatable sharing controls independent of departure.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { journeyApi } from './journey-http.mjs';
import { invite, signIn } from './sharing-journey-auth.mjs';
import { connect } from './mcp-process-probe.mjs';
import { captureBasis } from './revision-fixtures.mjs';
import { until } from './mcp-probe-wait.mjs';

const ok = (response, status = 200, label = '') => {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(response.json)}`);
  return response.json;
};
const missing = 'never-created-departure';
const credentials = person => [{ cookie: person.cookie }, { token: person.token }];
const query = (api, sql) => api('POST', '/api/query', { body: { sql } });
async function upload(api, name) {
  const form = new FormData();
  form.append('file', new Blob([`sentinel,lon,lat\n${name},13.4,52.5\n`]), `${name}.csv`);
  return ok(await api('POST', '/api/tables', { form }), 201);
}
async function absent(api, url, missingUrl, label) {
  const hidden = await api('GET', url);
  assert.equal(hidden.status, 404, label);
  assert.deepEqual(hidden, await api('GET', missingUrl), label);
}

export async function exerciseProjectDepartures(base, state, { wire, holdDirectory } = {}) {
  const admin = journeyApi(base, state.admin);
  const tag = randomUUID().replaceAll('-', '').slice(0, 10);
  let owner = await invite(base, admin, `host_${tag}`);
  const members = await Promise.all(['viewer', 'editor'].map(role => invite(base, admin, `${role}_${tag}`)));
  const asOwner = () => journeyApi(base, { token: owner.token });
  const P = ok(await asOwner()('POST', '/api/projects', { body: { name: `Departure ${tag}` } }), 201).id;
  const Q = ok(await asOwner()('POST', '/api/projects', { body: { name: `Independent ${tag}` } }), 201).id;
  const exclusive = await upload(asOwner(), 'exclusive');
  const independent = await upload(asOwner(), 'independent');
  for (const [id, addTables] of [[P, [exclusive.id, independent.id]], [Q, [independent.id]]]) {
    ok(await asOwner()('PATCH', `/api/projects/${id}/members`, { body: { addTables } }));
  }
  const foreignMap = ok(await asOwner()('POST', '/api/maps', { body: { name: 'Exclusive map', projectId: P } }), 201);
  const own = new Map();
  const grant = (member, role, project = P) => asOwner()('PUT', `/api/projects/${project}/people/${member.sqlName}`, { body: { role } }).then(ok);
  for (const member of members) {
    await grant(member, 'editor'); await grant(member, 'viewer', Q);
    const api = journeyApi(base, { token: member.token });
    own.set(member.id, ok(await api('POST', '/api/maps', { body: { name: 'Retained own map', projectId: P } }), 201));
  }
  const projectBefore = ok(await asOwner()('GET', `/api/projects/${P}`));
  const mapBefore = ok(await asOwner()('GET', `/api/maps/${foreignMap.id}`));
  const refusedOwner = await asOwner()('POST', `/api/projects/${P}/leave`);
  assert.equal(refusedOwner.status, 409); assert.equal(refusedOwner.json.error.code, 'project_owner_cannot_leave');
  const outsider = journeyApi(base, state.admin);
  assert.deepEqual(await outsider('POST', `/api/projects/${P}/leave`), await outsider('POST', `/api/projects/${missing}/leave`));
  const roads = ['session', 'token', 'mcp', ...(wire ? ['assistant'] : [])];
  const report = { session: 0, token: 0, mcp: 0, assistant: 0, frozen: 0, readded: 0,
    held: holdDirectory ? {} : 'not run: supply --leave-hold with the test preload' };
  for (const [index, member] of members.entries()) {
    const role = index === 0 ? 'viewer' : 'editor';
    for (const frozen of [false, true]) for (const road of roads) {
      await grant(member, role);
      const api = journeyApi(base, { token: member.token });
      const mine = ok(await api('GET', `/api/maps/${own.get(member.id).id}`));
      const before = ok(await api('GET', `/api/projects/${P}`));
      assert.equal(before.role, role);
      assert.deepEqual(ok(await query(api, `SELECT sentinel FROM ${owner.sqlName}.exclusive`)).preview, [{ sentinel: 'exclusive' }]);
      if (frozen) ok(await admin('PATCH', `/api/users/${owner.id}`, { body: { status: 'deactivated' } }));
      try {
        if (road === 'session' || road === 'token') {
          const credential = road === 'session' ? { cookie: member.cookie } : { token: member.token };
          assert.deepEqual(ok(await journeyApi(base, credential)('POST', `/api/projects/${P}/leave`)), { left: true });
        } else if (road === 'mcp') {
          const mcp = await connect(base, fetch, member.token);
          try {
            assert.equal((await mcp.gate('leave_project', { id: P }, false)).declined, true);
            ok(await api('GET', `/api/projects/${P}`));
            assert.deepEqual((await mcp.gate('leave_project', { id: P }, true)).body, { left: true });
            await mcp.call('get_project', { id: P }, 'not_found');
            await mcp.call('leave_project', { id: P }, 'not_found');
          } finally { await mcp.client.close(); }
        } else {
          const beforeResolution = async () => { ok(await api('GET', `/api/projects/${P}`)); };
          const declined = await wire.leave(base, { token: member.token }, P, { approved: false, beforeResolution });
          assert.equal(declined.ok, false); ok(await api('GET', `/api/projects/${P}`));
          const result = await wire.leave(base, { cookie: member.cookie }, P, { beforeResolution });
          assert.equal(result.ok, true, JSON.stringify(result.body)); assert.deepEqual(result.body, { left: true });
        }
        report[road]++; if (frozen) report.frozen++;
        for (const credential of credentials(member)) {
          const after = journeyApi(base, credential);
          await absent(after, `/api/projects/${P}`, `/api/projects/${missing}`, 'departed project is absent');
          await absent(after, `/api/projects/${P}/people`, `/api/projects/${missing}/people`, 'departure reveals no roster');
          await absent(after, `/api/maps/${foreignMap.id}`, `/api/maps/${missing}`, 'exclusive map reach ends');
          assert.equal(ok(await after('GET', '/api/projects')).some(p => p.id === P), false, 'project leaves navigation lists');
          assert.equal(ok(await after('GET', '/api/maps')).some(m => m.id === foreignMap.id), false, 'exclusive map leaves lists');
          const lost = await query(after, `SELECT sentinel FROM ${owner.sqlName}.exclusive`);
          assert.equal(lost.status, 400, 'exclusive SQL reach ends');
          assert.deepEqual(lost.json, (await query(after, `SELECT sentinel FROM ${owner.sqlName}.never_created`)).json);
          assert.deepEqual(ok(await query(after, `SELECT sentinel FROM ${owner.sqlName}.independent`)).preview, [{ sentinel: 'independent' }]);
          assert.deepEqual(ok(await after('GET', `/api/maps/${mine.id}`)), mine, 'owned work, revision and attribution stay filed');
          ok(await after('GET', `/api/projects/${Q}`));
        }
      } finally {
        if (frozen) {
          ok(await admin('PATCH', `/api/users/${owner.id}`, { body: { status: 'active' } }));
          owner = await signIn(base, owner.name);
        }
      }
      assert.deepEqual(ok(await asOwner()('GET', `/api/projects/${P}`)), projectBefore, 'membership changes no project facts');
      assert.deepEqual(ok(await asOwner()('GET', `/api/maps/${foreignMap.id}`)), mapBefore, 'membership changes no document facts');
      await grant(member, role); report.readded++;
      ok(await api('GET', `/api/projects/${P}`));
    }
  }
  if (holdDirectory) report.held = await heldDeparture(base, { owner, member: members[1], P, grant }, holdDirectory);
  // Withdrawal uses the project identity still on an owned read after departure.
  for (const member of members) {
    const api = journeyApi(base, { token: member.token });
    ok(await api('POST', `/api/projects/${P}/leave`));
    const mine = ok(await api('GET', `/api/maps/${own.get(member.id).id}`));
    assert.equal(mine.projectId, P);
    ok(await api('PATCH', `/api/projects/${mine.projectId}/members`, { body: {
      removeMaps: [mine.id], expectedRevisions: { [`map:${mine.id}`]: mine.editRevision },
    } }));
    assert.equal(ok(await api('GET', `/api/maps/${mine.id}`)).projectId, null);
  }
  return report;
}

/** The preload holds the real engine after reading, before returning to the
 * application. Files are a test handshake; no production debug route exists. */
async function heldDeparture(base, { owner, member, P, grant }, directory) {
  await mkdir(directory, { recursive: true });
  const api = journeyApi(base, { token: member.token });
  const ownerApi = journeyApi(base, { token: owner.token });
  const result = {};
  const hold = async (kind, start, during, finish) => {
    const tag = `leaveprobe_${kind}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const pending = start(tag);
    // Observe rejections immediately even if the handshake itself fails.
    const settled = pending.then(value => ({ value }), error => ({ error }));
    try {
      await until(async () => { try { return JSON.parse(await readFile(path.join(directory, `${tag}.ready`), 'utf8')); } catch { return null; } }, Boolean, `${kind} engine hold`, 20_000);
      await during();
    } finally { await writeFile(path.join(directory, `${tag}.release`), 'release'); }
    const outcome = await settled;
    if (outcome.error) throw outcome.error;
    await finish(outcome.value);
    const fact = JSON.parse(await readFile(path.join(directory, `${tag}.ready`), 'utf8'));
    assert.equal(fact.executions, 1, 'one admitted engine execution');
  };
  for (const credential of credentials(member)) {
    const road = credential.cookie ? 'session' : 'token';
    const leave = () => journeyApi(base, credential)('POST', `/api/projects/${P}/leave`).then(ok);
    await grant(member, 'editor');
    await hold('read', tag => query(api, `SELECT sentinel, '${tag}' AS proof FROM ${owner.sqlName}.exclusive`), async () => {
      await leave();
      assert.equal((await query(api, `SELECT sentinel FROM ${owner.sqlName}.exclusive`)).status, 400);
    }, response => { assert.equal(ok(response).preview[0].sentinel, 'exclusive'); });
    result[`${road}Read`] = 'admitted read finished once; next read refused';
    for (const keepsInput of [false, true]) {
      await grant(member, 'editor');
      const workflow = ok(await ownerApi('POST', '/api/recipes', { body: { name: 'Held departure', projectId: P } }), 201).recipe;
      const output = `departure_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      let run;
      await hold('output', async tag => {
        const input = `${owner.sqlName}.${keepsInput ? 'independent' : 'exclusive'}`;
        const step = ok(await ownerApi('POST', `/api/recipes/${workflow.id}/steps`, { basis: captureBasis(workflow), body: {
          operation: 'sql_step', parameters: { name: output, sql: `SELECT sentinel, '${tag}' AS proof FROM ${input}` },
        } }), 201);
        run = ok(await api('POST', `/api/recipes/${workflow.id}/runs`, { basis: captureBasis(step), body: {} }), 202).run;
        return run;
      }, async () => { await leave(); await absent(api, `/api/recipes/${workflow.id}`, `/api/recipes/${missing}`, 'workflow lost during held output'); }, async () => {
        const final = await until(async () => ok(await ownerApi('GET', `/api/recipes/${workflow.id}/runs/${run.id}`)).run,
          value => !!value.outcome, 'held output settles', 20_000);
        assert.equal(final.outcome, keepsInput ? 'completed' : 'failed', 'late output commit follows current input reach');
        const table = await api('GET', `/api/tables/${output}`);
        if (keepsInput) {
          assert.deepEqual(ok(table).projectIds, [], 'independently reached input yields only a private output');
          const definition = ok(await ownerApi('GET', `/api/recipes/${workflow.id}`));
          assert.equal(definition.recipe.steps[0].output, null, 'no output association is written to the departed workflow');
        } else {
          assert.equal(table.status, 404, 'lost input produces no output');
          assert.equal(final.members[0].attempt.error.code, 'sql_error');
          assert.equal(final.members[0].attempt.error.message, `The dataset "${owner.sqlName}.exclusive" is not available to you.`);
        }
      });
      result[`${road}${keepsInput ? 'Private' : 'Refused'}Output`] = 'confirmed';
    }
  }
  await grant(member, 'editor');
  return result;
}
