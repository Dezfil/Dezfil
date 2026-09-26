// Host orchestration; the probe client is separate from the shipped runtime.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { until } from './mcp-probe-wait.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const port = Number(option('--port', '3377'));
assert.ok(port >= 3300 && port <= 65535);
const base = `http://127.0.0.1:${port}`;
const image = option('--container', null);
const clientImage = option('--client-image', 'dezfil-mcp-probe:ci');
const started = Date.now();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 45_000 });
const report = [];
if (image) {
  const suffix = `${process.pid}-${Date.now()}`, volume = `dezfil-mcp-${suffix}`, prefix = `dezfil-mcp-${suffix}`;
  const names = [`${prefix}-1`, `${prefix}-2`];
  const eventFile = '/data/mcp-events.ndjson', seedFile = '/data/mcp-seed.json';
  docker('volume', 'create', volume);
  const boot = async name => {
    docker('run', '-d', '--name', name, '--network=none', '-e', `PORT=${port}`, '-e', 'DEZFIL_DATA_DIR=/data', '-e', 'DEZFIL_OPERATION_CONCURRENCY=2', '-e', 'DEZFIL_QUERY_TIMEOUT_S=10', '-e', `DEZFIL_MCP_PROBE_LOG=${eventFile}`, '-e', 'NODE_OPTIONS=--import=/probes/mcp-probe-observer.mjs', '-v', `${root}/scripts:/probes:ro`, '-v', `${volume}:/data`, image);
    // The readiness probe is itself a node process inside the container, so it
    // inherits NODE_OPTIONS and would preload the observer, which records a boot
    // per process: six boots for two servers in the first CI run (36166632413).
    await until(async () => { try { docker('exec', '-e', 'NODE_OPTIONS=', name, 'node', '-e', `fetch('${base}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`); return true; } catch { return false; } }, Boolean, 'container readiness', 30_000);
  };
  const probe = (name, mode) => JSON.parse(docker('run', '--rm', '--network', `container:${name}`, '-v', `${root}/scripts:/probe/scripts:ro`, '-v', `${volume}:/data`, clientImage, 'node', '/probe/scripts/mcp-process-probe.mjs', mode, base, eventFile, seedFile).trim().split('\n').at(-1));
  try {
    await boot(names[0]); report.push(probe(names[0], 'seed'));
    const old = docker('inspect', '--format', '{{.Id}}', names[0]).trim();
    docker('kill', names[0]); assert.equal(docker('inspect', '--format', '{{.State.Running}}', names[0]).trim(), 'false');
    await boot(names[1]); assert.notEqual(docker('inspect', '--format', '{{.Id}}', names[1]).trim(), old);
    report.push(probe(names[1], 'restart')); report.push(probe(names[1], 'departure'));
  } finally {
    for (const name of names) { try { docker('rm', '-f', name); } catch {} }
    docker('volume', 'rm', volume);
  }
} else {
  const { seedRestart, readRestart, departure } = await import('./mcp-process-probe.mjs');
  const standalone = path.join(root, '.next/standalone');
  for (const name of ['@duckdb', 'better-sqlite3', 'bindings', 'file-uri-to-path']) await cp(path.join(root, 'node_modules', name), path.join(standalone, 'node_modules', name), { recursive: true });
  await mkdir(path.join(root, '.claude'), { recursive: true });
  const data = await mkdtemp(path.join(root, '.tmp-mcp-process-'));
  const file = path.join(data, 'mcp-events.ndjson'); await writeFile(file, '');
  let child;
  const boot = async () => {
    child = spawn(process.execPath, ['server.js'], { cwd: standalone, detached: true, env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', DEZFIL_DATA_DIR: data, DEZFIL_OPERATION_CONCURRENCY: '2', DEZFIL_QUERY_TIMEOUT_S: '10', DEZFIL_MCP_PROBE_LOG: file, NODE_OPTIONS: `--import=${root}/scripts/mcp-probe-observer.mjs` }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => process.stderr.write(bytes)); child.stderr.on('data', bytes => process.stderr.write(bytes));
    await until(async () => { if (child.exitCode !== null) throw new Error(`Standalone exited ${child.exitCode}`); try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, Boolean, 'standalone readiness', 30_000);
    return child.pid;
  };
  const stopByPort = async () => {
    if (!child || child.exitCode !== null) return;
    const owners = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
    assert.deepEqual(owners, [child.pid], 'only this standalone owns the port');
    process.kill(-owners[0], 'SIGKILL');
    await until(async () => { try { await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(200) }); return false; } catch { return true; } }, Boolean, 'old port closed', 2000);
  };
  try {
    const oldPid = await boot(); const seed = await seedRestart(base, file); report.push({ mode: 'seed', result: seed });
    await stopByPort(); assert.notEqual(await boot(), oldPid);
    report.push({ mode: 'restart', result: await readRestart(base, file, seed) });
    report.push({ mode: 'departure', result: await departure(base, file, { expectUnsupported: args.includes('--characterize') }) });
  } finally { await stopByPort(); await rm(data, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ mode: image ? 'container' : 'standalone', elapsedMs: Date.now() - started, report }, null, 2));
