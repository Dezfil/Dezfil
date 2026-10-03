// Run against an isolated, preloaded production standalone or the built image.
// The data directory must be shared with this client so scratch growth is observed.
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { csvFixture, exchange, excludedPaths, assertSmallRefusal, assertUpload, assertScratchGrowth, assertWorkflow, assertNoTruncation, LARGE_SENDER, WIRE_SLACK } from './transport-probe-support.mjs';

export async function transportProbe(base, { serverLog, fileLimitOnly = false } = {}) {
  assert.ok(process.env.DEZFIL_DATA_DIR, 'DEZFIL_DATA_DIR must name the isolated server data directory');
  assert.ok(serverLog, '--server-log must name the isolated server log');
  await readFile(serverLog); // Refuse missing evidence before provisioning anything.
  const started = Date.now(), evidence = [];
  const credentials = await provisionJourney(base), api = journeyApi(base, { token: credentials.token });
  const headers = { authorization: `Bearer ${credentials.token}` };
  const tmp = path.join(process.env.DEZFIL_DATA_DIR, 'tmp');
  const observeScratch = async () => {
    const files = await readdir(tmp).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    return Promise.all(files.map(async file => (await stat(path.join(tmp, file)).catch(error => { if (error.code === 'ENOENT') return { size: 0 }; throw error; })).size));
  };
  async function upload(bytes, success, streaming = false) {
    const fixture = csvFixture(bytes), samples = [];
    const boundary = 'dezfil-transport-boundary';
    const first = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="transport_${bytes}.csv"\r\nContent-Type: text/csv\r\n\r\n`);
    const last = Buffer.from(`\r\n--${boundary}--\r\n`);
    const before = await api('GET', '/api/tables'); assert.equal(before.status, 200);
    const result = await exchange(base + '/api/tables', {
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(first.length + bytes + last.length) },
      chunks: (function* () { yield first; yield* fixture.chunks(); yield last; })(), paceMs: streaming ? 1 : 0,
      onWrite: streaming ? async written => {
        if (written > first.length && written < first.length + bytes) {
          const sizes = await observeScratch();
          const current = Math.max(0, ...sizes);
          if (current && samples.at(-1) !== current) samples.push(current);
        }
      } : undefined,
    });
    if (success) {
      assertUpload(result, fixture.rows);
      const name = '"' + result.json.name.replaceAll('"', '""') + '"';
      const counted = await api('POST', '/api/query', { body: { sql: `SELECT count(*) AS n FROM ${name}` } });
      assert.equal(counted.status, 200); assert.equal(Number(counted.json.preview[0].n), fixture.rows, 'SQL independently counts all ingested rows');
      if (streaming) assertScratchGrowth(samples);
    } else {
      assert.equal(result.status, 413); assert.equal(result.json?.error?.code, 'upload_too_large');
      assert.deepEqual((await api('GET', '/api/tables')).json, before.json, 'file refusal creates no table');
    }
    assert.deepEqual(await observeScratch(), [], 'upload scratch is removed after settlement');
    evidence.push({ kind: 'upload', bytes, rows: success ? fixture.rows : 0, status: result.status, scratchSamples: samples.length });
  }
  if (fileLimitOnly) {
    assert.equal(process.env.DEZFIL_UPLOAD_MAX_MB, '1', 'file-limit control server and client must use DEZFIL_UPLOAD_MAX_MB=1');
    // Busboy emits its limit event at the configured boundary; preserve that refusal.
    for (const [bytes, success] of [[1024 * 1024 - 1, true], [1024 * 1024, false], [1024 * 1024 + 1, false]]) await upload(bytes, success);
  } else {
    for (const bytes of [11 * 1024 * 1024, 256 * 1024 * 1024]) await upload(bytes, true, true);
    const before = (await api('GET', '/api/recipes')).json;
    for (const bytes of [12 * 1024 * 1024, 16 * 1024 * 1024, 16 * 1024 * 1024 + 1]) {
      const text = '{"name":""}' + ' '.repeat(bytes - Buffer.byteLength('{"name":""}'));
      const result = await exchange(base + '/api/recipes', { headers: { ...headers, 'content-type': 'application/json', 'content-length': String(bytes) }, chunks: [Buffer.from(text)] });
      if (bytes <= 16 * 1024 * 1024) assertWorkflow(result);
      else {
        assert.equal(result.status, 413);
        assert.deepEqual(result.json, { error: { code: 'request_body_too_large', message: 'The workflow request body exceeds the 16777216-byte limit.' } });
      }
      evidence.push({ kind: 'workflow', bytes, status: result.status, code: result.json?.error?.code });
    }
    assert.deepEqual((await api('GET', '/api/recipes')).json, before, 'workflow refusals create nothing');
    for (const route of excludedPaths.slice(1)) for (const declared of [true, false]) {
      const result = await exchange(base + route, {
        headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': String(LARGE_SENDER) } : {}) },
        headersOnly: declared, timeoutMs: 10_000, paceMs: 25,
        chunks: (function* () { for (let i = 0; i < LARGE_SENDER; i += 4096) yield Buffer.alloc(4096, ' '); })(),
      });
      assertSmallRefusal(result, declared);
      evidence.push({ kind: 'public', route, declared, bytesAtStatus: result.bytesAtStatus, slack: declared ? 0 : WIRE_SLACK });
    }
    const beforeTrace = (await api('GET', '/api/tables')).json;
    for (const route of excludedPaths) {
      const result = await exchange(base + route, { method: 'TRACE', headers: { 'content-length': '4194304' }, headersOnly: true, timeoutMs: 10_000 });
      assert.equal(result.status, 400); assert.equal(result.text, ''); assert.equal(result.bytesAtStatus, 0);
      evidence.push({ kind: 'TRACE', route, status: result.status, bytesAtStatus: result.bytesAtStatus });
    }
    assert.deepEqual((await api('GET', '/api/tables')).json, beforeTrace, 'TRACE changes nothing');
    const listed = await fetch(base + '/api/tables', { headers: { cookie: credentials.cookie } });
    assert.equal(listed.status, 200); assert.equal(listed.headers.get('cache-control'), 'private, no-store');
    assert.ok(listed.headers.getSetCookie().some(value => value.startsWith(credentials.cookie + ';'))); await listed.body?.cancel();
    for (const route of excludedPaths) {
      const options = await fetch(base + route, { method: 'OPTIONS', headers: { cookie: credentials.cookie } });
      assert.equal(options.status, 204); assert.equal(options.headers.get('cache-control'), 'private, no-store');
      assert.ok(options.headers.getSetCookie().some(value => value.startsWith(credentials.cookie + ';')));
      const refused = await fetch(base + route, { method: 'PUT', headers: { cookie: credentials.cookie, origin: 'https://unrelated.test' } });
      assert.equal(refused.status, 403); assert.equal(refused.headers.get('cache-control'), 'private, no-store'); await refused.body?.cancel();
    }
  }
  assertNoTruncation(await readFile(serverLog, 'utf8'));
  const result = { label: 'confirmed', mode: fileLimitOnly ? 'file-limit' : 'transport', elapsedSeconds: (Date.now() - started) / 1000, evidence };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), logIndex = args.indexOf('--server-log');
    assert.ok(args[0]?.startsWith('http') && logIndex > 0, 'Usage: transport-probe.mjs ORIGIN --server-log PATH [--file-limit-only]');
    await transportProbe(args[0], { serverLog: args[logIndex + 1], fileLimitOnly: args.includes('--file-limit-only') });
  } catch (error) {
    console.error(JSON.stringify({ label: 'failed', message: error.message }, null, 2));
    process.exitCode = 1;
  }
}
