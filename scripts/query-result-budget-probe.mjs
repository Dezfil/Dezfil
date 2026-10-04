import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { provisionJourney } from './journey-auth.mjs';

const sentence = 'The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.';

/** Run against an isolated built server or container, configured with
 * DEZFIL_QUERY_MEMORY_MB=32. An existing account token may be supplied in
 * DEZFIL_PROBE_TOKEN; otherwise provision the standard journey account.
 * Fetch decodes content encoding. Count the actual uncompressed entity bytes,
 * independently of Content-Length (which may describe compressed transport).
 */
export async function queryResultBudgetProbe(base, label = 'standalone') {
  const origin = new URL(base).origin;
  const token = process.env.DEZFIL_PROBE_TOKEN || (await provisionJourney(origin)).token;
  const response = await fetch(`${origin}/api/query`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'accept-encoding': 'identity' },
    body: JSON.stringify({ sql: "SELECT repeat('x', 1000000) AS payload FROM range(40)" }),
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
  const observed = { label, status: response.status, bytes,
    code: body?.error?.code ?? null,
    contentEncoding: response.headers.get('content-encoding'),
    contentLength: response.headers.get('content-length'),
    transferEncoding: response.headers.get('transfer-encoding'),
    engineMemoryMb: '32 (operator configuration; not measured by this probe)' };
  console.log(JSON.stringify(observed));
  assert.equal(response.status, 422, `forty-row refusal: observed HTTP ${response.status}, ${bytes} bytes`);
  assert.ok(bytes < 1024, `refusal must be under 1 KiB; observed ${bytes} bytes`);
  assert.deepEqual(body, { error: { code: 'query_result_too_large', message: sentence } }, 'exact catalogue refusal, without data or details');
  console.log('confirmed: served forty-row query returned only the catalogue refusal under 1 KiB');
  return observed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [base, label = 'standalone'] = process.argv.slice(2);
    assert.ok(base && /^https?:\/\//.test(base), 'Usage: query-result-budget-probe.mjs ORIGIN [standalone|container]');
    assert.ok(['standalone', 'container'].includes(label), 'label must be standalone or container');
    await queryResultBudgetProbe(base, label);
  } catch (error) {
    console.error(`failed: ${error.message}`);
    process.exitCode = 1;
  }
}
