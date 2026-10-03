import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

export const SMALL_LIMIT = 65_536;
export const WIRE_SLACK = 16_384;
export const LARGE_SENDER = 4 * 1024 * 1024;
export const excludedPaths = ['/api/tables', '/api/published/missing/widget-values', '/api/published/missing/render/layer', '/api/published/missing/extent/layer'];

/** Exact-sized CSV with independently known rows, emitted in at most 64 KiB chunks. */
export function csvFixture(bytes) {
  const header = Buffer.from('label,lon,lat\n');
  const rowBytes = 1024, suffix = Buffer.from(',1,2\n');
  const fullRows = Math.floor((bytes - header.length) / rowBytes);
  const remainder = bytes - header.length - fullRows * rowBytes;
  assert.ok(fullRows >= 1 && (remainder === 0 || remainder >= suffix.length + 1));
  const row = Buffer.alloc(rowBytes, 'x'); suffix.copy(row, rowBytes - suffix.length);
  const batch = Buffer.concat(Array(64).fill(row));
  return { bytes, rows: fullRows + Number(remainder > 0), *chunks() {
    yield header;
    let left = fullRows;
    while (left) { const count = Math.min(left, 64); yield batch.subarray(0, count * rowBytes); left -= count; }
    if (remainder) { const tail = Buffer.alloc(remainder, 'x'); suffix.copy(tail, remainder - suffix.length); yield tail; }
  } };
}

/** Receive status while sending, never after it. Count bytes handed to write()
 * at the instant response headers arrive, then stop producing body chunks. */
/** @param {string} url
 * @param {{method?: string, headers?: Record<string, string>, chunks?: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, paceMs?: number, headersOnly?: boolean, onWrite?: (bytes: number) => Promise<void>, timeoutMs?: number}} options */
export async function exchange(url, { method = 'POST', headers = {}, chunks = [], paceMs = 0, headersOnly = false, onWrite, timeoutMs = 120_000 } = {}) {
  const transport = new URL(url).protocol === 'https:' ? https : http;
  let written = 0, received = false, ended = false, timer;
  let finish, fail;
  const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const request = transport.request(url, { method, headers }, response => {
    received = true;
    const bytesAtStatus = written, parts = [];
    response.on('data', chunk => parts.push(chunk));
    response.on('error', fail);
    response.on('end', () => {
      ended = true;
      const text = Buffer.concat(parts).toString('utf8');
      let json; try { json = JSON.parse(text); } catch { /* TRACE and HEAD are empty. */ }
      finish({ status: response.statusCode, headers: response.headers, text, json, bytesAtStatus });
    });
  });
  request.on('error', error => { if (!received) fail(error); });
  timer = setTimeout(() => fail(new Error(`Response timeout after ${timeoutMs}ms; wrote ${written} body bytes`)), timeoutMs);
  request.flushHeaders();
  const sending = (async () => {
    if (headersOnly) return;
    for await (const chunk of chunks) {
      if (received || request.destroyed) break;
      // Respect backpressure, but a response must also wake a blocked producer.
      const writable = request.write(chunk); written += chunk.length;
      if (onWrite) await onWrite(written);
      if (!writable && !received && !request.destroyed) await new Promise(resolve => {
        const wake = () => { request.off('drain', wake); request.off('response', wake); request.off('close', wake); resolve(); };
        request.once('drain', wake); request.once('response', wake); request.once('close', wake);
      });
      if (paceMs && !received) await delay(paceMs);
    }
    if (!received && !request.destroyed) request.end();
  })().catch(fail);
  try { return await result; }
  finally {
    clearTimeout(timer);
    request.destroy();
    await sending;
    if (!ended) received = true;
  }
}

export function assertSmallRefusal(result, declared) {
  assert.equal(result.status, 413, `public body status: ${result.status} ${result.text}`);
  assert.deepEqual(result.json, { error: { code: 'request_body_too_large', message: 'The request body exceeds the 65536-byte limit.' } });
  assert.equal(result.headers['cache-control'], 'private, no-store');
  assert.ok(result.bytesAtStatus <= (declared ? 0 : SMALL_LIMIT + WIRE_SLACK), `late public refusal: ${result.bytesAtStatus} body bytes written`);
}
export function assertUpload(result, rows) {
  assert.equal(result.status, 201, `whole upload: ${result.status} ${result.text}`);
  assert.equal(Number(result.json.rowCount), rows, 'ingest retains every fixture row');
  assert.equal(result.headers['cache-control'], 'private, no-store');
}
export function assertScratchGrowth(samples) {
  assert.ok(samples.length >= 2 && samples.some((value, index) => index > 0 && value > samples[index - 1]), 'scratch file must grow while the upload is still sending');
}
export function assertWorkflow(result) {
  assert.equal(result.status, 400);
  assert.deepEqual(result.json, { error: { code: 'invalid_request', message: '"name" must be a non-empty string.' } }, 'complete workflow JSON reaches name validation, not a truncation parse error');
}
export function assertNoTruncation(log) {
  assert.doesNotMatch(log, /(?:body exceeded|body size.*exceed|truncat|proxyClientMaxBodySize)/i, 'framework body truncation warning');
}
