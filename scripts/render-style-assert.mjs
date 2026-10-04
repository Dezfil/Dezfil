import assert from 'node:assert/strict';
import { assessCommon, assertLiveness, browserLookups, publicAddress, privateAddress, refusal } from './render-egress-assert.mjs';
import { timing, fixtureHashes } from './render-style-fixture.mjs';

export const dependencyPaths = {
  redirect: '/payload.json', source: '/metadata.json', sprite: '/sprite-data.json',
  glyph: '/glyphs/', tile: '/tiles/', worker: '/points.json',
};

export function assessMatrixArm(arm, evidence) {
  const { checks, check, measured } = assessCommon(arm, evidence);
  const { result, browser, dns, listener, local = [], netlog } = evidence;
  if (arm.local) check('local-listener-live-before-measurement', () => assertLiveness(local, arm.id, { ...result.localLive, armedAt: result.armedAt }));
  if (arm.kind === 'dependency') {
    check('dependency-request-observed', () => {
      const requests = browser.filter(row => row.event === 'requestWillBeSent' && row.url?.startsWith(`http://${arm.author}:8080${dependencyPaths[arm.road]}`));
      assert.ok(requests.length, `missing ${arm.road} request from style`);
      if (arm.road === 'worker') assert.ok(requests.some(row => row.target === 'worker'), 'fetch not observed in a worker target');
    });
    check('dependency-answer-sequence', () => {
      const answers = measured(dns).filter(row => row.name === arm.author && row.type === 1);
      assert.ok(answers.length, 'missing dependency A answers');
      assert.deepEqual(answers[0].answers, [publicAddress], 'first dependency admission must be public');
      if (arm.mode === 'rebind') {
        assert.ok(answers.length >= 2, 'missing connection-time lookup');
        assert.ok(answers.slice(1).every(row => JSON.stringify(row.answers) === JSON.stringify([privateAddress])), 'more than one public answer');
      } else assert.ok(answers.every(row => JSON.stringify(row.answers) === JSON.stringify([publicAddress])), 'public control changed its answer');
      const aaaa = measured(dns).filter(row => row.name === arm.author && row.type === 28);
      assert.ok(aaaa.length && aaaa.every(row => row.answers.length === 0), 'missing/nonempty AAAA answers');
    });
    if (arm.mode === 'rebind') check('browser-dns-absent', () => assert.deepEqual(browserLookups(netlog, arm.author), []));
  }
  if (arm.kind === 'dead-control') check('dead-answer-sequence', () => {
    const answers = measured(dns).filter(row => row.name === arm.author && row.type === 1);
    assert.ok(answers.length, 'missing dead-name evidence');
    if (arm.mode === 'public-dead') {
      assert.deepEqual(answers[0].answers, [publicAddress]); assert.ok(answers.length >= 2);
    }
    const dead = arm.mode === 'public-dead' ? answers.slice(1) : answers;
    assert.ok(dead.every(row => row.rcode === 3 && row.answers.length === 0), 'dead answers must be NXDOMAIN');
  });
  if (arm.expected !== 'private-allowed') {
    check('private-connections-zero', () => assert.equal(measured(listener).filter(row => row.event === 'connection').length, 0));
    check('private-requests-zero', () => assert.equal(measured(listener).filter(row => row.event === 'request').length, 0));
  }
  if (arm.local) check('unlisted-local-listener-silent', () => assert.equal(measured(local).filter(row => ['connection', 'request'].includes(row.event)).length, 0));
  if (arm.expected === 'denied') check('exact-policy-answer', () => {
    assert.equal(result.status, 502); assert.equal(result.body?.error?.code, 'render_failed');
    assert.equal(result.body?.error?.message, refusal); assert.equal(result.png, null);
  });
  else check('completed-control-png', () => {
    assert.equal(result.status, 200); assert.equal(result.png?.width, 640); assert.equal(result.png?.height, 360);
    assert.equal(result.abandoned, null);
    if (arm.expected === 'public') assert.ok(result.png.cyan > 200_000, 'public fixture pixels absent');
    if (arm.expected === 'private-allowed') {
      assert.ok(result.png.magenta > 200_000, 'allowed private pixels absent');
      assert.ok(measured(listener).some(row => row.event === 'connection'), 'allowed private connection absent');
      assert.ok(measured(listener).some(row => row.event === 'request' && row.path === '/style.json'), 'allowed private GET absent');
    }
    if (arm.expected === 'dead') {
      assert.ok(result.png.colored > 10, 'data did not survive the dead style');
      assert.equal(result.png.magenta, 0);
      assert.ok(browser.some(row => row.event === 'capture' && row.text.includes("this map's basemap didn't load · data only")), 'shipped dead-style wording missing at capture');
    }
  });
  return checks;
}

export function completedTiles(browser, host, id) {
  const key = row => `${row.targetId}:${row.requestId}`;
  const requests = browser.filter(row => row.event === 'requestWillBeSent' && /^http:\/\/timing\.render\.test:8080\/tiles\/\d+\/\d+\/\d+\.png$/.test(row.url ?? ''));
  const finished = new Set(browser.filter(row => row.event === 'loadingFinished').map(key));
  const success = new Set(browser.filter(row => row.event === 'responseReceived' && row.status === 200).map(key));
  assert.ok(requests.every(row => finished.has(key(row)) && success.has(key(row))), 'incomplete or failed browser tile request');
  const browserPaths = [...new Set(requests.map(row => new URL(row.url).pathname))].sort();
  const hostPaths = [...new Set(host.filter(row => row.arm === id && row.phase === 'render' && row.event === 'response' && row.status === 200 && /^\/tiles\//.test(row.path)).map(row => row.path))].sort();
  assert.ok(browserPaths.length >= 64, `only ${browserPaths.length} distinct completed browser tiles; require 64`);
  assert.ok(hostPaths.length >= 64, `only ${hostPaths.length} completed fixture tiles; require 64`);
  assert.deepEqual(browserPaths, hostPaths, 'browser and fixture tile sets differ');
  return { browserCount: browserPaths.length, fixtureCount: hostPaths.length, paths: browserPaths };
}

export function assessTimingArm(arm, evidence) {
  const { checks, check, measured } = assessCommon(arm, evidence);
  check('frozen-fixture', () => assert.deepEqual(fixtureHashes(), {
    style: 'da07c6b59da606d3bcb33900cbd5aede6036a0251e6a7dd2eca31f13d73172f1',
    definition: '2ca406018f44da56596555bec63bf18e8fc76869e251784d7b26f1027896c762',
    tile: '0c108f1e4d0487d5c1264efe969623337893d655cde5ea88197d876dfe744ef5',
  }));
  check('complete-timing-png', () => {
    assert.equal(evidence.result.status, 200); assert.equal(evidence.result.abandoned, null);
    assert.equal(evidence.result.png?.width, 2048); assert.equal(evidence.result.png?.height, 2048);
    assert.ok(evidence.result.png.cyan > 3_800_000, 'fixture pixels missing');
    assert.ok(evidence.result.durationMs > 0);
    const versions = evidence.browser.filter(row => row.event === 'version').map(row => row.version);
    assert.equal(versions.length, 1, 'one fresh browser per export');
    assert.ok(versions[0]); evidence.result.browserVersion = versions[0];
  });
  check('at-least-64-completed-tiles', () => {
    evidence.result.tiles = completedTiles(evidence.browser, evidence.host, arm.id);
  });
  check('private-listener-silent', () => assert.equal(measured(evidence.listener).filter(row => ['connection', 'request'].includes(row.event)).length, 0));
  return checks;
}

export function timingSummary(report) {
  const reasons = report.flatMap(row => row.failure ? [`${row.arm.id}: ${row.failure}`] : row.checks.filter(check => !check.ok).map(check => `${row.arm.id}: ${check.name}`));
  if (report.length !== 12) reasons.push(`expected 12 exports, saw ${report.length}`);
  const durations = report.filter(row => !row.arm.warmup).map(row => row.result?.durationMs);
  if (durations.length !== 10 || durations.some(value => !Number.isFinite(value))) reasons.push('missing measured durations');
  const versions = report.map(row => row.result?.browserVersion);
  if (versions.some(value => !value) || new Set(versions).size !== 1) reasons.push('browser version missing or changed within run');
  const sorted = [...durations].sort((a, b) => a - b);
  return { valid: reasons.length === 0, reasons, warmups: 2, samples: 10, durations,
    medianMs: reasons.length ? null : (sorted[4] + sorted[5]) / 2, fixture: timing.sha256,
    guardedRoad: 'not measured; baseline tile counting only' };
}
