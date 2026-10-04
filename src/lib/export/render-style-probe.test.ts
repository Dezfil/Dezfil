import { describe, expect, it } from 'vitest';
import { completedTiles, assessMatrixArm, timingSummary } from '../../../scripts/render-style-assert.mjs';
import { fixtureHashes, fixtureResponse, timing, tile } from '../../../scripts/render-style-fixture.mjs';
import { matrixArms, timingArms } from '../../../scripts/render-egress-cases.mjs';
import { decodePng } from '../../../scripts/png-probe.mjs';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

function tiles(count = 64) {
  return {
    browser: Array.from({ length: count }, (_, i) => [
      { event: 'requestWillBeSent', targetId: 1, requestId: String(i), url: `http://timing.render.test:8080/tiles/6/${i}/1.png` },
      { event: 'responseReceived', targetId: 1, requestId: String(i), status: 200 },
      { event: 'loadingFinished', targetId: 1, requestId: String(i) },
    ]).flat(),
    host: Array.from({ length: count }, (_, i) => ({ arm: 'sample', phase: 'render', event: 'response', status: 200, path: `/tiles/6/${i}/1.png` })),
  };
}

describe('frozen external fixture and completed response counting', () => {
  it('pins resource bytes and the map definition independently of the mutable manifest', () => {
    expect(fixtureHashes()).toEqual({
      style: 'da07c6b59da606d3bcb33900cbd5aede6036a0251e6a7dd2eca31f13d73172f1',
      definition: '2ca406018f44da56596555bec63bf18e8fc76869e251784d7b26f1027896c762',
      tile: '0c108f1e4d0487d5c1264efe969623337893d655cde5ea88197d876dfe744ef5',
    });
    expect(timing.style.sources.tiles.tiles).toEqual(['http://timing.render.test:8080/tiles/{z}/{x}/{y}.png']);
    expect({ version: timing.version, resources: timing.resources, warmups: timing.warmups, samples: timing.samples, minimumTiles: timing.minimumTiles }).toEqual({
      version: 1, resources: { cpus: 2, memory: '4g' }, warmups: 2, samples: 10, minimumTiles: 64,
    });
    const png = decodePng(tile);
    expect([png.width, png.height, png.at(0, 0), png.at(255, 255)]).toEqual([256, 256, [0, 200, 216, 255], [0, 200, 216, 255]]);
  });
  it('counts distinct completed browser responses and cross-checks fixture completions', () => {
    const data = tiles();
    expect(completedTiles(data.browser, data.host, 'sample').browserCount).toBe(64);
    data.browser.push(...data.browser.slice(0, 3));
    expect(completedTiles(data.browser, data.host, 'sample').browserCount).toBe(64);
  });
  it('rejects fewer than 64, incomplete responses, non-200 responses and the wrong target identity', () => {
    const short = tiles(63);
    expect(() => completedTiles(short.browser, short.host, 'sample')).toThrow('require 64');
    for (const mutation of ['incomplete', 'status', 'target']) {
      const data = tiles();
      if (mutation === 'incomplete') data.browser.pop();
      if (mutation === 'status') data.browser[1].status = 500;
      if (mutation === 'target') data.browser[2].targetId = 2;
      expect(() => completedTiles(data.browser, data.host, 'sample')).toThrow('incomplete or failed');
    }
  });
  it('cannot count save traffic, received requests or unmatched fixture tiles as completed responses', () => {
    for (const mutation of ['save', 'request', 'mismatch']) {
      const data = tiles();
      if (mutation === 'save') data.host[0].phase = 'save';
      if (mutation === 'request') data.host[0].event = 'request';
      if (mutation === 'mismatch') data.host[0].path = '/tiles/6/100/1.png';
      expect(() => completedTiles(data.browser, data.host, 'sample')).toThrow();
    }
  });
  it('voids the entire series for any failed warmup/sample and excludes warmups from its median', () => {
    const report = timingArms().map((arm, i) => ({ arm, checks: [{ name: 'sample', ok: true }], result: { durationMs: i < 2 ? 999 : (i - 1) * 100, browserVersion: 'fixture-browser' } }));
    expect(timingSummary(report)).toMatchObject({ valid: true, medianMs: 550, warmups: 2, samples: 10 });
    report[0].checks[0].ok = false;
    expect(timingSummary(report)).toMatchObject({ valid: false, medianMs: null, reasons: ['timing-warmup-1: sample'] });
    expect(timingSummary(report.slice(1)).valid).toBe(false);
  });
});

describe('style dependency stimuli and compatibility controls', () => {
  it('owns one changed name per independent road with public companions', () => {
    const attacks = matrixArms().filter(arm => arm.kind === 'dependency' && arm.mode === 'rebind');
    expect(attacks.map(arm => arm.road)).toEqual(['redirect', 'source', 'sprite', 'glyph', 'tile', 'worker']);
    expect(new Set(matrixArms().map(arm => arm.author)).size).toBe(43);
    for (const arm of attacks) {
      const response = fixtureResponse(arm, '/style.json', 'host');
      expect(response.status).toBe(arm.road === 'redirect' ? 302 : 200);
      if (response.status === 200) expect(validateStyleMin(JSON.parse(String(response.body)))).toEqual([]);
      expect(arm.url).toContain(arm.root);
    }
  });
  it('separates the changed sprite JSON name from its concurrently requested image', () => {
    const state = { road: 'sprite', author: 'sprite.render.test', root: 'root.render.test' };
    expect(fixtureResponse(state, '/sprite.json', 'host').location).toBe('http://sprite.render.test:8080/sprite-data.json');
    expect(fixtureResponse(state, '/sprite.png', 'host').body).toEqual(tile);
  });
  it('puts the worker fetch in a remote GeoJSON source and the glyph fetch in a symbol layer', () => {
    const worker = fixtureResponse({ road: 'worker', author: 'worker.render.test' }, '/style.json', 'host');
    expect(JSON.parse(String(worker.body)).sources.points.data).toBe('http://worker.render.test:8080/points.json');
    const glyph = fixtureResponse({ road: 'glyph', author: 'glyph.render.test' }, '/style.json', 'host');
    expect(JSON.parse(String(glyph.body)).layers[1].layout['text-field']).toBe('A');
  });
  it('includes direct/redirect HTTP/HTTPS denials plus independent allowlist and dead-name controls', () => {
    const arms = matrixArms();
    expect(arms.filter(arm => arm.kind === 'literal-control')).toHaveLength(20);
    expect(arms.filter(arm => arm.kind === 'allowlist-control').map(arm => arm.id)).toEqual([
      'allow-hostname-listed', 'allow-hostname-public', 'allow-hostname-unlisted',
      'allow-ip-listed', 'allow-ip-public', 'allow-ip-unlisted',
      'allow-cidr-listed', 'allow-cidr-public', 'allow-cidr-unlisted',
    ]);
    expect(arms.filter(arm => arm.kind === 'dead-control').map(arm => arm.mode)).toEqual(['dead', 'public-dead']);
  });
  it('refuses to call a page request worker evidence or unrelated requests dependency evidence', () => {
    const arm = matrixArms().find(arm => arm.id === 'worker-rebind')!;
    const evidence = { dns: [], listener: [], host: [], netlog: {}, result: {}, browser: [
      { event: 'requestWillBeSent', target: 'page', url: 'http://worker-rebind.render.test:8080/points.json' },
    ] };
    const failed = () => assessMatrixArm(arm, evidence).filter(row => !row.ok).map(row => row.name);
    expect(failed()).toContain('dependency-request-observed');
    evidence.browser[0].target = 'other';
    expect(failed()).toContain('dependency-request-observed');
    evidence.browser[0].target = 'worker';
    expect(failed()).not.toContain('dependency-request-observed');
    evidence.browser[0].url = 'http://another.render.test:8080/points.json';
    expect(failed()).toContain('dependency-request-observed');
  });
});
