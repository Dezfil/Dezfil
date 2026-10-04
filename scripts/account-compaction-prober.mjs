import assert from 'node:assert/strict';

// A failed connection during synchronous maintenance is an observation, not
// a failed measurement. Only successful replies end the uninterrupted gap.
export async function sampleCompaction({ health, compact, sampleSpace, now = () => performance.now(), spaceInterval = 100, seed = '' }) {
  let lastHealthy = now(), maxGapMs = 0, failedHealthAttempts = 0;
  const latencies = [], pending = new Set();
  const pulse = () => {
    const started = now();
    const attempt = Promise.resolve().then(health).then(() => {
      const end = now();
      latencies.push(end - started); maxGapMs = Math.max(maxGapMs, end - lastHealthy); lastHealthy = end;
    }, () => { failedHealthAttempts++; }).finally(() => pending.delete(attempt));
    pending.add(attempt);
    return attempt;
  };
  await pulse();
  const timer = setInterval(pulse, 100), spaces = setInterval(sampleSpace, spaceInterval);
  let result;
  try { result = await compact(); }
  finally {
    clearInterval(timer); clearInterval(spaces); sampleSpace();
    await Promise.all(pending);
  }
  await pulse();
  maxGapMs = Math.max(maxGapMs, now() - lastHealthy);
  return { result, healthSamples: latencies.length, failedHealthAttempts,
    // Proof-only defect: lose the outside observation while retaining the
    // worker's interval. A maximum derived from that interval cannot hide it.
    maxHealthLatencyMs: seed === 'pause' ? 0 : Math.max(0, ...latencies), maxGapMs: seed === 'pause' ? 0 : maxGapMs,
    pauseMs: Math.max(result.intervalMs ?? 0, maxGapMs, ...latencies) };
}

export async function runProofArms(arms, cleanup) {
  const failures = [];
  for (const arm of arms) {
    try { await arm(); } catch (error) { failures.push(error); }
    finally { try { await cleanup(); } catch (error) { failures.push(error); } }
  }
  return failures;
}
export function reportPause(row, record, log) {
  const referenceMs = 5000, aboveReference = row.pauseMs > referenceMs;
  record({ ...row, referenceMs, aboveReference });
  log(`${row.mode} ${row.mib} MiB trial ${row.trial} pause ${(row.pauseMs / 1000).toFixed(3)} s: ${aboveReference ? 'above' : 'at or below'} 5.0 s reference mark`);
  const interval = row.result.intervalMs, outside = Math.max(row.maxGapMs, row.maxHealthLatencyMs);
  for (const value of [interval, row.maxGapMs, row.maxHealthLatencyMs, row.pauseMs]) assert.ok(Number.isFinite(value) && value >= 0, 'finite nonnegative pause measurements');
  assert.ok(row.healthSamples >= 2 && outside > 0, 'outside probe must observe the pause with successful health replies');
  // Allow the 100 ms probe cadence, 500 ms request timeout and scheduling/
  // transport overhead. This checks agreement, not a maximum service pause.
  assert.ok(Math.abs(outside - interval) <= 1000, `outside pause ${outside} ms and in-process interval ${interval} ms must agree within 1000 ms`);
  assert.equal(row.pauseMs, Math.max(interval, outside), 'reported pause must include the outside observation and in-process interval');
}

export function assertProofSucceeded(failures, interrupted) {
  if (failures.length || interrupted) throw new Error([
    ...failures.map(error => error.message), ...(interrupted ? ['Proof interrupted'] : []),
  ].join('\n'));
}
