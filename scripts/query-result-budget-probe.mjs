import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { observeRequest } from './result-budget-observation.mjs';
import { probeClient, boundary } from './result-budget-client.mjs';

const sentence = 'The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.';

/** Run against an isolated built server or container, configured with
 * DEZFIL_QUERY_MEMORY_MB=32. An existing account token may be supplied in
 * DEZFIL_PROBE_TOKEN; otherwise provision the standard journey account.
 * Fetch decodes content encoding. Count the actual uncompressed entity bytes,
 * independently of Content-Length (which may describe compressed transport).
 */
export async function queryResultBudgetProbe(base, label = 'standalone', existing, memory = '32', observationDirectory = undefined) {
  const origin = new URL(base).origin;
  const client = existing ?? await probeClient(origin, label);
  const token = client.token;
  try {
    const observations = [];
    for (const geometry of ['wkt', 'geojson']) {
      const requestBody = { sql: "SELECT repeat('x', 1000000) AS payload FROM range(40)", ...(geometry === 'geojson' ? { geometry } : {}) };
      console.log(JSON.stringify({ observation: 'refused-forty', geometry, label, request: { method: 'POST', path: '/api/query', body: requestBody } }));
      const observed = await observeRequest(observationDirectory, `refused-forty-${geometry}`, requestBody, async () => {
        const response = await fetch(`${origin}/api/query`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'accept-encoding': 'identity' },
          body: JSON.stringify(requestBody),
        });
        let bytes = 0;
        const small = [];
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes < 1024) small.push(Buffer.from(chunk));
          else small.length = 0;
        }
        let body;
        if (bytes < 1024) {
          try { body = JSON.parse(Buffer.concat(small).toString('utf8')); } catch { /* assertion below */ }
        }
        const observed = { label, geometry, status: response.status, bytes,
          code: body?.error?.code ?? null,
          contentEncoding: response.headers.get('content-encoding'),
          contentLength: response.headers.get('content-length'),
          transferEncoding: response.headers.get('transfer-encoding'),
          engineMemoryMb: `${memory} (operator configuration; not measured by this probe)` };
        console.log(JSON.stringify(observed));
        assert.equal(response.status, 422, `forty-row refusal: observed HTTP ${response.status}, ${bytes} bytes`);
        assert.ok(bytes < 1024, `refusal must be under 1 KiB; observed ${bytes} bytes`);
        assert.deepEqual(body, { error: { code: 'query_result_too_large', message: sentence } }, 'exact catalogue refusal, without data or details');
        console.log('confirmed: served forty-row query returned only the catalogue refusal under 1 KiB');
        return observed;
      });
      observations.push(observed);
    }
    return observations;
  } finally { if (!existing) await client.cleanup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [base, label = 'standalone', mode = '--refused', ...extra] = process.argv.slice(2);
    assert.ok(base && /^https?:\/\//.test(base), 'Usage: query-result-budget-probe.mjs ORIGIN [standalone|container]');
    assert.ok(['standalone', 'container'].includes(label), 'label must be standalone or container');
    assert.ok(['--refused', '--admitted', '--quick', '--full'].includes(mode), 'mode must be --refused, --admitted, --quick or --full');
    assert.ok(extra.length === 0 || (extra.length === 2 && extra[0] === '--observation-dir'), 'Optional argument: --observation-dir FRESH_DIRECTORY');
    const observationDirectory = extra[1];
    if (mode === '--refused') await queryResultBudgetProbe(base, label, undefined, '32', observationDirectory);
    else {
      const client = await probeClient(new URL(base).origin, label);
      const started = performance.now();
      try {
        if (mode === '--full') {
          await queryResultBudgetProbe(base, label, client, 'normal', observationDirectory);
          const { fourReaders } = await import('./result-budget-readers.mjs');
          await fourReaders(client);
        } else if (mode === '--quick') {
          const { quickReaders } = await import('./result-budget-readers.mjs');
          await quickReaders(client);
        } else {
          const sql = tail => `SELECT repeat('x', CASE range WHEN 32 THEN ${tail} ELSE 1000000 END) AS v FROM range(33)`;
          const fitted = await boundary(tail => client.read('/api/query', { sql: sql(tail) }), client, 1, 'admitted observation calibration');
          let landed = false;
          for (let attempt = 0; attempt < 30; attempt++) {
            const body = { sql: sql(fitted.tail) };
            console.log(JSON.stringify({ observation: 'admitted-at-ceiling', attempt, request: { method: 'POST', path: '/api/query', body } }));
            const result = await observeRequest(observationDirectory, `admitted-at-ceiling-${attempt}`, body, () => client.read('/api/query', body, 'admitted-at-ceiling'));
            if (result.status === 200 && result.bytes === 33554432) { landed = true; break; }
            if (result.status === 200) fitted.tail += 33554432 - result.bytes;
            else { client.refused(result); fitted.tail--; }
          }
          assert.ok(landed, 'The observed request must return exactly 33554432 bytes');
        }
      } finally { await client.cleanup(); }
      console.log(JSON.stringify({ label, mode, seconds: (performance.now() - started) / 1000, result: 'confirmed' }));
    }
  } catch (error) {
    console.error(`failed: ${error.message}`);
    process.exitCode = 1;
  }
}
