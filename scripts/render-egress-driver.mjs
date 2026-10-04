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
import { provisionTrust } from './render-tls-trust.mjs';
import { tlsArms, assessTlsArm, tlsReport, supplementaryReport } from './render-tls-assert.mjs';
import { guardedTiles } from './render-comparison-assert.mjs';
import { assessMatrixArm, assessTimingArm, timingSummary } from './render-style-assert.mjs';

const execute = promisify(execFile);
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const image = option('--image'), variant = option('--victim') ?? 'both';
const suite = option('--suite') ?? 'gate';
const index = option('--index'), seed = option('--seed'), candidate = process.argv.includes('--candidate');
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
  assert.ok(['gate', 'matrix', 'dependencies', 'controls', 'timing', 'tls', 'supplementary'].includes(suite), 'invalid suite');
  assert.ok(directory && path.isAbsolute(directory), 'DEZFIL_DATA_DIR must name an absolute empty scratch directory');
  assert.deepEqual(await readdir(directory), [], 'scratch directory must be empty');
  ownsDirectory = true;
  const inventory = { prefix, suite, image, imageId: await docker('image', 'inspect', '--format', '{{.Id}}', image), names, networks, hostPorts: [], started,
    timingResources: suite === 'timing' ? { cpus: 2, memory: '4g', cache: 'disabled', freshBrowser: true } : null };
  await writeFile(path.join(directory, 'inventory.json'), JSON.stringify(inventory, null, 2));
  assert.ok(!seed || ['broken-tunnel', 'certificate-bypass-untrusted', 'certificate-bypass-wrong-host', 'direct-bypass', 'delay', 'supplementary-direct'].includes(seed), 'unknown seed');
  let arms = suite === 'tls' || suite === 'supplementary' ? tlsArms().filter(arm => suite === 'tls' || arm.certificate === 'trusted').map(arm => ({ ...arm, kind: suite })) : suite === 'gate' ? gateArms(variant) : suite === 'timing' ? timingArms()
    : matrixArms().filter(arm => suite === 'matrix' || (suite === 'dependencies' ? arm.kind === 'dependency' : arm.kind !== 'dependency'));
  if (index !== undefined) { assert.ok(/^\d+$/.test(index) && arms[Number(index)], 'invalid arm index'); arms = [arms[Number(index)]]; }
  if (seed) arms = arms.filter(arm => seed === 'broken-tunnel' ? arm.certificate === 'trusted' : seed.startsWith('certificate-bypass-') ? seed === `certificate-bypass-${arm.certificate}` : true);
  assert.ok(arms.length, 'seed has no applicable arm');
  for (const arm of arms) {
    arm.seed = seed; arm.candidate = candidate; arm.delayMs = Number(option('--delay-ms') ?? 10000);
    assert.ok(!seed || (suite === 'timing' && candidate && ['direct-bypass', 'delay'].includes(seed)) || (suite === 'tls' && (seed === 'broken-tunnel' || seed.startsWith('certificate-bypass-'))) || (suite === 'supplementary' && seed === 'supplementary-direct'), 'seed/suite mismatch');
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
      const tls = ['tls', 'supplementary'].includes(suite);
      const trust = tls ? await provisionTrust(path.join(output, 'trust')) : null;
      const trustMount = trust ? ['-v', `${trust}:/trust:ro`] : [];
      await docker('network', 'create', '--internal', '--subnet', '203.0.113.0/24', networks[0]);
      await docker('network', 'create', '--internal', '--subnet', arm.privateSubnet ?? '192.168.99.0/24',
        ...(arm.ipv6 ? ['--ipv6', '--subnet', 'fd00:deaf:beef::/64'] : []), networks[1]);
      await docker('run', '-d', '--name', names[1], '--network', networks[0], '--ip', '203.0.113.2', '--user', '0:0',
        ...mount, '--entrypoint', 'node', image, '/probes/render-egress-dns.mjs');
      for (const [role, index, network, ip] of [['host', 2, networks[0], '203.0.113.10'], ['listener', 3, networks[1], arm.privateIp ?? '192.168.99.10']]) {
        await docker('run', '-d', '--name', names[index], '--network', network, '--ip', ip,
          ...trustMount, ...(arm.ipv6 && role === 'listener' ? ['--ip6', 'fd00:deaf:beef::10'] : []), ...mount,
          '-e', `PROBE_ROLE=${role}`, '--entrypoint', 'node', image, '/probes/render-egress-host.mjs');
      }
      if (tls) {
        await docker('exec', '-d', names[2], 'node', '/probes/render-tls-fixture.mjs');
        let tlsReady = false;
        for (let i = 0; i < 120; i++) {
          try { tlsReady = readRows(await readFile(path.join(output, 'tls.ndjson'), 'utf8')).some(row => row.event === 'ready'); } catch { /* wait for readiness */ }
          if (tlsReady) break; await delay(250);
        }
        assert.ok(tlsReady, 'TLS fixture readiness missing');
      }
      await ready(names[2], 'http://127.0.0.1:8080/live'); await ready(names[3], 'http://127.0.0.1:8080/live');
      assert.ok(readRows(await readFile(path.join(output, 'dns.ndjson'), 'utf8')).some(row => row.event === 'ready'), 'DNS did not start');
      await docker('run', '-d', '--name', names[0], '--network', networks[0], '--dns', '203.0.113.2', ...mount,
        '-e', 'DEZFIL_DATA_DIR=/data', '-e', 'PORT=3187', ...trustMount,
        ...(tls ? ['-v', `${trust}/legacy-nss:/home/node/.pki/nssdb`, '-v', `${trust}/current-nss:/home/node/.local/share/pki/nssdb`, '-e', 'NODE_EXTRA_CA_CERTS=/trust/node-ca.pem'] : []),
        ...(tls || suite === 'timing' ? ['-e', 'PROBE_ROAD=1'] : []),
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
      // Files keep the container user's ownership, and Chromium writes its net log
      // owner-only. On a Linux host the runner's user cannot read them otherwise.
      await docker('exec', '--user', '0:0', names[0], 'chmod', '-R', 'a+rwX', '/evidence');
      const evidence = {};
      for (const file of ['dns', 'host', 'listener', 'browser']) evidence[file] = readRows(await readFile(path.join(output, `${file}.ndjson`), 'utf8'));
      if (arm.local) evidence.local = readRows(await readFile(path.join(output, 'local.ndjson'), 'utf8'));
      evidence.netlog = JSON.parse(await readFile(path.join(output, 'netlog.json'), 'utf8'));
      evidence.result = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
      if (tls || suite === 'timing') evidence.road = readRows(await readFile(path.join(output, 'road.ndjson'), 'utf8'));
      if (tls) evidence.tls = readRows(await readFile(path.join(output, 'tls.ndjson'), 'utf8'));
      const checks = tls ? assessTlsArm(arm, evidence) : suite === 'gate' ? assessArm(arm, evidence) : suite === 'timing' ? assessTimingArm(arm, evidence) : assessMatrixArm(arm, evidence);
      if (suite === 'timing' && candidate) {
        try { evidence.result.guardedTiles = guardedTiles(evidence.browser, evidence.road, evidence.result.tiles?.paths); checks.push({ name: 'guarded-tile-responses', ok: true }); }
        catch (error) { checks.push({ name: 'guarded-tile-responses', ok: false, message: error.message }); }
      }
      if (tls) {
        evidence.result.claims = suite === 'supplementary' ? supplementaryReport(evidence) : [tlsReport(arm, evidence, report)];
        for (const claim of evidence.result.claims) console.log(`REPORT ${claim.claim}: ${claim.label}`);
      }
      for (const row of checks) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${id} ${row.name}${row.ok ? '' : ` ${row.message.replaceAll('\n', ' ')}`}`);
      report.push({ arm, checks, result: evidence.result });
      if (checks.some(row => !row.ok)) process.exitCode = 1;
    } catch (error) {
      console.error(`FAIL ${id} missing-or-invalid-evidence ${error.message}`);
      const claims = suite === 'supplementary' ? supplementaryReport({ browser: [], tls: [], road: [] }).map(row => ({ ...row, reason: error.message }))
        : suite === 'tls' ? [{ claim: arm.certificate, label: 'not run', reason: error.message }] : [];
      for (const claim of claims) console.log(`REPORT ${claim.claim}: ${claim.label}`);
      report.push({ arm, failure: error.stack, claims }); process.exitCode = 1;
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
  const timing = suite === 'timing' && index === undefined ? timingSummary(report) : undefined;
  if (timing && !timing.valid) process.exitCode = 1;
  if (ownsDirectory) await writeFile(path.join(directory, 'report.json'), JSON.stringify({ elapsedSeconds: (Date.now() - started) / 1000, timing, report }, null, 2));
  console.log(`Evidence: ${directory}; elapsed ${(Date.now() - started) / 1000}s; exit ${process.exitCode ?? 0}`);
}
