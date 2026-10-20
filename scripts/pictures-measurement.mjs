import assert from 'node:assert/strict';

export function percentile(values, fraction) {
  assert.ok(values.length, 'Missing timing samples');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Slot lifetime, not publication lifetime: reduction happens after release.
 * Event indices distinguish consecutive appearances of the same map. */
export function activeRenders(events, end = events.length) {
  let active = [];
  for (let index = 0; index < end; index++) {
    const event = events[index];
    if (event.kind === 'boot') active = [];
    if (event.kind === 'admitted') active.push({ ...event, index });
    if (event.kind === 'released') active = active.filter(start =>
      !(start.pid === event.pid && start.mapId === event.mapId && start.background === event.background));
  }
  return active;
}

export function foregroundTiming(sample, events) {
  assert.ok(Number.isInteger(sample.eventOffset) && sample.eventOffset >= 0 && sample.eventOffset <= events.length, 'Missing foreground event cursor');
  const admissionIndex = events.findIndex((event, index) => index >= sample.eventOffset && event.kind === 'admitted' &&
    !event.background && event.mapId === sample.mapId && event.at >= sample.requestedAt && event.at <= sample.answeredAt);
  assert.ok(admissionIndex >= 0, 'A foreground admission was not measured');
  return { admissionIndex, startMs: events[admissionIndex].at - sample.requestedAt, answerMs: sample.answeredAt - sample.requestedAt };
}

export function assertForegroundOverlap(sample, events) {
  const timing = foregroundTiming(sample, events);
  const active = activeRenders(events, sample.eventOffset);
  assert.ok(active.length === 1 && active[0].background && active[0].at <= sample.requestedAt, 'Sample requires exactly one background render in flight');
  // A sample that waited for that render to finish must not calibrate away
  // the queueing defect, even if a different background render has started.
  assert.ok(activeRenders(events, timing.admissionIndex).some(start => start.index === active[0].index), 'Foreground admission must overlap the same background render');
  return { ...timing, backgroundAdmissionIndex: active[0].index };
}

export function foregroundLimits(samples, events, pictureMs, concurrency) {
  assert.equal(concurrency, 2, 'Foreground limits require the default two slots');
  assert.ok(Number.isFinite(pictureMs) && pictureMs > 0, 'Missing picture duration for the margin guard');
  const limits = {};
  for (const [kind, measure, field] of [['export', 'startMs', 'exportStartMs'], ['check', 'answerMs', 'checkAnswerMs']]) {
    assert.equal(samples[kind].length, 5, 'Foreground limits require five samples of each operation');
    const p90 = percentile(samples[kind].map(sample => assertForegroundOverlap(sample, events)[measure]), .9);
    limits[field] = Math.ceil(p90 * 1.5);
    assert.ok(limits[field] - p90 < pictureMs, 'Foreground margin must stay below one measured picture render');
  }
  return limits;
}

export function assertForegroundInterruption(sample, events, budgetMs) {
  const timing = foregroundTiming(sample, events), active = activeRenders(events, sample.eventOffset);
  assert.ok(active.length === 1 && active[0].background, 'Interruption requires one background render');
  assert.ok(events.slice(sample.eventOffset, timing.admissionIndex).some(event => event.kind === 'interrupted' &&
    event.mapId === active[0].mapId && event.pid === active[0].pid && event.at >= sample.requestedAt), 'The foreground did not interrupt its background render');
  assert.ok(!activeRenders(events, timing.admissionIndex).some(start => start.index === active[0].index), 'The interrupted slot was not released');
  assert.ok(timing.startMs <= budgetMs, 'Foreground export start exceeded one picture budget');
  return timing;
}

export function assertBacklogSample(maps, events, sample, checkpoint) {
  const overlap = assertForegroundOverlap(sample, events);
  const pending = maps.filter(map => map.group !== 'current');
  const background = events[overlap.backgroundAdmissionIndex];
  const published = capacityEvents(maps, events.slice(0, sample.eventOffset), false);
  assert.ok(pending.some(map => map.id === background.mapId) && !published.some(event => event.mapId === background.mapId), 'Overlap must be work on a pending fixture map');
  const lower = Math.floor(checkpoint * pending.length / 5), upper = Math.floor((checkpoint + 1) * pending.length / 5);
  assert.ok(checkpoint >= 0 && checkpoint < 5 && published.length >= lower && published.length < upper, 'Backlog sample missed its progress window');
  return { ...overlap, checkpoint, publications: published.length };
}

/** Advance on publications rather than guessed wall-clock delays. The caller
 * bounds polling and records samples before any assertion can fail. Only the
 * mixed workload restarts, so `restart` is optional.
 * @param {{ maps: any[], events: () => any[], foreground: (check: boolean) => Promise<any>,
 *   poll: () => Promise<void>, record: (kind: string, sample: any) => unknown, limits: any,
 *   beforeRestart?: () => Promise<void>, restart?: (sample: any) => Promise<void> }} options */
export async function measureBacklog({ maps, events, foreground, poll, record, limits, restart, beforeRestart }) {
  const pending = maps.filter(map => map.group !== 'current').length;
  let restarted = false;
  for (let checkpoint = 0; checkpoint < 5; checkpoint++) for (const kind of ['export', 'check']) {
    for (;;) {
      const observed = events(), published = capacityEvents(maps, observed, false).length;
      if (restart && !restarted && published >= pending / 2) {
        assert.ok(published <= pending / 2 + 1, 'The restart checkpoint was missed');
        await beforeRestart?.();
        const atRestart = events(), count = capacityEvents(maps, atRestart, false).length;
        assert.ok(count <= pending / 2 + 1, 'The restart checkpoint was missed');
        const active = activeRenders(atRestart);
        if (active.length !== 1 || !active[0].background) { await poll(); continue; }
        assert.ok(maps.some(map => map.id === active[0].mapId && map.group !== 'current') &&
          !atRestart.some(event => event.kind === 'published' && event.mapId === active[0].mapId), 'Restart must interrupt unpublished fixture work');
        const sample = { publications: count, admissionIndex: active[0].index, eventOffset: atRestart.length };
        await restart(sample);
        assertRestartInterrupted(sample, events(), false);
        restarted = true;
        continue;
      }
      assert.ok(published < Math.floor((checkpoint + 1) * pending / 5), 'Backlog sample missed its progress window');
      const active = activeRenders(observed);
      if (published >= Math.floor(checkpoint * pending / 5) && active.length === 1 && active[0].background) break;
      await poll();
    }
    const sample = { ...await foreground(kind === 'check'), checkpoint };
    record(kind, sample);
    Object.assign(sample, assertBacklogSample(maps, events(), sample, checkpoint));
    if (kind === 'export') assert.ok(sample.startMs <= limits.exportStartMs, 'Foreground export start exceeded its frozen ceiling');
    else assert.ok(sample.answerMs <= limits.checkAnswerMs, 'Foreground check exceeded its frozen ceiling');
  }
  assert.ok(!restart || restarted, 'The mixed workload never restarted');
}

/** Independent event oracle. Missing, duplicate and out-of-order publication
 * must fail even when every listing eventually says current. */
export function capacityEvents(maps, events, complete = true) {
  const pending = maps.filter(map => map.group !== 'current');
  const ids = new Set(maps.map(map => map.id));
  const published = events.filter(event => event.kind === 'published' && ids.has(event.mapId));
  const seen = new Set();
  const ordered = group => maps.filter(map => map.group === group).sort((a, b) => b.drawingChangedAt - a.drawingChangedAt || a.id.localeCompare(b.id));
  for (const map of pending) assert.ok(Number.isFinite(map.drawingChangedAt), 'The fixture must record drawing recency');
  const cohorts = { missing: ordered('missing'), old: ordered('old') };
  for (const event of published) {
    const map = maps.find(map => map.id === event.mapId);
    assert.notEqual(map.group, 'current', 'An already-current map was rendered again');
    assert.ok(!seen.has(event.mapId), 'A picture was remade twice across restart');
    if (map.group === 'old') assert.ok(maps.filter(map => map.group === 'missing').every(map => seen.has(map.id)), 'Old-road work overtook a missing picture');
    assert.equal(event.mapId, cohorts[map.group].find(candidate => !seen.has(candidate.id))?.id, `Recency order was violated within the ${map.group} cohort`);
    seen.add(event.mapId);
  }
  if (complete) assert.equal(seen.size, pending.length, 'A pending picture was never published');
  return published;
}

export function firstMeasurement(maps, events) {
  assert.equal(maps.length, 20);
  const published = capacityEvents(maps, events);
  const appearances = [];
  const attempts = published.map(event => {
    const map = maps.find(map => map.id === event.mapId);
    const starts = events.filter(start => start.kind === 'admitted' && start.background && start.mapId === event.mapId);
    assert.equal(starts.length, map.pair ? 2 : 1, 'A missing or repeated appearance invalidates the baseline');
    assert.equal(starts[0].pid, event.pid, 'An interrupted attempt cannot be a timing baseline');
    for (const start of starts) {
      const release = events.slice(events.indexOf(start) + 1).find(end => end.kind === 'released' && end.background && end.mapId === start.mapId && end.pid === start.pid);
      assert.ok(release, 'A picture slot release was not measured');
      const duration = release.monotonicMs - start.monotonicMs;
      assert.ok(duration > 0);
      appearances.push(duration);
    }
    const elapsedMs = event.monotonicMs - starts[0].monotonicMs;
    assert.ok(elapsedMs > 0);
    return { mapId: map.id, pair: map.pair, elapsedMs };
  });
  const describe = rows => ({ count: rows.length, medianMs: percentile(rows.map(row => row.elapsedMs), .5), p90Ms: percentile(rows.map(row => row.elapsedMs), .9) });
  assert.equal(attempts.filter(row => row.pair).length, 10);
  return { attempts, appearanceFloorMs: Math.min(...appearances), all: describe(attempts), single: describe(attempts.filter(row => !row.pair)), pair: describe(attempts.filter(row => row.pair)) };
}

/** An admission observed before calling a restart is insufficient: it must
 * still hold its slot when that process disappears, then resume on the new
 * process and publish exactly once. A graceful drain is a failing control. */
export function assertRestartInterrupted(sample, events, complete = true) {
  const admission = events[sample.admissionIndex];
  assert.ok(admission?.kind === 'admitted' && admission.background && sample.admissionIndex < sample.eventOffset, 'Restart requires a background admission');
  assert.ok(activeRenders(events, sample.eventOffset).some(event => event.index === sample.admissionIndex), 'Restart caught no render in flight');
  const boot = events.findIndex((event, index) => index >= sample.eventOffset && event.kind === 'boot' && event.pid !== admission.pid);
  assert.ok(boot >= 0, 'Restart did not boot a different process');
  const interrupted = events.slice(sample.admissionIndex + 1, boot);
  assert.ok(!interrupted.some(event => event.pid === admission.pid && event.mapId === admission.mapId &&
    (event.kind === 'published' || event.kind === 'released' && event.background)), 'Background render finished before restart');
  if (complete) {
    const resumed = events.findIndex((event, index) => index > boot && event.kind === 'admitted' && event.background && event.mapId === admission.mapId && event.pid === events[boot].pid);
    assert.ok(resumed > boot, 'Interrupted work was never resumed');
    const publications = events.filter(event => event.kind === 'published' && event.mapId === admission.mapId);
    assert.equal(publications.length, 1, 'Interrupted work must publish exactly once');
    assert.ok(events.indexOf(publications[0]) > resumed && publications[0].pid === events[boot].pid, 'Interrupted work did not publish on the replacement process');
  }
  return { mapId: admission.mapId, oldPid: admission.pid, newPid: events[boot].pid, admissionIndex: sample.admissionIndex, bootIndex: boot };
}
