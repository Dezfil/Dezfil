import { provisionJourney, tokenFetch } from './journey-auth.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { until } from './mcp-probe-wait.mjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { journeyClient } from './mcp-journey-core.mjs';
export const slowSql = tag => `SELECT count(*) AS mcpprobe_${tag} FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function connect(base, transportFetch = fetch, token) {
  const credential = token ?? (await provisionJourney(base)).token;
  const authenticatedFetch = tokenFetch(base, credential, transportFetch);
  const client = new Client({ name: 'dezfil-process-probe', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), { fetch: authenticatedFetch }));
  const journey = await journeyClient(client, async path => {
    const response = await authenticatedFetch(base + path); assert.ok(response.ok); return response.json();
  });
  return { client, ...journey, credential };
}
export async function events(file) { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
export async function seedRestart(base, file) {
  const j = await connect(base);
  try {
    const recipe = (await j.call('create_recipe', { name: 'MCP process recovery' })).recipe;
    const first = (await j.call('add_recipe_step', { id: recipe.id, operation: 'sql_step', parameters: { sql: slowSql('member'), name: 'mcp_interrupted_member' } })).step;
    const second = (await j.call('add_recipe_step', { id: recipe.id, operation: 'sql_step', parameters: { sql: 'SELECT * FROM mcp_interrupted_member', name: 'mcp_interrupted_downstream' } })).step;
    const cascade = (await j.gate('run_recipe', { id: recipe.id }, true)).body.run;
    const standalone = (await j.call('run_operation', { operation: 'sql_step', parameters: { sql: slowSql('standalone'), name: 'mcp_interrupted_standalone' } })).run;
    await until(() => j.call('get_operation_run', { id: standalone.id }), body => body.run.state === 'running', 'standalone running');
    await until(() => j.call('get_recipe_run', { id: recipe.id, runId: cascade.id }), body => body.run.members.some(member => member.stepId === first.id && member.state === 'running'), 'recipe first member running');
    const observed = await until(() => events(file), all => ['standalone', 'member'].every(tag => all.some(event => event.tag === tag && event.phase === 'start')), 'two actual engine evaluations');
    for (const tag of ['standalone', 'member']) {
      assert.equal(observed.filter(event => event.tag === tag && event.phase === 'start').length, 1);
      assert.equal(observed.filter(event => event.tag === tag && event.phase === 'settle').length, 0);
    }
    const current = (await j.call('get_recipe_run', { id: recipe.id, runId: cascade.id })).run;
    assert.equal(current.members.find(member => member.stepId === second.id).jobId, null);
    assert.equal(current.members.find(member => member.stepId === second.id).state, 'pending');
    return { recipeId: recipe.id, cascadeId: cascade.id, runId: standalone.id, firstId: first.id, secondId: second.id, oldPid: observed.find(event => event.phase === 'start').pid, credential: j.credential };
  } finally { await j.client.close(); }
}
export async function readRestart(base, file, seed) {
  const j = await connect(base, fetch, seed.credential);
  try {
    const { run } = await j.call('get_operation_run', { id: seed.runId });
    assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'operation_interrupted');
    const cascade = (await j.call('get_recipe_run', { id: seed.recipeId, runId: seed.cascadeId })).run;
    assert.equal(cascade.outcome, 'interrupted');
    const first = cascade.members.find(member => member.stepId === seed.firstId);
    const second = cascade.members.find(member => member.stepId === seed.secondId);
    assert.equal(first.state, 'failed'); assert.equal(first.attempt.error.code, 'operation_interrupted');
    assert.equal(second.state, 'not_run'); assert.equal(second.jobId, null); assert.equal(second.attempt, null);
    assert.equal((await j.call('list_tables')).filter(table => table.name.startsWith('mcp_interrupted_')).length, 0);
    assert.deepEqual((await readdir(path.join(path.dirname(file), 'tables'))).filter(name => name.endsWith('.parquet')), [], 'no partial output files after recovery sweep');
    await delay(500);
    const after = await events(file);
    const boots = after.filter(event => event.phase === 'boot');
    assert.equal(boots.length, 2); assert.notEqual(boots[0].instance, boots[1].instance);
    assert.equal(after.filter(event => ['standalone', 'member'].includes(event.tag) && event.phase === 'start').length, 2, 'no engine redispatch after restart');
    assert.equal((await j.call('list_operation_runs')).runs.length, 2, 'no minted retry jobs');
    return { standalone: 'operation_interrupted', cascade: 'interrupted', downstream: 'not_run', executionsBefore: 2, executionsAfter: 0, boots: boots.map(event => ({ pid: event.pid, instance: event.instance })) };
  } finally { await j.client.close(); }
}
export async function departure(base, file, { expectUnsupported = false } = {}) {
  let controller, requestId;
  const nativeFetch = globalThis.fetch;
  const transportFetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      const body = await request.clone().json();
      if (body.method === 'tools/call' && body.params.arguments?.sql?.includes('mcpprobe_')) {
        requestId = body.id;
        return nativeFetch(new Request(request, { signal: controller.signal }));
      }
    }
    return nativeFetch(request);
  };
  const j = await connect(base, transportFetch);
  const results = {};
  try {
    await j.call('run_sql', { sql: 'SELECT 1 AS ready' });
    for (const tag of ['departure', 'notification', 'timeout']) {
      controller = new AbortController();
      const startedAt = Date.now();
      const pending = j.client.callTool({ name: 'run_sql', arguments: { sql: slowSql(tag) } });
      // Handle the rejection immediately; await it after the engine observation.
      const settled = pending.then(value => ({ value }), error => ({ error }));
      const executing = await until(() => events(file), all => all.some(event => event.tag === tag && event.phase === 'start'), `${tag} running`).then(all => all.find(event => event.tag === tag && event.phase === 'start'));
      assert.equal((await events(file)).some(event => event.tag === tag && event.phase === 'settle'), false);
      if (tag === 'departure') controller.abort(); // HTTP body/connection only, no SDK cancellation option.
      if (tag === 'notification') {
        const response = await tokenFetch(base, j.credential, nativeFetch)(`${base}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'notification-only probe' } }) });
        assert.equal(response.status, 202);
      }
      if (tag === 'departure' && !expectUnsupported) {
        const all = await until(() => events(file), all => all.some(event => event.tag === tag && event.phase === 'settle'), 'HTTP departure stops evaluation before timeout', 2000);
        assert.ok(all.find(event => event.tag === tag && event.phase === 'settle').at - executing.at < 2000);
      }
      const outcome = await settled;
      await until(() => events(file), all => all.some(event => event.tag === tag && event.phase === 'settle'), `${tag} engine settled`, 15_000);
      const recorded = (await events(file)).filter(event => event.tag === tag);
      assert.equal(recorded.filter(event => event.phase === 'start').length, 1, 'one engine dispatch');
      const elapsedMs = recorded.find(event => event.phase === 'settle').at - executing.at;
      if (tag === 'timeout') {
        assert.equal(outcome.value?.isError, true);
        assert.equal(outcome.value?.structuredContent.result.error.code, 'query_timeout');
        assert.ok(elapsedMs >= 8000);
      }
      results[tag] = { elapsedMs, totalMs: Date.now() - startedAt, dispatches: 1, outcome: outcome.error ? 'transport-closed' : outcome.value?.structuredContent?.result?.error?.code ?? 'returned', interruptedBeforeTimeout: elapsedMs < 2000 };
      assert.equal((await j.call('run_sql', { sql: 'SELECT 42 AS answer' })).preview[0].answer, 42);
    }
    return results;
  } finally { controller?.abort(); await j.client.close(); }
}
if (process.argv[1]?.endsWith('/mcp-process-probe.mjs')) {
  const [mode, base, file, seedFile] = process.argv.slice(2);
  const result = mode === 'seed' ? await seedRestart(base, file) : mode === 'restart' ? await readRestart(base, file, JSON.parse(await readFile(seedFile, 'utf8'))) : await departure(base, file, { expectUnsupported: mode === 'characterize' });
  if (mode === 'seed') await writeFile(seedFile, JSON.stringify(result), { mode: 0o600 });
  const safeResult = { ...result }; delete safeResult.credential;
  console.log(JSON.stringify({ mode, result: safeResult }));
}
