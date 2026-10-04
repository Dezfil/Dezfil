// A failed connection during synchronous maintenance is an observation, not
// a failed measurement. Only successful replies end the uninterrupted gap.
export async function sampleCompaction({ health, compact, sampleSpace, now = () => performance.now(), spaceInterval = 100 }) {
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
    maxHealthLatencyMs: Math.max(0, ...latencies), maxGapMs,
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
