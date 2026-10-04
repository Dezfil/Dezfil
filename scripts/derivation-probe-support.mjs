import assert from 'node:assert/strict';
export function assertAuthenticationBusy(result) {
  assert.equal(result.status, 503);
  assert.equal(result.headers['cache-control'], 'private, no-store');
  assert.equal(result.headers['retry-after'], '1');
  assert.ok(!result.headers['set-cookie'], 'busy cannot issue or roll a credential');
  assert.deepEqual(result.json, { error: { code: 'authentication_busy', message: 'Authentication is busy. Try again shortly.', retryAfter: 1 } });
}
export function assertDerivationSamples(rows) {
  const samples = rows.filter(row => row.phase === 'start' || row.phase === 'end' || row.phase === 'response' && row.admission);
  const starts = samples.filter(row => row.phase === 'start');
  assert.ok(starts.length > 0, 'native derivation observations are required');
  for (const row of samples) {
    assert.ok(row.admission, `missing shared admission at ${row.tag}`);
    const state = row.admission;
    assert.ok(row.nativeActive >= 0 && row.nativeActive <= 2, `native bound escaped at ${row.tag}: ${row.nativeActive}`);
    assert.ok(state.active >= row.nativeActive && state.active <= 2, `cross-route admission bypass at ${row.tag}`);
    assert.ok(state.activeProtected >= 0 && state.activeProtected <= 1, `protected bound escaped at ${row.tag}`);
    assert.ok(state.ordinary >= 0 && state.ordinary <= 6 && state.protected >= 0 && state.protected <= 2, `waiting bound escaped at ${row.tag}`);
    if (row.phase === 'start') {
      assert.equal(row.cost, 131072, 'measure the shipped work factor');
      assert.ok(row.source?.startsWith('198.18.'), 'trusted proxy must preserve the distinct test source');
      if (/^(password-change|recovery-redeem|protected-control)$/.test(row.tag)) assert.equal(state.activeProtected, 1, `protected classification: ${row.tag}`);
    }
  }
  const last = samples.at(-1);
  assert.equal(last.nativeActive, 0, 'native work recovers after drain');
  assert.deepEqual(last.admission, { active: 0, activeProtected: 0, ordinary: 0, protected: 0 }, 'admission recovers after drain');
  assert.ok(new Set(starts.map(row => row.source)).size >= 3, 'distinct verified proxy sources');
  const durations = tag => rows.filter(row => row.phase === 'end' && row.tag === tag).map(row => row.elapsedMs);
  const single = durations('timing-single'), paired = [...durations('timing-pair-0'), ...durations('timing-pair-1')];
  assert.equal(single.length, 1); assert.equal(paired.length, 2);
  for (const ms of [...single, ...paired]) assert.ok(Number.isFinite(ms) && ms > 0, 'positive measured derivation duration');
  return { singleMs: single[0], pairedMs: paired, ordinaryThreeWavesMs: 3 * Math.max(...paired), protectedCompetitionSixWavesMs: 6 * Math.max(...paired), waitingDeadlineMs: 5000,
    nativePeak: Math.max(...samples.map(row => row.nativeActive)), protectedPeak: Math.max(...samples.map(row => row.admission.activeProtected)),
    ordinaryWaitingPeak: Math.max(...samples.map(row => row.admission.ordinary)), protectedWaitingPeak: Math.max(...samples.map(row => row.admission.protected)) };
}

/** Actual password work on the local host, separately from served timings. */
export async function measureDerivationTiming(work) {
  const measured = async () => { const start = performance.now(); await work(); return performance.now() - start; };
  const singleMs = await measured(), pairedMs = await Promise.all([measured(), measured()]);
  return { singleMs, pairedMs, ordinaryThreeWavesMs: 3 * Math.max(...pairedMs), protectedCompetitionSixWavesMs: 6 * Math.max(...pairedMs), waitingDeadlineMs: 5000 };
}
