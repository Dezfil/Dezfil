import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Event cursors bracket the HTTP byte read. A publication overlapping a
 * read may yield either complete picture; it may never yield missing bytes. */
export function assertOldPictureRead(map, sample, events) {
  assert.match(map.oldPictureSha256 ?? '', /^[a-f0-9]{64}$/, 'Missing seeded picture digest');
  assert.ok(Number.isInteger(sample.startOffset) && sample.startOffset >= 0 &&
    sample.endOffset >= sample.startOffset && sample.endOffset <= events.length, 'Missing byte-read event cursors');
  assert.equal(sample.status, 200, 'An old picture stopped being served');
  assert.ok(sample.bytes > 0, 'An old picture answered empty bytes');
  assert.match(sample.sha256 ?? '', /^[a-f0-9]{64}$/, 'A served picture was not hashed');
  const publication = events.findIndex(event => event.kind === 'published' && event.mapId === map.id);
  if (publication < 0 || publication >= sample.endOffset) {
    assert.equal(sample.sha256, map.oldPictureSha256, 'Old picture bytes changed before publication');
    return 'old';
  }
  if (publication < sample.startOffset) {
    assert.notEqual(sample.sha256, map.oldPictureSha256, 'Old picture bytes survived their replacement');
    return 'new';
  }
  return 'overlap';
}

export function assertOldPictureCoverage(maps, reads, events) {
  for (const map of maps.filter(map => map.group === 'old')) for (const theme of ['light', 'dark']) {
    const samples = reads.filter(read => read.mapId === map.id && read.theme === theme);
    const classified = samples.map(sample => ({ ...sample, phase: assertOldPictureRead(map, sample, events) }));
    assert.ok(classified.some(sample => sample.phase === 'old'), `Never read the old ${theme} picture of ${map.id} before publication`);
    const replacement = classified.find(sample => sample.phase === 'new');
    assert.ok(replacement, `Never read the replacement ${theme} picture of ${map.id}`);
    for (const sample of classified) if (sample.phase !== 'old') {
      assert.ok(sample.sha256 === replacement.sha256 || sample.phase === 'overlap' && sample.sha256 === map.oldPictureSha256,
        'Publication-overlap read returned neither complete picture');
    }
  }
}

/** Four HTTP readers repeatedly inspect every unreplaced old-road map in
 * both themes. Pause drains reads before intentional server downtime. All
 * failures stay recorded and are rethrown by the foreground harness. */
export function oldPictureMonitor({ maps, events, read, record, intervalMs = 1000 }) {
  const pending = maps.filter(map => map.group === 'old').flatMap(map => ['light', 'dark'].map(theme => ({ map, theme })));
  const done = new Set();
  let stopped = false, paused = false, active = null, loop = null, failure;
  async function sweep() {
    let cursor = 0;
    const results = await Promise.allSettled(Array.from({ length: 4 }, async () => {
      for (;;) {
        const entry = pending[cursor++];
        if (!entry) return;
        const { map, theme } = entry, key = `${map.id}:${theme}`;
        if (done.has(key)) continue;
        const sample = { mapId: map.id, theme, startOffset: events().length, requestedAt: Date.now() };
        try {
          const response = await read(map.id, theme);
          sample.status = response.status;
          const bytes = new Uint8Array(await response.arrayBuffer());
          sample.bytes = bytes.length;
          sample.sha256 = createHash('sha256').update(bytes).digest('hex');
          sample.answeredAt = Date.now(); sample.endOffset = events().length;
          sample.phase = assertOldPictureRead(map, sample, events());
          if (sample.phase === 'new') done.add(key);
        } catch (error) { sample.error = error.message; throw error; }
        finally { record(sample); }
      }
    }));
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
  const check = () => { if (failure) throw failure; };
  async function once() {
    check(); active = sweep();
    try { await active; } finally { active = null; }
  }
  return {
    async start() {
      await once();
      loop = (async () => {
        while (!stopped && done.size < pending.length) {
          await sleep(intervalMs);
          if (!stopped && !paused) await once();
        }
      })().catch(error => { failure = error; });
    },
    async pause() { paused = true; await active; check(); },
    resume() { paused = false; },
    check,
    async finish() {
      stopped = true; await loop; check();
      await once();
      assert.equal(done.size, pending.length, 'Some old-road replacements were never read');
    },
    async stop() { stopped = true; await loop; check(); },
  };
}
