// Host-side owner. Only the named image is needed; no published host ports.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { assessArm, readRows } from './render-egress-assert.mjs';
import { gateArms, matrixArms, timingArms } from './render-egress-cases.mjs';
import { assessMatrixArm, assessTimingArm, timingSummary } from './render-style-assert.mjs';

const execute = promisify(execFile);
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const image = option('--image'), variant = option('--victim') ?? 'both';
const suite = option('--suite') ?? 'gate';
const scripts = path.dirname(fileURLToPath(import.meta.url));
const directory = process.env.DEZFIL_DATA_DIR;
const prefix = `dezfil-egress-${process.pid}-${randomBytes(4).toString('hex')}`;
const names = ['app', 'dns', 'host', 'listener'].map(role => `${prefix}-${role}`);
const networks = [`${prefix}-public`, `${prefix}-private`];
const report = [], started = Date.now();
let stopping = false, interrupted = false, ownsDirectory = false;
const children = new Set();
async function docker(...args) {
  const pending = execute('docker', args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  children.add(pending.child);
  try {
    const result = await pending;
    return (result.stdout + (args[0] === 'logs' ? result.stderr : '')).trim();
  } finally { children.delete(pending.child); }
}
async function removeContainers() {
  for (const name of names) {
    try { await docker('rm', '-fv', name); }
    catch (error) { if (!/No such container/.test(error.stderr ?? '')) throw error; }
  }
}
async function cleanup() {
  if (stopping) return; stopping = true;
  const failures = [];
  // Attempt every owned name even if one removal fails. Never prune by label
  // or prefix: another process's resources cannot enter this list.
  for (const name of names) {
    try { await docker('rm', '-fv', name); }
    catch (error) { if (!/No such container/.test(error.stderr ?? '')) failures.push(error.message); }
  }
  for (const name of [...networks].reverse()) {
    try { await docker('network', 'rm', name); }
    catch (error) { if (!/not found|No such network/.test(error.stderr ?? '')) failures.push(error.message); }
  }
  for (const message of failures) console.error(`FAIL cleanup ${message}`);
  if (failures.length) process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true; process.exitCode = 1;
  for (const child of children) child.kill('SIGTERM');
});
async function ready(name, url) {
  for (let i = 0; i < 120; i++) {
    if (interrupted) throw new Error('interrupted');
    try {
      await docker('exec', name, 'node', '-e', `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`);
      return;
    } catch { await delay(250); }
  }
  throw new Error(`${name} readiness timed out`);
}
try {
  assert.ok(image, 'Usage: DEZFIL_DATA_DIR=<fresh scratch> node scripts/render-egress-driver.mjs --image IMAGE [--victim both|style|blind]');
  assert.ok(['both', 'style', 'blind'].includes(variant), 'invalid victim variant');
  assert.ok(['gate', 'matrix', 'dependencies', 'controls', 'timing'].includes(suite), 'invalid suite');
  assert.ok(directory && path.isAbsolute(directory), 'DEZFIL_DATA_DIR must name an absolute empty scratch directory');
  assert.deepEqual(await readdir(directory), [], 'scratch directory must be empty');
  ownsDirectory = true;
  const inventory = { prefix, suite, image, imageId: await docker('image', 'inspect', '--format', '{{.Id}}', image), names, networks, hostPorts: [], started,
    timingResources: suite === 'timing' ? { cpus: 2, memory: '4g', cache: 'disabled', freshBrowser: true } : null };
  await writeFile(path.join(directory, 'inventory.json'), JSON.stringify(inventory, null, 2));
  const arms = suite === 'gate' ? gateArms(variant) : suite === 'timing' ? timingArms()
    : matrixArms().filter(arm => suite === 'matrix' || (suite === 'dependencies' ? arm.kind === 'dependency' : arm.kind !== 'dependency'));
  for (const arm of arms) {
    if (interrupted) throw new Error('interrupted');
    const { id } = arm;
    const output = path.join(directory, id);
    await mkdir(output); await chmod(output, 0o777);
    await writeFile(path.join(output, 'active.json'), JSON.stringify(arm));
    // Override the image's declared volume for helpers too: no anonymous
    // data volume may outlive an owned container.
    const mount = ['--tmpfs', '/data:uid=1000,gid=1000,mode=700',
      '-v', `${scripts}:/probes:ro`, '-v', `${output}:/evidence`, '-e', 'PROBE_EVIDENCE=/evidence'];
    try {
      await docker('network', 'create', '--internal', '--subnet', '203.0.113.0/24', networks[0]);
      await docker('network', 'create', '--internal', '--subnet', arm.privateSubnet ?? '192.168.99.0/24',
        ...(arm.ipv6 ? ['--ipv6', '--subnet', 'fd00:deaf:beef::/64'] : []), networks[1]);
      await docker('run', '-d', '--name', names[1], '--network', networks[0], '--ip', '203.0.113.2', '--user', '0:0',
        ...mount, '--entrypoint', 'node', image, '/probes/render-egress-dns.mjs');
      for (const [role, index, network, ip] of [['host', 2, networks[0], '203.0.113.10'], ['listener', 3, networks[1], arm.privateIp ?? '192.168.99.10']]) {
        await docker('run', '-d', '--name', names[index], '--network', network, '--ip', ip,
          ...(arm.ipv6 && role === 'listener' ? ['--ip6', 'fd00:deaf:beef::10'] : []), ...mount,
          '-e', `PROBE_ROLE=${role}`, '--entrypoint', 'node', image, '/probes/render-egress-host.mjs');
      }
      await ready(names[2], 'http://127.0.0.1:8080/live'); await ready(names[3], 'http://127.0.0.1:8080/live');
      assert.ok(readRows(await readFile(path.join(output, 'dns.ndjson'), 'utf8')).some(row => row.event === 'ready'), 'DNS did not start');
      await docker('run', '-d', '--name', names[0], '--network', networks[0], '--dns', '203.0.113.2', ...mount,
        '-e', 'DEZFIL_DATA_DIR=/data', '-e', 'PORT=3187',
        ...(suite === 'timing' ? ['--cpus', '2', '--memory', '4g'] : []),
        '-e', `DEZFIL_EGRESS_ALLOWLIST=${arm.allowlist ?? ''}`, '-e', 'NODE_OPTIONS=--import=/probes/render-egress-observer.mjs', image);
      await docker('network', 'connect', networks[1], names[0]);
      await ready(names[0], 'http://127.0.0.1:3187/api/health');
      if (arm.local) {
        await docker('exec', '-d', '-e', 'PROBE_ROLE=local', names[0], 'node', '/probes/render-egress-host.mjs');
        await ready(names[0], 'http://127.0.0.1:3188/live');
      }
      try { await docker('exec', names[0], 'node', '/probes/render-egress-probe.mjs'); }
      catch (error) { console.error(`FAIL ${id} probe-execution ${error.message}`); process.exitCode = 1; }
      const evidence = {};
      for (const file of ['dns', 'host', 'listener', 'browser']) evidence[file] = readRows(await readFile(path.join(output, `${file}.ndjson`), 'utf8'));
      if (arm.local) evidence.local = readRows(await readFile(path.join(output, 'local.ndjson'), 'utf8'));
      evidence.netlog = JSON.parse(await readFile(path.join(output, 'netlog.json'), 'utf8'));
      evidence.result = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
      const checks = suite === 'gate' ? assessArm(arm, evidence) : suite === 'timing' ? assessTimingArm(arm, evidence) : assessMatrixArm(arm, evidence);
      for (const row of checks) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${id} ${row.name}${row.ok ? '' : ` ${row.message.replaceAll('\n', ' ')}`}`);
      report.push({ arm, checks, result: evidence.result });
      if (checks.some(row => !row.ok)) process.exitCode = 1;
    } catch (error) {
      console.error(`FAIL ${id} missing-or-invalid-evidence ${error.message}`);
      report.push({ arm, failure: error.stack }); process.exitCode = 1;
    } finally {
      for (const name of names) {
        try { await writeFile(path.join(output, `${name.slice(prefix.length + 1)}.log`), await docker('logs', name)); }
        catch { /* failed creation has no log; the assertion above already fails */ }
      }
      await removeContainers();
      for (const network of [...networks].reverse()) {
        try { await docker('network', 'rm', network); }
        catch (error) { if (!/not found|No such network/.test(error.stderr ?? '')) throw error; }
      }
    }
  }
} catch (error) { console.error(`FAIL driver ${error.message}`); process.exitCode = 1; }
finally {
  await cleanup();
  const timing = suite === 'timing' ? timingSummary(report) : undefined;
  if (timing && !timing.valid) process.exitCode = 1;
  if (ownsDirectory) await writeFile(path.join(directory, 'report.json'), JSON.stringify({ elapsedSeconds: (Date.now() - started) / 1000, timing, report }, null, 2));
  console.log(`Evidence: ${directory}; elapsed ${(Date.now() - started) / 1000}s; exit ${process.exitCode ?? 0}`);
}
