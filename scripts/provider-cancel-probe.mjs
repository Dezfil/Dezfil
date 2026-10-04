import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { captureBasis } from './revision-fixtures.mjs';
import { heldProvider, assertClosed, evidence, until, pause } from './held-provider.mjs';

/** A real client connection; destruction abandons the response at the built route. */
export function routeCall(base, token, mapId, arm) {
  const url = new URL(arm.road === 'search'
    ? `/api/maps/${mapId}/search?q=${encodeURIComponent(arm.id)}&places=1` : '/api/basemap/inspect', base);
  const body = arm.road === 'search' ? undefined : JSON.stringify({ url: arm.url });
  let request;
  const outcome = new Promise(resolve => {
    request = (url.protocol === 'https:' ? https : http).request(url, {
      method: body ? 'POST' : 'GET', agent: false,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', error => resolve({ error }));
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { resolve({ error }); }
      });
    });
    request.on('error', error => resolve({ error }));
    request.setTimeout(45_000, () => request.destroy(new Error('Probe client safety timeout')));
    request.end(body);
  });
  return { outcome, abort() {
    const at = performance.now();
    const closed = new Promise(resolve => request.once('close', resolve));
    request.destroy(new Error("Probe client departed")); return { at, closed };
  } };
}

export function assertNormal(road, result) {
  assert.equal(result.status, 200, JSON.stringify(result));
  if (road === 'search') assert.deepEqual(result.body.places, {
    state: 'ok', attribution: 'Fixture credit', results: [{ name: 'Harbour', context: 'Fixture coast', lng: 13.4, lat: 52.5 }],
  });
  else assert.deepEqual(result.body, { verdict: 'valid', name: 'Fixture style', layerCount: 1, sourceCount: 1, attribution: [{ label: 'Fixture credit' }] });
}

export async function providerCancelProbe(base, { port = 4319, searchTimeoutMs = 30_000 } = {}) {
  assert.ok(process.env.DEZFIL_DATA_DIR, 'Set DEZFIL_DATA_DIR to a fresh scratch directory');
  const fixture = await heldProvider(port);
  const failures = [], prefix = `provider-${Date.now()}`;
  let credentials, api, map;
  const report = row => console.log(JSON.stringify(row));
  const run = async (name, fn) => {
    try { await fn(); report({ label: 'confirmed', name }); }
    catch (error) { failures.push(name); report({ label: 'failed', name, message: error.message }); }
  };
  const normal = async (road, suffix) => {
    const arm = fixture.arm(road, 'normal', `${prefix}-${suffix}`);
    assertNormal(road, await routeCall(base, credentials.token, map.id, arm).outcome);
    assert.equal(arm.requests.length, 1, 'normal recovery contacts this fixture');
  };
  try {
    credentials = await provisionJourney(base); api = journeyApi(base, { token: credentials.token });
    const made = await api('POST', '/api/maps', { body: { name: 'Provider cancellation probe' } });
    assert.equal(made.status, 201); map = made.json;
    for (const road of ['search', 'inspect']) {
      await run(`${road}:normal`, () => normal(road, `${road}-initial`));
      for (const phase of ['headers', 'body', 'redirect']) {
        const name = `${road}:${phase}:abort`, arm = fixture.arm(road, phase, `${prefix}-${road}-${phase}`);
        const call = routeCall(base, credentials.token, map.id, arm);
        await run(name, async () => {
          await until(() => arm.held, `${name}: fixture not reached`, 5_000);
          assert.equal(arm.requests.length, phase === 'redirect' ? 2 : 1);
          assert.equal(arm.held.closedAt, null, 'socket is held before abort');
          const departure = call.abort(); await departure.closed;
          try { await assertClosed(arm, departure.at); }
          finally { report({ name, departedAt: departure.at, sockets: evidence(arm) }); }
        });
        // Evidence above is complete before any teardown of a failed arm.
        call.abort(); fixture.release(arm); await call.outcome;
        await run(`${name}:recovery`, () => normal(road, `${road}-${phase}-recovery`));
      }
    }
    await run('search:queued-cancellation', async () => {
      const blocker = fixture.arm('search', 'headers', `${prefix}-blocker`);
      const queued = fixture.arm('search', 'normal', `${prefix}-queued`);
      const first = routeCall(base, credentials.token, map.id, blocker);
      let second;
      try {
        await until(() => blocker.held, 'blocker did not reach provider');
        second = routeCall(base, credentials.token, map.id, queued);
        await pause(300);
        assert.equal(queued.requests.length, 0, 'second search waits for capacity');
        assert.equal(blocker.held.closedAt, null, 'new independent request does not cancel its predecessor');
        const cancelled = second.abort(); await cancelled.closed; await pause(100);
        const departure = first.abort(); await departure.closed;
        await assertClosed(blocker, departure.at);
        await normal('search', 'queue-recovery'); await pause(100);
        assert.equal(queued.requests.length, 0, 'cancelled queued request never contacts provider, including after capacity release');
      } finally {
        first.abort(); second?.abort(); fixture.release(blocker); fixture.release(queued);
        report({ name: 'search:queued-cancellation', blocker: evidence(blocker), queued: evidence(queued) });
      }
    });
    for (const road of ['search', 'inspect']) for (const phase of ['headers', 'body', 'redirect']) {
      const name = `${road}:${phase}:timeout`, arm = fixture.arm(road, phase, `${prefix}-${name}`);
      const call = routeCall(base, credentials.token, map.id, arm);
      await run(name, async () => {
        await until(() => arm.held, `${name}: fixture not reached`, 5_000);
        const result = await call.outcome;
        assert.equal(result.status, 200, JSON.stringify(result));
        if (road === 'search') assert.deepEqual(result.body.places, { state: 'failed', message: 'The configured geocoding endpoint could not be reached.' });
        else assert.deepEqual(result.body, { verdict: 'unreachable', detail: 'The style fetch timed out.' });
        await until(() => arm.requests.every(r => r.closedAt !== null), `${name}: timeout left a socket`, 1_000);
        const elapsed = arm.held.closedAt - arm.requests[0].arrivedAt;
        const expected = road === 'search' ? searchTimeoutMs : 8_000;
        assert.ok(elapsed >= expected - 500 && elapsed <= expected + 1_500, `${name}: ${elapsed} ms, expected ${expected} ms`);
        report({ name, elapsed, sockets: evidence(arm) });
      });
      call.abort(); fixture.release(arm);
      await run(`${name}:recovery`, () => normal(road, `${name}-recovery`));
    }
  } finally {
    await fixture.close();
    if (map) { const deleted = await api('DELETE', `/api/maps/${map.id}`, { basis: captureBasis(map) }); assert.equal(deleted.status, 204); }
    if (credentials) {
      const revoked = await credentials.fetch(`${base}/api/account/tokens/${credentials.tokenId}`, { method: 'DELETE' });
      assert.equal(revoked.status, 200);
    }
  }
  report({ failures, frameworkLogNote: 'uncaughtException: Error: aborted on client departure is a separate framework response-abandonment issue; retain it separately. An unhandled provider rejection is not exempt.' });
  assert.deepEqual(failures, [], 'provider cancellation arms failed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, port, searchTimeoutMs] = process.argv.slice(2);
  try {
    assert.ok(base, 'Usage: provider-cancel-probe.mjs BASE_URL [PROVIDER_PORT=4319] [SEARCH_TIMEOUT_MS=30000]');
    await providerCancelProbe(base, { port: Number(port ?? 4319), searchTimeoutMs: Number(searchTimeoutMs ?? 30_000) });
  } catch (error) { console.error(error); process.exitCode = 1; }
}
