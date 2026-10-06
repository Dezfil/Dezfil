import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

/** This probe writes and restarts an isolated instance. Never target the working server. */
export function probeOrigin(base) {
  const url = new URL(base);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use an isolated HTTP loopback origin');
  assert.ok(url.port && url.port !== '3000', 'Use an explicit isolated port, never port 3000');
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Supply only the origin, without credentials or a path');
  return url.origin;
}

/** The injected transport and restart let unit controls reject false-green probes
 * without pretending that an in-process fixture is deployment restart evidence.
 * @param {string} base
 * @param {{ token?: string, restart?: () => Promise<void>, fetchImpl?: typeof fetch, restartWaitMs?: number }} options
 */
export async function settingsProbe(base, { token = '', restart = undefined, fetchImpl = fetch, restartWaitMs = 120_000 } = {}) {
  const origin = probeOrigin(base);
  assert.ok(token, 'DEZFIL_PROBE_TOKEN must be an active admin token for the isolated instance');
  assert.equal(typeof restart, 'function', 'Supply a restart command for the isolated instance');
  const endpoint = '/api/instance/settings';
  async function request(path, body = undefined, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetchImpl(origin + path, { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: { ...(path === '/api/auth/entry' ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200, `${method} ${path}: HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error(`${method} ${path}: invalid JSON`); }
  }
  const patch = body => request(endpoint, body, 'PATCH');
  function stable(before, after) {
    assert.ok(Number.isFinite(Date.parse(before.startedAt)), 'process start time must be an ISO timestamp');
    assert.equal(after.startedAt, before.startedAt, 'process start time must be stable across reads');
  }
  function applied(document, values) {
    for (const [key, value] of Object.entries(values)) {
      assert.equal(document.settings[key]?.value, value, `${key}: effective value`);
      assert.equal(document.settings[key]?.storedValue, value, `${key}: committed stored value`);
      assert.equal(document.settings[key]?.source, 'stored', `${key}: stored source`);
    }
  }
  async function consumers(values) {
    const config = await request('/api/config');
    assert.equal(config.previewRows, values.previewRows, 'configuration consumer must see previewRows');
    const result = await request('/api/query', { sql: 'SELECT range AS n FROM range(25) ORDER BY n' });
    const length = Math.min(values.previewRows, 25);
    assert.equal(result.rowCount, 25, 'full query row count');
    assert.equal(result.preview.length, length, 'query preview must see previewRows');
    assert.equal(result.previewTruncated, length < 25, 'query truncation must keep its meaning');
    assert.deepEqual(result.preview, Array.from({ length }, (_, n) => ({ n: String(n) })), 'query preview contents');
    const entry = await request('/api/auth/entry');
    assert.equal(entry.signInMessage, values.signInMessage, 'anonymous entry consumer must see signInMessage');
  }
  const before = await request(endpoint);
  stable(before, await request(endpoint));
  const original = {}, previous = {};
  for (const key of ['previewRows', 'signInMessage']) {
    assert.equal(before.settings[key]?.locked, false, `${key} must be unlocked`);
    original[key] = before.settings[key].storedValue;
    previous[key] = before.settings[key].value;
  }
  // Warm all independent route bundles before writing, so a stale loaded reader cannot pass.
  await consumers(previous);
  const values = { previewRows: previous.previewRows === 10 ? 11 : 10, signInMessage: `Settings smoke ${randomUUID()}` };
  let after, failure;
  try {
    const changed = await patch(values);
    stable(before, changed); applied(changed, values);
    const read = await request(endpoint);
    stable(before, read); applied(read, values);
    await consumers(values);
    await restart();
    const deadline = Date.now() + restartWaitMs;
    do {
      try { after = await request(endpoint); } catch { after = undefined; }
      if (after && after.startedAt !== before.startedAt) break;
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    assert.ok(after && after.startedAt !== before.startedAt, 'process start time did not change after restart');
    assert.ok(Date.parse(after.startedAt) > Date.parse(before.startedAt), 'new process start must follow the old one');
    applied(after, values);
    const repeated = await request(endpoint);
    stable(after, repeated); applied(repeated, values);
    await consumers(values);
  } catch (error) { failure = error; }
  // Restore even after a refusal or a failed observation; null restores an absent override.
  try {
    const restored = await patch(original);
    for (const [key, value] of Object.entries(original)) assert.equal(restored.settings[key]?.storedValue, value, `${key}: restore stored value`);
    await consumers(previous);
  } catch (error) {
    if (failure) throw new Error(`${failure.message}; restore failed: ${error.message}`);
    throw error;
  }
  if (failure) throw failure;
  return { result: 'confirmed', previewRows: values.previewRows, startedAtBefore: before.startedAt, startedAtAfter: after.startedAt, restored: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [base, separator, executable, ...args] = process.argv.slice(2);
    assert.ok(base && separator === '--' && executable, 'Usage: npm run probe:settings -- http://127.0.0.1:3396 -- docker restart CONTAINER');
    const result = await settingsProbe(base, { token: process.env.DEZFIL_PROBE_TOKEN,
      restart: async () => { await promisify(execFile)(executable, args, { timeout: 120_000, maxBuffer: 1_048_576 }); },
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`failed: ${error.message}`);
    process.exitCode = 1;
  }
}
