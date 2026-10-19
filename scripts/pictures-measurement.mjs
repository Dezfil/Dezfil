import assert from 'node:assert/strict';

export function percentile(values, fraction) {
  assert.ok(values.length, 'Missing timing samples');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Independent event oracle. Missing, duplicate and out-of-order publication
 * must fail even when every listing eventually says current. */
export function capacityEvents(maps, events, complete = true) {
  const pending = maps.filter(map => map.group !== 'current');
  const ids = new Set(maps.map(map => map.id));
  const published = events.filter(event => event.kind === 'published' && ids.has(event.mapId));
  const seen = new Set();
  for (const event of published) {
    const map = maps.find(map => map.id === event.mapId);
    assert.notEqual(map.group, 'current', 'An already-current map was rendered again');
    assert.ok(!seen.has(event.mapId), 'A picture was remade twice across restart');
    if (map.group === 'old') assert.ok(maps.filter(map => map.group === 'missing').every(map => seen.has(map.id)), 'Old-road work overtook a missing picture');
    seen.add(event.mapId);
  }
  if (complete) assert.equal(seen.size, pending.length, 'A pending picture was never published');
  return published;
}

export function firstMeasurement(maps, events) {
  assert.equal(maps.length, 20);
  const published = capacityEvents(maps, events);
  const attempts = published.map(event => {
    const map = maps.find(map => map.id === event.mapId);
    const starts = events.filter(start => start.kind === 'admitted' && start.background && start.mapId === event.mapId);
    assert.equal(starts.length, map.pair ? 2 : 1, 'A missing or repeated appearance invalidates the baseline');
    assert.equal(starts[0].pid, event.pid, 'An interrupted attempt cannot be a timing baseline');
    const elapsedMs = event.monotonicMs - starts[0].monotonicMs;
    assert.ok(elapsedMs > 0);
    return { mapId: map.id, pair: map.pair, elapsedMs };
  });
  const describe = rows => ({ count: rows.length, medianMs: percentile(rows.map(row => row.elapsedMs), .5), p90Ms: percentile(rows.map(row => row.elapsedMs), .9) });
  assert.equal(attempts.filter(row => row.pair).length, 10);
  return { attempts, all: describe(attempts), single: describe(attempts.filter(row => !row.pair)), pair: describe(attempts.filter(row => row.pair)) };
}
