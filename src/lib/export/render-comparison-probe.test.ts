import { describe, expect, it } from 'vitest';
import { guardedTiles, pairedSummary } from '../../../scripts/render-comparison-assert.mjs';
import { inspectSocksStream } from '../../../scripts/render-road-observer.mjs';
import { timingArms } from '../../../scripts/render-egress-cases.mjs';

function series() {
  return timingArms().flatMap((arm, i) => (i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']).map(version => ({ arm, version,
    checks: [{ name: 'complete', ok: true }], result: { durationMs: version === 'baseline' ? 4000 : 5000, browserVersion: 'same', guardedTiles: { count: 81 } } })));
}
describe('paired timing evidence', () => {
  it('reports both medians, milliseconds and ratio, with a separate explanation threshold', () => {
    expect(pairedSummary(series())).toMatchObject({ valid: true, baselineMedianMs: 4000, candidateMedianMs: 5000, deltaMs: 1000, ratio: 1.25, withinBound: true, explanationNeeded: true });
  });
  it('voids both series for a failed warmup, missing sample, mismatched browser or absent guarded count', () => {
    const bad = series(); bad[0].checks[0].ok = false;
    for (const rows of [bad, series().slice(1), series().map((row, i) => i === 0 ? { ...row, result: { ...row.result, browserVersion: 'other' } } : row),
      series().map(row => ({ ...row, result: { ...row.result, guardedTiles: { count: 0 } } })), [...series()].reverse()]) {
      expect(pairedSummary(rows)).toMatchObject({ valid: false, baselineMedianMs: null, candidateMedianMs: null, ratio: null });
    }
  });
  it('fails the bound for a delay seed without discarding the valid slow run', () => {
    const rows = series(); rows.filter(row => row.version === 'candidate').forEach(row => { row.result.durationMs = 8000; });
    expect(pairedSummary(rows)).toMatchObject({ valid: true, withinBound: false, ratio: 2 });
  });
  it('rejects direct bypass even when the browser and fixture have enough tiles', () => {
    expect(() => guardedTiles([], [{ event: 'ready' }], Array.from({ length: 81 }, (_, i) => `/tiles/5/${i}/1.png`))).toThrow('only 0 distinct guarded');
  });
});
describe('passive SOCKS wire parser', () => {
  const name = Buffer.from('timing.render.test');
  const connect = Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, name.length]), name, Buffer.from([31, 144])]);
  const reply = Buffer.from([5, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  it('waits for fragmented negotiation and a complete response body', () => {
    const request = Buffer.concat([connect, Buffer.from('GET /tiles/5/1/1.png HTTP/1.1\r\nHost: timing.render.test:8080\r\n\r\n')]);
    const response = Buffer.concat([reply, Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ntile')]);
    for (let i = 0; i < connect.length; i++) expect(inspectSocksStream(request.subarray(0, i), response)).toBeNull();
    expect(inspectSocksStream(request, response.subarray(0, -1))).not.toHaveProperty('path');
    expect(inspectSocksStream(request, response)).toMatchObject({ host: 'timing.render.test', port: 8080, path: '/tiles/5/1/1.png', status: 200, bytes: 4 });
  });
  it('does not count failed CONNECT, opaque TLS or requests without complete responses', () => {
    expect(inspectSocksStream(connect, Buffer.from([5, 0, 5, 2, 0, 1, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(inspectSocksStream(Buffer.concat([connect, Buffer.from([22, 3, 1])]), reply)).toEqual({ host: 'timing.render.test', port: 8080, connected: true });
  });
});

describe('guarded tile correlation', () => {
  function evidence() {
    const paths = Array.from({ length: 64 }, (_, i) => `/tiles/5/${i}/1.png`).sort();
    return { paths, browser: paths.flatMap((path, i) => [
      { event: 'responseReceived', targetId: 1, requestId: String(i), url: `http://timing.render.test:8080${path}`, status: 200 },
      { event: 'loadingFinished', targetId: 1, requestId: String(i) },
    ]), road: [{ event: 'ready' }, { event: 'road-listener', port: 5678 }, ...paths.map((path, i) => ({
      event: 'road-response', host: 'timing.render.test', port: 8080, localPort: 5678, stream: i, path, status: 200,
      sha256: '0c108f1e4d0487d5c1264efe969623337893d655cde5ea88197d876dfe744ef5',
    }))] };
  }
  it('joins completed browser IDs to independent streams by exact fixture path', () => {
    const e = evidence(); expect(guardedTiles(e.browser, e.road, e.paths)).toMatchObject({ count: 64 });
    const changed = e.road.map(row => row.event === 'road-response' ? { ...row, sha256: 'wrong' } : row);
    expect(() => guardedTiles(e.browser, changed, e.paths)).toThrow('road tile bytes differ');
    expect(() => guardedTiles(e.browser, e.road.filter(row => row.event !== 'road-listener'), e.paths)).toThrow('launched SOCKS');
    expect(() => guardedTiles(e.browser.slice(1), e.road, e.paths)).toThrow('missing browser response IDs');
  });
});
