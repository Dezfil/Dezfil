// Owns every process/container and store used by the cleanup/restart proof.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const image = option('--container'), standalone = option('--standalone'), port = Number(option('--port') ?? 3398);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = process.env.DEZFIL_DATA_DIR, started = Date.now(), report = [];
let child, childExit, serverLog = '', current, volume;
const names = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
async function stop() {
  if (image && current) { docker('stop', current); current = undefined; }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const ended = await Promise.race([childExit.then(() => true), delay(10_000).then(() => false)]);
    if (!ended) { child.kill('SIGKILL'); await childExit; }
  }
}
async function ready(base) {
  for (let i = 0; i < 120; i++) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('Standalone exited before readiness');
    try {
      if (image) docker('exec', current, 'node', '-e', `fetch('${base}/api/health',{signal:AbortSignal.timeout(500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`);
      else if (!(await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) throw new Error('unready');
      return;
    } catch { await delay(250); }
  }
  throw new Error('Cleanup probe readiness exceeded thirty seconds');
}
try {
  assert.ok(Boolean(image) !== Boolean(standalone), 'Choose --standalone BUILD_DIR or --container IMAGE');
  assert.ok(Number.isInteger(port) && port >= 3300 && port <= 65535, 'Use an owned port from 3300 to 65535');
  assert.ok(directory && path.isAbsolute(directory), 'DEZFIL_DATA_DIR must be an absolute fresh scratch directory');
  await mkdir(directory, { recursive: true }); assert.deepEqual(await readdir(directory), [], 'Scratch directory must be empty');
  const base = `http://127.0.0.1:${port}`, env = { ...process.env, DEZFIL_DATA_DIR: directory, DEZFIL_TRUSTED_PROXIES: '', PORT: String(port), HOSTNAME: '127.0.0.1' };
  if (image) { volume = `dezfil-cleanup-${process.pid}-${Date.now()}`; docker('volume', 'create', volume); }
  else { await access(path.join(standalone, 'server.js')); await access(path.join(standalone, 'scripts/ingress-preload.mjs')); }
  const identities = [];
  for (const [index, mode] of ['prepare', 'sweep', 'restart'].entries()) {
    if (image) {
      current = `${volume}-${index}`; names.push(current);
      docker('run', '-d', '--name', current, '--network=none', '-e', `PORT=${port}`, '-e', 'DEZFIL_DATA_DIR=/data', '-e', 'DEZFIL_TRUSTED_PROXIES=',
        '-v', `${root}/scripts:/probes:ro`, '-v', `${volume}:/data`, image);
      identities.push(docker('inspect', '--format', '{{.Id}}', current).trim());
    } else {
      child = spawn(process.execPath, ['--import=./scripts/ingress-preload.mjs', 'server.js'], { cwd: standalone, env, stdio: ['ignore', 'pipe', 'pipe'] });
      childExit = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      void childExit.catch(() => {});
      child.stdout.on('data', bytes => { serverLog += bytes; }); child.stderr.on('data', bytes => { serverLog += bytes; });
      identities.push(child.pid);
    }
    await ready(base);
    const output = image ? docker('exec', current, 'node', '/probes/credential-cleanup-probe.mjs', mode, base)
      : execFileSync(process.execPath, [path.join(root, 'scripts/credential-cleanup-probe.mjs'), mode, base], { cwd: standalone, env, encoding: 'utf8', timeout: 120_000 });
    const result = JSON.parse(output.trim().split('\n').at(-1)); assert.equal(result.label, 'confirmed'); report.push(result);
    if (image) serverLog += docker('logs', current);
    await stop();
  }
  assert.equal(new Set(identities).size, 3, 'each launch must use a replacement process/container');
  const result = { label: 'confirmed', mode: image ? 'container' : 'standalone', launches: 3, checks: report.reduce((sum, row) => sum + row.checks, 0), elapsedSeconds: (Date.now() - started) / 1000, report };
  await writeFile(path.join(directory, 'cleanup-evidence.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ label: 'failed', message: error.message })); process.exitCode = 1;
} finally {
  try { await stop(); } catch (error) { console.error(error.message); process.exitCode = 1; }
  for (const name of names) { try { serverLog += docker('logs', name); docker('rm', '-f', name); } catch { process.exitCode = 1; } }
  if (volume) { try { docker('volume', 'rm', volume); } catch { process.exitCode = 1; } }
  if (directory) await writeFile(path.join(directory, 'cleanup-server.log'), serverLog);
}
