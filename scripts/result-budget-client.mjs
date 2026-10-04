import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { provisionJourney } from './journey-auth.mjs';
export const resultBytes = 33_554_432, cellBytes = 2_097_152;
export const sentence = 'The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.';
export const refusal = { error: { code: 'query_result_too_large', message: sentence } };
export const bytesOf = value => Buffer.byteLength(JSON.stringify(value));
export async function probeClient(origin, label) {
  const auth = process.env.DEZFIL_PROBE_TOKEN ? { token: process.env.DEZFIL_PROBE_TOKEN } : await provisionJourney(origin);
  const owned = [];
  async function request(path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const response = await fetch(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { authorization: `Bearer ${auth.token}`, 'accept-encoding': 'identity', ...headers, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
    return response;
  }
  async function read(path, body, tag = path, method, headers) {
    const response = await request(path, body, method, headers);
    const buffer = Buffer.from(await response.arrayBuffer());
    let json; try { json = JSON.parse(buffer.toString('utf8')); } catch { /* assertion at the caller */ }
    const answer = { status: response.status, bytes: buffer.length, body: json };
    console.log(JSON.stringify({ label, tag, status: answer.status, bytes: answer.bytes,
      contentEncoding: response.headers.get('content-encoding'), contentLength: response.headers.get('content-length'), transferEncoding: response.headers.get('transfer-encoding') }));
    return answer;
  }
  function fitting(answer) { assert.equal(answer.status, 200, answer.status === 200 ? '' : JSON.stringify(answer.body)); assert.ok(answer.bytes <= resultBytes); return answer.body; }
  function refused(answer) { assert.equal(answer.status, 422); assert.ok(answer.bytes < 1024); assert.deepEqual(answer.body, refusal); }
  async function upload(sql, suffix = 'sample') {
    // Blob geometry imports through the documented WKB road, under its
    // existing CRS assumption. This allows a native geometry choice preview.
    const file = await request('/api/query/export', { sql, format: 'geoparquet' });
    assert.equal(file.status, 200, await failureText(file));
    const form = new FormData();
    form.set('file', new Blob([await file.arrayBuffer()]), `budget_${randomUUID().replaceAll('-', '')}_${suffix}.parquet`);
    const response = await request('/api/tables', form);
    const table = await response.json();
    assert.equal(response.status, 201, JSON.stringify(table));
    owned.push(`/api/tables/${encodeURIComponent(table.name)}`);
    return table;
  }
  async function cleanup() {
    const failures = [];
    for (const path of owned.reverse()) {
      try { const r = await request(path, undefined, 'DELETE'); assert.ok(r.ok || r.status === 404, `cleanup ${path}: ${r.status}`); await r.body?.cancel(); }
      catch (e) { failures.push(e); }
    }
    if (auth.tokenId) {
      try { const r = await request(`/api/account/tokens/${auth.tokenId}`, undefined, 'DELETE'); assert.ok(r.ok); await r.body?.cancel(); }
      catch (e) { failures.push(e); }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned fixture cleanup failed');
  }
  return { origin, token: auth.token, owned, request, read, fitting, refused, upload, cleanup };
}
async function failureText(response) { return response.ok ? '' : await response.clone().text(); }

/** A fitting response is the only size oracle. Runtime digit changes and
 * dataset metadata changes must be re-fitted; inability to land is a failure. */
export async function boundary(read, client, initial, tag) {
  let tail = initial;
  let fitting = await read(tail);
  client.fitting(fitting);
  tail += resultBytes - fitting.bytes - 1;
  for (const delta of [-1, 0, 1]) {
    if (delta === 1) { client.refused(await read(tail + 1)); break; }
    let landed = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const answer = await read(tail);
      if (answer.status === 422) { client.refused(answer); tail -= 16; continue; }
      client.fitting(answer);
      const difference = resultBytes + delta - answer.bytes;
      if (difference === 0) { landed = true; fitting = answer; break; }
      tail += difference;
    }
    assert.ok(landed, `${tag}: could not land on result ceiling ${delta}`);
    console.log(JSON.stringify({ tag, boundary: delta, bytes: fitting.bytes, tail }));
    if (delta === -1) tail++;
  }
  return { tail, answer: fitting };
}
