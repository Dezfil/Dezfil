import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MB, boundedVolume, fillVolume, noSpace } from './storage-volume-support.mjs';
const refusal = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
test('the filler requires a bounded volume before opening a file', () => {
  for (const total of [512 * MB, 3 * 1024 * MB]) {
    assert.throws(() => boundedVolume('/proof', { statfsSync: () => ({ blocks: total / 4096, bsize: 4096 }) }), /Refusing to fill/);
  }
});
test('the filler allocates blocks, handles short writes and proves a final refusal', () => {
  let remaining = 2 * MB + 4096, closed = false;
  const io = { statfsSync: () => ({ blocks: 1536 * MB / 4096, bsize: 4096, bavail: remaining / 4096 }), openSync: () => 17,
    writeSync: (_fd, _block, _offset, size) => { if (!remaining) throw refusal; const written = Math.min(4096, size, remaining); remaining -= written; return written; }, closeSync: () => { closed = true; } };
  assert.equal(fillVolume('/proof', 'hog', io), 2 * MB + 4096); assert.equal(closed, true);
});
test('negative controls: a reported error without a full volume and a wrong HTTP error both fail', () => {
  const io = { statfsSync: () => ({ blocks: 1536 * MB / 4096, bsize: 4096, bavail: MB / 4096 }), openSync: () => 17, writeSync: () => { throw refusal; }, closeSync() {} };
  assert.throws(() => fillVolume('/proof', 'hog', io), /no writable block left/);
  assert.throws(() => noSpace({ status: 500, json: { error: { code: 'internal' } } }));
  assert.throws(() => noSpace({ status: 507, json: { error: { code: 'internal' } } }));
  noSpace({ status: 507, json: { error: { code: 'storage_exhausted', message: "This instance's storage is full: 0 MB free of 1536 MB. Delete datasets or maps you no longer need, or ask an admin to free space." } } });
});
test('the driver refuses the maintainer port with one failed result and a nonzero exit', () => {
  fs.mkdirSync(path.join(process.cwd(), '.claude/test-data'), { recursive: true });
  const folder = fs.mkdtempSync(path.join(process.cwd(), '.claude/test-data/storage-driver-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/storage-volume-driver.mjs', '--standalone', '.next/standalone', '--port', '3000'], { env: { ...process.env, DEZFIL_DATA_DIR: folder }, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(result.stdout).label, 'failed'); assert.match(JSON.parse(result.stdout).message, /owned port/); assert.deepEqual(fs.readdirSync(folder), []);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('the image job uses the same driver and a bounded writable volume with separate controls', async () => {
  const { containerArguments } = await import('./storage-volume-container.mjs');
  const args = containerArguments({ image: 'dezfil:ci', name: 'proof', root: '/checkout', port: 3409 });
  assert.ok(args.includes('/data:size=1536m,uid=1000,gid=1000,mode=0700'));
  assert.ok(args.includes('/proof:size=64m,uid=1000,gid=1000,mode=0700'));
  assert.ok(args.includes('--network=none')); assert.ok(!args.includes('-p')); assert.ok(!args.includes('--privileged'));
  assert.ok(args.includes('/checkout/scripts:/probes:ro'));
  assert.ok(args.includes('--import=/probes/storage-volume-preload.mjs'));
  const workflow = yaml.load(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
  const step = workflow.jobs.image.steps.find(step => step.name === 'Full-volume admission, fencing and recovery on bounded tmpfs');
  assert.equal(step['timeout-minutes'], 6);
  assert.match(step.run, /node scripts\/storage-volume-driver\.mjs --container dezfil:ci --port 3409/);
});
test('conflicting driver modes fail before invoking Docker', () => {
  const result = spawnSync(process.execPath, ['scripts/storage-volume-driver.mjs', '--container', 'dezfil:ci', '--standalone', '.next/standalone'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).label, 'failed');
  assert.match(JSON.parse(result.stdout).message, /exactly one/);
});
