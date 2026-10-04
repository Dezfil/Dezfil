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
export function assertPublicationState(rows, minimum, requireCapacity = false) {
  const samples = rows.filter(row => row.phase === 'publication');
  assert.ok(samples.length >= minimum, 'missing per-admission state evidence');
  for (const sample of samples) assert.ok(sample.size > 0 && sample.size <= 10_000, `publication state escaped its bound: ${sample.size}`);
  const peak = Math.max(...samples.map(sample => sample.size));
  if (requireCapacity) {
    assert.equal(peak, 10_000, 'capacity arm never reached the bound; expiry may have hidden eviction');
    const firstFull = samples.findIndex(sample => sample.size === 10_000);
    assert.ok(firstFull < samples.length - 1, 'capacity arm needs an admission after first reaching the bound');
    assert.equal(samples.at(-1).size, 10_000, 'capacity arm did not retain the bound after further admissions');
  }
  return peak;
}

/** Real IPv4 socket, with explicit local binding. Forwarding is supplied only
 * by the controlled proxy arm; it cannot choose the socket's address.
 * @param {string} base
 * @param {string} pathname
 * @param {{method?: string, localAddress?: string, headers?: Record<string, string>, body?: string}} options
 */
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
