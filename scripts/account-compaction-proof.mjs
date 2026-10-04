// Run outside the implementing sandbox. Owns only fresh scratch stores,
// proof processes, containers and volumes; no product endpoint is added.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, statfsSync, writeFileSync, openSync, writeSync, closeSync, unlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sampleCompaction, runProofArms } from './account-compaction-prober.mjs';
import { sizedFixture } from './account-compaction-fixture.mjs';

const { values } = parseArgs({ options: {
  container: { type: 'string' }, port: { type: 'string', default: '3394' }, seed: { type: 'string' },
  'container-only': { type: 'boolean' }, inside: { type: 'boolean' }, space: { type: 'boolean' },
} });
const started = performance.now();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = process.env.DEZFIL_DATA_DIR, port = Number(values.port), reports = [];
assert.ok(directory && path.isAbsolute(directory), 'DEZFIL_DATA_DIR must name a fresh absolute scratch directory');
mkdirSync(directory, { recursive: true }); assert.deepEqual(readdirSync(directory), [], 'scratch must be empty');
assert.ok(Number.isInteger(port) && port >= 3300 && port <= 65535);
assert.ok(!values['container-only'] || values.container, '--container-only requires --container IMAGE');
assert.ok(!values.seed || ['row-only', 'former-missing', 'busy-success', 'space-success', 'pause'].includes(values.seed), 'known seed');
const temporary = values.inside ? '/sqlite-vacuum-tmp' : path.join(directory, 'sqlite-temporary');
mkdirSync(temporary, { recursive: true });
const base = `http://127.0.0.1:${port}`, boundMs = 5000;
let child, ended, output = '', ready, volume, containerName;
const breaches = [];
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true; process.exitCode = 1;
  void stop().finally(() => {
    if (containerName) { try { docker('rm', '-f', containerName); } catch {} }
    if (volume) { try { docker('volume', 'rm', volume); } catch {} }
  });
});
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const free = folder => { const s = statfsSync(folder); return Number(s.bavail) * Number(s.bsize); };
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    if (!await Promise.race([ended.then(() => true), delay(5000).then(() => false)])) { child.kill('SIGKILL'); await ended; }
  }
  child = undefined;
}
async function start(mode, folder, seed = values.seed) {
  await stop();
  if (interrupted) throw new Error('Proof interrupted');
  child = spawn(process.execPath, [path.join(root, 'scripts/account-compaction-worker.mjs'), mode, folder, String(port), seed ?? ''], {
    cwd: root, env: { ...process.env, DEZFIL_DATA_DIR: folder, SQLITE_TMPDIR: temporary }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  ended = once(child, 'exit');
  child.stderr.on('data', bytes => { output += bytes; });
  const lines = createInterface({ input: child.stdout });
  ready = await Promise.race([
    new Promise(resolve => lines.on('line', line => { output += line + '\n'; try { const row = JSON.parse(line); if (row.ready) resolve(row); } catch {} })),
    ended.then(() => { throw new Error(`Proof worker exited before readiness: ${output.slice(-3000)}`); }),
    delay(30000).then(() => { throw new Error('Proof worker readiness timeout'); }),
  ]);
  assert.equal((await request('/health')).healthy, true);
}
async function request(route, timeout = 30000) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(timeout) });
  assert.equal(response.status, 200); return response.json();
}
async function measure(folder, observeTemporary = false) {
  const initial = { data: free(folder), temporary: free(temporary) }, minimum = { ...initial };
  let observedTemporary = false, temporaryFileBytes = 0;
  function spaceSample() {
    for (const [key, location] of [['data', folder], ['temporary', temporary]]) minimum[key] = Math.min(minimum[key], free(location));
    if (observeTemporary) {
      try {
        for (const fd of readdirSync(`/proc/${child.pid}/fd`)) {
          const file = `/proc/${child.pid}/fd/${fd}`;
          try {
            if (readlinkSync(file).startsWith(`${temporary}/etilqs_`)) {
              observedTemporary = true; temporaryFileBytes = Math.max(temporaryFileBytes, statSync(file).size);
            }
          } catch { /* A temporary file can close between enumeration and stat. */ }
        }
      } catch { /* The child may exit while a sample is pending. */ }
    }
  }
  const measured = await sampleCompaction({
    health: () => request('/health', 500), sampleSpace: spaceSample,
    spaceInterval: observeTemporary ? 2 : 100,
    // IPC is already connected before maintenance starts. Health connections
    // may time out without losing the one compaction result or retrying VACUUM.
    compact: () => new Promise((resolve, reject) => {
      const worker = child;
      const timeout = setTimeout(() => finish(new Error('Compaction worker did not settle within 10 minutes')), 600000);
      const onExit = () => finish(new Error('Compaction worker exited during measurement'));
      const onMessage = message => { if (message.compaction) finish(null, message.compaction); };
      function finish(error, result) {
        clearTimeout(timeout); worker.off('exit', onExit); worker.off('message', onMessage);
        if (error) reject(error); else resolve(result);
      }
      worker.once('exit', onExit); worker.on('message', onMessage);
      worker.send({ compact: true }, error => { if (error) finish(error); });
    }),
  });
  return { ...measured, initialFreeBytes: initial,
    peakSpaceUseBytes: { data: initial.data - minimum.data, temporary: initial.temporary - minimum.temporary },
    observedTemporary, temporaryFileBytes };
}
function record(report) { reports.push(report); console.log(JSON.stringify(report)); }
async function byteProof() {
  for (const busy of [false, true]) {
    const folder = path.join(directory, busy ? 'busy-reader' : 'live-bytes');
    await start('bytes', folder, values.seed === 'pause' ? '' : values.seed);
    if (busy) await request('/hold');
    const erased = await request('/erase'); assert.ok(erased.target.length > 0, 'row-only erasure leaves live bytes');
    const first = await measure(folder);
    if (busy) {
      assert.equal(first.result.ok, false, 'busy reader must leave compaction unfinished');
      assert.ok(first.pauseMs < 1500, 'busy-reader waits are bounded');
      assert.ok((await request('/scan')).target.length > 0, 'busy checkpoint retains bytes');
      await request('/release');
      const retry = await measure(folder); assert.equal(retry.result.ok, true, JSON.stringify(retry));
    } else assert.equal(first.result.ok, true, JSON.stringify(first));
    assert.deepEqual(await request('/scan'), { target: [], control: ready.control }, 'every live file is scanned before closing the store');
    assert.equal(statSync(path.join(folder, 'metadata.sqlite-wal')).size, 0);
    record({ confirmed: busy ? 'busy-reader refusal and same-open-store retry' : 'current and former live bytes removed; controls retained', ...first });
    await stop();
  }
}
async function sizes() {
  for (const mib of [64, 256, 1024]) {
    const baselineDir = path.join(directory, `baseline-${mib}`), fixture = sizedFixture(baselineDir, mib);
    for (let trial = 1; trial <= 3; trial++) {
      const folder = path.join(directory, `size-${mib}-${trial}`); mkdirSync(folder);
      copyFileSync(fixture.file, path.join(folder, 'metadata.sqlite'));
      await start('size', folder, values.seed === 'pause' ? 'pause' : '');
      const measured = await measure(folder);
      assert.equal(measured.result.ok, true, JSON.stringify(measured));
      assert.equal(measured.result.open, true); assert.equal((await request('/integrity')).integrity, 'ok');
      const row = { mode: values.inside ? 'container' : 'host', mib, trial, ...fixture, ...measured };
      record(row);
      if (measured.pauseMs > boundMs) {
        const breach = `DECISION REQUIRED: ${mib} MiB trial ${trial} pause ${(measured.pauseMs / 1000).toFixed(3)} s exceeds 5.0 s; do not ship around this breach`;
        breaches.push(breach); console.error(breach);
      }
      await stop(); rmSync(folder, { recursive: true });
    }
    rmSync(baselineDir, { recursive: true });
  }
}
async function exhaustion() {
  assert.equal(process.platform, 'linux');
  const mount = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').find(line => line.includes(' /sqlite-vacuum-tmp ') && line.includes(' - tmpfs '));
  assert.ok(mount, 'dedicated capacity-limited temporary tmpfs must be mounted');
  assert.notEqual(statSync(directory).dev, statSync(temporary).dev, 'data and temp filesystems must be separate');
  assert.ok(free(directory) > 512 * 1024 * 1024, 'data volume has ample space');
  const folder = path.join(directory, 'exhaustion'); sizedFixture(folder, 64);
  const filler = path.join(temporary, 'proof-capacity-fill'), fd = openSync(filler, 'wx');
  try { const block = Buffer.alloc(1024 * 1024, 7); while (free(temporary) > 32 * 1024 * 1024) writeSync(fd, block); }
  finally { closeSync(fd); }
  try {
    await start('size', folder);
    const failed = await measure(folder, true); record({ confirmed: 'real temporary filesystem exhaustion observed', mount, ...failed });
    assert.equal(failed.result.ok, false, 'temporary exhaustion must leave erasure unfinished');
    assert.equal(failed.result.code, 'SQLITE_FULL', JSON.stringify(failed.result));
    assert.equal(failed.observedTemporary, true, 'observe SQLite etilqs file on the selected mount, not a simulated space error');
    assert.ok(failed.temporaryFileBytes > 0);
    unlinkSync(filler);
    const retry = await measure(folder, true); record({ confirmed: 'same-open-store retry after releasing temporary space', ...retry });
    assert.equal(retry.result.ok, true, JSON.stringify(retry)); assert.equal((await request('/integrity')).integrity, 'ok');
    assert.equal(statSync(path.join(folder, 'metadata.sqlite-wal')).size, 0);
  } finally { if (readdirSync(temporary).includes(path.basename(filler))) unlinkSync(filler); await stop(); }
}
async function containerRun(space) {
  volume = `dezfil-compaction-${process.pid}-${Date.now()}`; docker('volume', 'create', volume);
  try {
    containerName = `${volume}-worker`;
    const args = ['run', '--name', containerName, '--rm', '--network=none', '--mount', `type=volume,src=${volume},dst=/data`,
      '--mount', `type=bind,src=${root}/scripts,dst=/app/scripts,readonly`, '--mount', `type=bind,src=${root}/src,dst=/app/src,readonly`,
      '--tmpfs', `/sqlite-vacuum-tmp:rw,size=${space ? '64m' : '2g'},mode=1777`,
      '-e', 'DEZFIL_DATA_DIR=/data/proof', '-e', 'SQLITE_TMPDIR=/sqlite-vacuum-tmp', '-e', `COMPACTION_CANDIDATE=${process.env.COMPACTION_CANDIDATE ?? ''}`,
      values.container, 'node', 'scripts/account-compaction-proof.mjs', '--inside', '--port', String(port),
      ...(space ? ['--space'] : []), ...(values.seed ? ['--seed', values.seed] : [])];
    const processRun = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; processRun.stdout.on('data', b => { log += b; process.stdout.write(b); }); processRun.stderr.on('data', b => { log += b; process.stderr.write(b); });
    const [code] = await once(processRun, 'exit');
    writeFileSync(path.join(directory, space ? 'container-space.log' : 'container-measurements.log'), log);
    assert.equal(code, 0, `container ${space ? 'temporary exhaustion' : 'measurement'} proof failed`);
  } finally {
    try { docker('rm', '-f', containerName); } catch {}
    containerName = undefined; docker('volume', 'rm', volume); volume = undefined;
  }
}
try {
  record({ environment: { candidate: process.env.COMPACTION_CANDIDATE ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    platform: process.platform, release: os.release(), arch: process.arch, cpu: os.cpus()[0]?.model, cpus: os.cpus().length,
    node: process.version, data: directory, temporary, dataFilesystem: statfsSync(directory), temporaryFilesystem: statfsSync(temporary),
    image: values.container ? docker('image', 'inspect', '--format', '{{.Id}}', values.container).trim() : null } });
  const arms = [];
  if (values.space) arms.push(exhaustion);
  else if (values.seed !== 'space-success' && !values['container-only']) arms.push(async () => { await byteProof(); await sizes(); });
  else assert.ok(values.container, 'space-success requires --container IMAGE');
  if (values.container) {
    process.env.COMPACTION_CANDIDATE = reports[0].environment.candidate;
    if (values.seed !== 'space-success') arms.push(() => containerRun(false));
    arms.push(() => containerRun(true));
  }
  const failures = await runProofArms(arms, stop);
  if (breaches.length || failures.length || interrupted) throw new Error([
    ...breaches, ...failures.map(error => error.message), ...(interrupted ? ['Proof interrupted'] : []),
  ].join('\n'));
  console.log(`PASS: all requested live-byte, reader, pause and temporary-space checks in ${((performance.now() - started) / 1000).toFixed(1)} s. Unrequested container arms remain unobserved.`);
} catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
finally { await stop(); writeFileSync(path.join(directory, 'compaction-report.json'), JSON.stringify(reports, null, 2)); writeFileSync(path.join(directory, 'worker.log'), output); }
