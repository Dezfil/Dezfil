import net from 'node:net';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { until } from './storage-volume-support.mjs';
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const standalone = option('--standalone'), port = Number(option('--port') ?? 3409);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.env.DEZFIL_DATA_DIR;
if (option('--container')) {
  const { runContainer } = await import('./storage-volume-container.mjs');
  await runContainer({ image: option('--container'), standalone, port, root, scratch });
} else {
let server, serverExit, attached = false, owned = false, image, volume, result, log = '';
const command = (bin, args, options = {}) => execFileSync(bin, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], ...options });
try {
  assert.ok(standalone, 'Choose --standalone BUILD_DIR');
  assert.ok(Number.isInteger(port) && port >= 3300 && port <= 65535, 'Use an owned port from 3300 to 65535');
  assert.equal(process.platform, 'darwin', 'The disk-image driver runs on macOS');
  assert.ok(scratch && path.isAbsolute(scratch), 'Set DEZFIL_DATA_DIR to a fresh absolute scratch directory');
  fs.mkdirSync(scratch, { recursive: true }); assert.deepEqual(fs.readdirSync(scratch), [], 'Scratch directory must be empty'); owned = true;
  const disk = fs.statfsSync(scratch); assert.ok(disk.bavail * disk.bsize >= 3 * 1024 ** 3, 'At least 3 GB free is required');
  volume = path.join(scratch, 'volume'); image = path.join(scratch, 'bounded.dmg'); fs.mkdirSync(volume);
  // With no sparse type, this makes a fixed-size read-write image. A sparse one would not establish this proof's bound.
  command('hdiutil', ['create', '-size', '1536m', '-fs', 'HFS+', '-volname', 'DezfilStorageProbe', image]);
  command('hdiutil', ['attach', '-nobrowse', '-mountpoint', volume, image]); attached = true;
  const directory = path.join(volume, 'data'), control = path.join(scratch, 'control');
  fs.mkdirSync(directory); fs.mkdirSync(control); fs.mkdirSync(path.join(directory, 'sqlite-tmp'));
  const tiler = command('which', ['tippecanoe']).trim(); assert.ok(tiler);
  assert.ok(fs.existsSync(path.join(standalone, 'server.js')), 'Build the production standalone before running this driver');
  await new Promise((resolve, reject) => { const check = net.createServer(); check.once('error', reject); check.listen(port, '127.0.0.1', () => check.close(resolve)); });
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, PORT: String(port), HOSTNAME: '127.0.0.1',
    DEZFIL_DATA_DIR: directory, DEZFIL_PROOF_CONTROL_DIR: control, DEZFIL_PROOF_TILER: tiler,
    DEZFIL_TIPPECANOE: path.join(root, 'scripts/storage-volume-tiler.mjs'), DEZFIL_CHROMIUM_PATH: path.join(control, 'no-browser'),
    DEZFIL_TRUSTED_PROXIES: '', DEZFIL_RENDER_CAP_FEATURES: '10', DEZFIL_UPLOAD_MAX_MB: '512',
    DEZFIL_TRUSTED_MEMORY_MB: '512', DEZFIL_QUERY_MEMORY_MB: '256', SQLITE_TMPDIR: path.join(directory, 'sqlite-tmp'), NEXT_TELEMETRY_DISABLED: '1' };
  server = spawn(process.execPath, [`--import=${root}/scripts/ingress-preload.mjs`, `--import=${root}/scripts/storage-volume-preload.mjs`, 'server.js'],
    { cwd: standalone, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverExit = new Promise(resolve => { server.once('exit', resolve); server.once('error', error => { log += error.message; resolve(); }); });
  server.stdout.on('data', bytes => { log += bytes; }); server.stderr.on('data', bytes => { log += bytes; });
  await until(async () => { assert.ok(server.exitCode === null && server.signalCode === null, 'Standalone exited before readiness'); try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) }); await r.body?.cancel(); return r.ok; } catch { return false; } }, Boolean, 'Standalone did not become ready', 30_000);
  const output = command(process.execPath, [path.join(root, 'scripts/storage-volume-probe.mjs'), base], { env, cwd: standalone, timeout: 240_000 });
  // The probe runs beside the server, using its dependency tree and the same bounded store.
  result = JSON.parse(output.trim().split('\n').at(-1)); assert.equal(result.label, 'confirmed');
} catch (error) { result = { label: 'failed', message: error.message, output: error.stderr?.toString().trim() }; process.exitCode = 1; }
finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    const ended = await Promise.race([serverExit.then(() => true), pause(10_000).then(() => false)]);
    if (!ended) { server.kill('SIGKILL'); await serverExit; }
  }
  try { if (attached) { command('hdiutil', ['detach', volume]); attached = false; } }
  catch (error) { result = { label: 'failed', message: `Detach failed: ${error.message}`, previous: result }; process.exitCode = 1; }
  if (image && !attached) fs.rmSync(image, { force: true });
  if (owned) {
    fs.writeFileSync(path.join(scratch, 'storage-server.log'), log);
    fs.writeFileSync(path.join(scratch, 'storage-result.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result));
}

}
