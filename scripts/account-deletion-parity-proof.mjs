// Owns an isolated production server and a deterministic assistant provider.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { deletionProofHost } from './deletion-proof-host.mjs';
import { deletionProofWire } from './deletion-proof-wire.mjs';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { invite } from './sharing-journey-auth.mjs';
import { connect } from './mcp-process-probe.mjs';
import { until } from './mcp-probe-wait.mjs';
const { values } = parseArgs({ options: { standalone: { type: 'string', default: '.next/standalone' }, port: { type: 'string', default: '3397' }, 'wire-port': { type: 'string', default: '3398' } } });
const ok = response => { assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response)); return response.json; };
const wire = await deletionProofWire(Number(values['wire-port']));
let host, mcp;
try {
  host = await deletionProofHost({ standalone: values.standalone, port: Number(values.port), wirePort: wire.port });
  const { base } = host, admin = await provisionJourney(base), api = journeyApi(base, { token: admin.token });
  mcp = await connect(base, fetch, admin.token);
  const control = await invite(base, api, 'independent_control');
  const controlMap = ok(await journeyApi(base, control)('POST', '/api/maps', { body: { name: 'Independent survivor' } }));
  for (const road of ['session', 'token', 'mcp', 'assistant']) {
    const credential = road === 'session' ? { cookie: admin.cookie } : { token: admin.token };
    const transport = journeyApi(base, credential);
    const routes = {
      preview_user_deletion: id => ['GET', `/api/users/${id}/deletion-preview`],
      delete_user: id => ['DELETE', `/api/users/${id}`],
      get_user_deletion: id => ['GET', `/api/users/deletions/${id}`],
      finish_user_deletion: id => ['POST', `/api/users/deletions/${id}/finish`],
    };
    const call = async (name, args, code) => {
      if (road === 'mcp') return mcp.call(name, args, code);
      if (road === 'assistant') {
        const result = await wire.call(base, credential, name, args, { mutation: ['delete_user', 'finish_user_deletion'].includes(name) });
        assert.equal(result.ok, !code, `${name}: ${JSON.stringify(result)}`);
        if (code) assert.equal(result.body.error.code, code); return result.body;
      }
      const [method, route] = routes[name](args.id), body = { ...args }; delete body.id;
      const response = await transport(method, route, { ...(method === 'DELETE' ? { body } : {}) });
      if (code) { assert.ok(response.status >= 400); assert.equal(response.json.error.code, code); }
      else ok(response);
      return response.json;
    };
    await call('preview_user_deletion', { id: admin.account.id }, 'self_change_refused');
    await call('preview_user_deletion', { id: control.id }, 'account_not_deactivated');
    await call('preview_user_deletion', { id: 'missing' }, 'not_found');
    const target = await invite(base, api, `target_${road}`);
    const privateName = `Private ${road} sentinel`;
    ok(await journeyApi(base, target)('POST', '/api/maps', { body: { name: privateName } }));
    ok(await api('PATCH', `/api/users/${target.id}`, { body: { status: 'deactivated' } }));
    let preview = await call('preview_user_deletion', { id: target.id });
    assert.equal(preview.totals.maps, 1); assert.equal(preview.people, 0); assert.ok(!JSON.stringify(preview).includes(privateName));
    const args = () => ({ id: target.id, confirm: true, confirmation: preview.confirmation, email: `${target.name}@example.test` });
    await call('delete_user', { ...args(), email: 'mistyped@example.test' }, 'invalid_request');
    ok(await api('PATCH', `/api/users/${target.id}`, { body: { status: 'active' } }));
    ok(await api('PATCH', `/api/users/${target.id}`, { body: { status: 'deactivated' } }));
    await call('delete_user', args(), 'deletion_changed');
    preview = await call('preview_user_deletion', { id: target.id });
    if (road === 'mcp') assert.equal((await mcp.gate('delete_user', args(), false)).declined, true);
    if (road === 'assistant') assert.equal((await wire.call(base, credential, 'delete_user', args(), { mutation: true, approved: false })).ok, false);
    assert.equal(ok(await api('GET', '/api/users')).deletions.length, 0, 'decline and refusals have no accepted effects');
    await host.control({ command: 'hold', accountId: target.id });
    await host.control({ command: 'compaction', fail: true });
    const accepted = await call('delete_user', args()); assert.equal(accepted.state, 'pending', 'held work is never completed');
    assert.deepEqual(await call('delete_user', args()), accepted, 'repeated acceptance preserves identity');
    assert.deepEqual(await call('get_user_deletion', { id: accepted.id }), accepted);
    const pendingList = ok(await api('GET', '/api/users')); assert.equal(pendingList.deletions[0].id, accepted.id);
    const reactivate = await api('PATCH', `/api/users/${target.id}`, { body: { status: 'active' } });
    assert.equal(reactivate.status, 409); assert.equal(reactivate.json.error.code, 'deletion_in_progress');
    await host.control({ command: 'release', accountId: target.id });
    await until(async () => ok(await api('GET', `/api/users/deletions/${accepted.id}`)), value => value.state === 'needs-retry', 'failed compaction is unfinished');
    assert.equal((await call('get_user_deletion', { id: accepted.id })).state, 'needs-retry');
    const duplicate = await api('POST', '/api/users', { body: { name: target.name, email: `${target.name}@example.test` } });
    assert.equal(duplicate.status, 409); assert.equal(duplicate.json.error.code, 'email_taken'); assert.equal(duplicate.json.error.canReactivate, undefined);
    await host.control({ command: 'compaction', fail: false });
    const finished = await call('finish_user_deletion', { id: accepted.id });
    assert.equal(finished.state, 'completed'); await call('get_user_deletion', { id: accepted.id }, 'not_found');
    const fresh = ok(await api('POST', '/api/users', { body: { name: target.name, email: `${target.name}@example.test` } }));
    assert.notEqual(fresh.account.sqlName, target.sqlName, 'ever-active SQL home remains reserved');
    const invited = await call('preview_user_deletion', { id: fresh.account.id }); assert.equal(invited.invited, true);
    assert.equal((await call('delete_user', { id: fresh.account.id, confirm: true, confirmation: invited.confirmation })).state, 'completed');
    const reused = ok(await api('POST', '/api/users', { body: { name: target.name, email: `${target.name}@example.test` } }));
    assert.equal(reused.account.sqlName, fresh.account.sqlName, 'unredeemed invitation frees its SQL name');
    assert.equal(ok(await journeyApi(base, control)('GET', `/api/maps/${controlMap.id}`)).name, 'Independent survivor');
    console.log(`PASS: confirmed ${road} preview/refusals/confirmation/pending/retry/completion/reuse`);
  }
  const memberApi = journeyApi(host.base, control);
  for (const [method, route, body] of [['GET', '/api/users/missing/deletion-preview'], ['DELETE', '/api/users/missing', {}], ['GET', '/api/users/deletions/missing'], ['POST', '/api/users/deletions/missing/finish']]) {
    const response = await memberApi(method, route, { body }); assert.equal(response.status, 403); assert.equal(response.json.error.code, 'forbidden');
  }
  console.log('PASS: confirmed deletion parity over production HTTP, MCP and assistant; independent owner survives');
} catch (error) { console.error(`FAIL: ${error.stack}`); process.exitCode = 1; }
finally { await mcp?.client.close(); await host?.stop(); await wire.close(); }
