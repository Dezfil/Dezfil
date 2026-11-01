import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { until } from './storage-volume-support.mjs';

export function containerArguments({ image, name, root, port }) {
  return ['run', '--pull=never', '-d', '--name', name, '--network=none',
    '--tmpfs', '/data:size=1536m,uid=1000,gid=1000,mode=0700',
    '--tmpfs', '/proof:size=64m,uid=1000,gid=1000,mode=0700',
    '-v', `${root}/scripts:/probes:ro`, '-e', `PORT=${port}`, '-e', 'HOSTNAME=127.0.0.1',
    '-e', 'DEZFIL_DATA_DIR=/data', '-e', 'DEZFIL_PROOF_CONTROL_DIR=/proof', '-e', 'DEZFIL_PROOF_TILER=/usr/local/bin/tippecanoe',
    '-e', 'DEZFIL_TIPPECANOE=/probes/storage-volume-tiler.mjs', '-e', 'DEZFIL_CHROMIUM_PATH=/proof/no-browser',
    '-e', 'DEZFIL_TRUSTED_PROXIES=', '-e', 'DEZFIL_EGRESS_ALLOWLIST=127.0.0.1', '-e', 'DEZFIL_RENDER_CAP_FEATURES=10', '-e', 'DEZFIL_UPLOAD_MAX_MB=512',
    '-e', 'DEZFIL_TRUSTED_MEMORY_MB=512', '-e', 'DEZFIL_QUERY_MEMORY_MB=256', '-e', 'SQLITE_TMPDIR=/data/sqlite-tmp',
    image, 'node', '--import=/app/scripts/ingress-preload.mjs', '--import=/probes/storage-volume-preload.mjs', 'server.js'];
}
export async function runContainer({ image, standalone, port, root, scratch }) {
  const name = `dezfil-storage-${process.pid}-${Date.now()}`;
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'] });
  let owned = false, launched = false, result, log = '';
  try {
    assert.ok(image && !standalone, 'Choose exactly one of --container IMAGE or --standalone BUILD_DIR');
    assert.ok(Number.isInteger(port) && port >= 3300 && port <= 65535, 'Use an owned port from 3300 to 65535');
    assert.ok(scratch && path.isAbsolute(scratch), 'Set DEZFIL_DATA_DIR to a fresh absolute scratch directory');
    fs.mkdirSync(scratch, { recursive: true }); assert.deepEqual(fs.readdirSync(scratch), [], 'Scratch directory must be empty'); owned = true;
    docker(...containerArguments({ image, name, root, port })); launched = true;
    const base = `http://127.0.0.1:${port}`;
    await until(() => { try { docker('exec', name, 'node', '-e', `fetch('${base}/api/health',{signal:AbortSignal.timeout(500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`); return true; } catch { return false; } }, Boolean, 'Container did not become ready', 30_000);
    const output = docker('exec', name, 'node', '/probes/storage-volume-probe.mjs', base);
    result = JSON.parse(output.trim().split('\n').at(-1)); assert.equal(result.label, 'confirmed');
  } catch (error) { result = { label: 'failed', message: error.message, output: error.stderr?.toString().trim() }; process.exitCode = 1; }
  finally {
    if (launched) {
      try { log = docker('logs', name); } catch (error) { log += error.message; }
      try { docker('cp', `${name}:/proof`, path.join(scratch, 'control')); } catch (error) { result = { label: 'failed', message: `Evidence copy failed: ${error.message}`, previous: result }; process.exitCode = 1; }
      try { docker('rm', '-f', '-v', name); } catch (error) { result = { label: 'failed', message: `Cleanup failed: ${error.message}`, previous: result }; process.exitCode = 1; }
    }
    if (owned) { fs.writeFileSync(path.join(scratch, 'storage-server.log'), log); fs.writeFileSync(path.join(scratch, 'storage-result.json'), JSON.stringify(result, null, 2)); }
    console.log(JSON.stringify(result));
  }
}
