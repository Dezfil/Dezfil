import assert from 'node:assert/strict';
import http from 'node:http';

export function assertPublishedStatus(result, status) {
  assert.equal(result.status, status, `${status} expected: ${JSON.stringify(result)}`);
  if (status === 429 || status === 503) {
    assert.equal(result.headers['cache-control'], 'private, no-store');
    assert.deepEqual(result.json, { error: status === 503
      ? { code: 'ingress_unavailable', message: 'The instance cannot serve published maps yet.' }
      : { code: 'rate_limited', message: 'Too many requests. Please slow down.' } });
  }
}
export function assertPublicationState(rows, minimum) {
  const samples = rows.filter(row => row.phase === 'publication');
  assert.ok(samples.length >= minimum, 'missing per-admission state evidence');
  for (const sample of samples) assert.ok(sample.size > 0 && sample.size <= 10_000, `publication state escaped its bound: ${sample.size}`);
  return Math.max(...samples.map(sample => sample.size));
}

/** Real IPv4 socket, with explicit local binding. Forwarding is supplied only
 * by the controlled proxy arm; it cannot choose the socket's address. */
export function publicationRequest(base, pathname, { method = 'GET', localAddress = '127.0.0.1', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(pathname, base), { method, localAddress, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(text); } catch { /* empty */ }
        resolve({ status: response.statusCode, headers: response.headers, json, text });
      });
    });
    request.on('error', reject); request.setTimeout(30_000, () => request.destroy(new Error('Publication probe timeout')));
    request.end(body);
  });
}
