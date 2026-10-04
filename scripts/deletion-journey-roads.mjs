import assert from 'node:assert/strict';
import { journeyApi } from './journey-http.mjs';
import { invite } from './sharing-journey-auth.mjs';
import { until } from './mcp-probe-wait.mjs';
import { deletionProofWire } from './deletion-proof-wire.mjs';
export const good = response => { assert.ok(response.status >= 200 && response.status < 300, `HTTP ${response.status}: ${JSON.stringify(response.json)}`); return response.json; };
export async function mcpRequest(base, token, method, params = {}) {
  const response = await fetch(base + '/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await response.text();
  assert.equal(response.status, 200, 'MCP transport');
  const payload = JSON.parse(text.startsWith('{') ? text : text.split('\n').find(line => line.startsWith('data: ')).slice(6));
  assert.equal(payload.error, undefined); return payload.result;
}
export async function deletionRoads(base, admin, wirePort) {
  const api = journeyApi(base, { token: admin.token }), wire = await deletionProofWire(wirePort), completed = [];
  try {
    for (const road of ['session', 'token', 'mcp', 'assistant']) {
      const target = await invite(base, api, `road_${road}`);
      const owned = good(await journeyApi(base, target)('POST', '/api/maps', { body: { name: `Owned ${road}` } }));
      good(await api('PATCH', `/api/users/${target.id}`, { body: { status: 'deactivated' } }));
      const transport = journeyApi(base, road === 'session' ? { cookie: admin.cookie } : { token: admin.token });
      async function call(name, args) {
        if (road === 'mcp') {
          const result = await mcpRequest(base, admin.token, 'tools/call', { name, arguments: args });
          assert.ok(!result.isError, `MCP ${name}`); return result.structuredContent.result;
        }
        if (road === 'assistant') {
          const result = await wire.call(base, { token: admin.token }, name, args, { mutation: name !== 'preview_user_deletion' });
          assert.equal(result.ok, true, `assistant ${name}`); return result.body;
        }
        const { id, ...body } = args;
        return good(await transport(name === 'preview_user_deletion' ? 'GET' : name === 'delete_user' ? 'DELETE' : 'POST',
          name === 'preview_user_deletion' ? `/api/users/${id}/deletion-preview` : name === 'delete_user' ? `/api/users/${id}` : `/api/users/deletions/${id}/finish`,
          name === 'delete_user' ? { body } : {}));
      }
      const preview = await call('preview_user_deletion', { id: target.id }); assert.equal(preview.totals.maps, 1);
      const accepted = await call('delete_user', { id: target.id, confirmation: preview.confirmation, confirm: true, email: `${target.name}@example.test` });
      if (accepted.state !== 'completed') {
        const status = await until(() => api('GET', `/api/users/deletions/${accepted.id}`), response => response.status === 404 || response.json.state === 'needs-retry', `${road} deletion settles`);
        if (status.status !== 404) assert.equal((await call('finish_user_deletion', { id: accepted.id })).state, 'completed');
      }
      assert.equal((await api('GET', `/api/users/deletions/${accepted.id}`)).status, 404);
      assert.equal((await journeyApi(base, target)('GET', `/api/maps/${owned.id}`)).status, 401);
      completed.push({ accountId: target.id, mapId: owned.id });
      console.log(`PASS: confirmed image deletion through ${road}`);
    }
    return completed;
  } finally { await wire.close(); }
}
