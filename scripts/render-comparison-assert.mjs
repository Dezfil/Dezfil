import assert from 'node:assert/strict';
import { timingArms } from './render-egress-cases.mjs';
import { timingSummary } from './render-style-assert.mjs';

export function guardedTiles(browser, road, paths) {
  assert.ok(road.some(row => row.event === 'ready'), 'missing road observer');
  assert.ok(!road.some(row => row.event === 'road-error'), 'road observation failed');
  const ports = new Set(road.filter(row => row.event === 'road-listener').map(row => row.port));
  const responses = road.filter(row => row.event === 'road-response' && row.host === 'timing.render.test' && row.port === 8080 && row.status === 200 && /^\/tiles\//.test(row.path));
  for (const row of responses) {
    assert.ok(ports.has(row.localPort), 'response did not use the launched SOCKS listener');
    assert.equal(row.sha256, '0c108f1e4d0487d5c1264efe969623337893d655cde5ea88197d876dfe744ef5', 'road tile bytes differ');
  }
  const observed = [...new Set(responses.map(row => row.path))].sort();
  assert.ok(observed.length >= 64, `only ${observed.length} distinct guarded tile responses; require 64`);
  assert.deepEqual(observed, paths, 'guarded and browser tile sets differ');
  const keys = new Set(browser.filter(row => row.event === 'loadingFinished').map(row => `${row.targetId}:${row.requestId}`));
  const matches = browser.filter(row => row.event === 'responseReceived' && row.status === 200 && row.url?.startsWith('http://timing.render.test:8080/tiles/') && keys.has(`${row.targetId}:${row.requestId}`))
    .map(row => ({ path: new URL(row.url).pathname, browserRequest: `${row.targetId}:${row.requestId}`, streams: responses.filter(r => r.path === new URL(row.url).pathname).map(r => r.stream) }));
  assert.deepEqual([...new Set(matches.map(row => row.path))].sort(), observed, 'missing browser response IDs');
  return { count: observed.length, matches };
}

export function pairedSummary(rows) {
  const baseline = timingSummary(rows.filter(row => row.version === 'baseline'));
  const candidate = timingSummary(rows.filter(row => row.version === 'candidate'));
  const reasons = [...baseline.reasons, ...candidate.reasons];
  const expected = timingArms().flatMap((arm, i) => (i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']).map(version => `${version}:${arm.id}`));
  if (JSON.stringify(rows.map(row => `${row.version}:${row.arm.id}`)) !== JSON.stringify(expected)) reasons.push('missing or non-interleaved samples');
  const versions = rows.map(row => row.result?.browserVersion);
  if (new Set(versions).size !== 1) reasons.push('baseline and candidate browsers differ');
  if (rows.some(row => row.version === 'candidate' && !(row.result?.guardedTiles?.count >= 64))) reasons.push('candidate guarded responses missing');
  const valid = reasons.length === 0;
  const baselineMedianMs = valid ? baseline.medianMs : null, candidateMedianMs = valid ? candidate.medianMs : null;
  const ratio = valid ? candidateMedianMs / baselineMedianMs : null;
  return { valid, reasons, baselineMedianMs, candidateMedianMs, deltaMs: valid ? candidateMedianMs - baselineMedianMs : null,
    ratio, observerCost: 'Confirmed mechanism, unmeasured impact: both images load the road observer, but only candidate SOCKS streams pay its buffering, parsing and SHA-256 cost inside the timed window. This can only inflate the candidate duration and ratio; the added cost is unmeasured.',
    withinBound: valid && ratio <= 1.5, explanationNeeded: valid && ratio > 1.2 };
}
