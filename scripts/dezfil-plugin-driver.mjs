// Build separately first. This driver boots only a detached worktree standalone.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { until } from './mcp-probe-wait.mjs';
import { packageScenario } from './dezfil-package-scenario.mjs';
import { assertEvidenceWorktree } from './dezfil-plugin-safety.mjs';
const { values } = parseArgs({ options: { port: { type: 'string', default: '3399' }, render: { type: 'boolean' } } });
const root = process.cwd(); const port = Number(values.port);
assertEvidenceWorktree(root);
assert.ok(Number.isInteger(port) && port >= 3300 && port <= 65535);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const base = `http://127.0.0.1:${port}`; const standalone = path.join(root, '.next/standalone');
for (const name of ['@duckdb', 'better-sqlite3', 'bindings', 'file-uri-to-path']) await cp(path.join(root, 'node_modules', name), path.join(standalone, 'node_modules', name), { recursive: true });
await cp(path.join(root, '.next/static'), path.join(standalone, '.next/static'), { recursive: true });
await cp(path.join(root, 'public'), path.join(standalone, 'public'), { recursive: true });
await mkdir(path.join(root, '.claude'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.tmp-plugin-process-'));
const data = path.join(directory, 'data'); await mkdir(data);
const renderLog = path.join(directory, 'renders.ndjson'); await writeFile(renderLog, '');
const started = Date.now();
let initialOwners = '';
try { initialOwners = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim(); }
catch (error) { if (error.status !== 1) throw error; }
assert.equal(initialOwners, '', 'evidence port must be free before boot');
const child = spawn(process.execPath, ['--import', path.join(root, 'scripts/ingress-preload.mjs'), 'server.js'], { cwd: standalone, env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', DEZFIL_DATA_DIR: data, DEZFIL_EGRESS_ALLOWLIST: '127.0.0.1', ...(values.render ? { DEZFIL_PLUGIN_RENDER_LOG: renderLog, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${root}/scripts/dezfil-render-observer.mjs`.trim() } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', bytes => process.stderr.write(bytes)); child.stderr.on('data', bytes => process.stderr.write(bytes));
try {
  await until(async () => { if (child.exitCode !== null) throw new Error(`Standalone exited ${child.exitCode}`); try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, Boolean, 'isolated standalone readiness', 30000);
  assert.deepEqual(execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').map(Number), [child.pid], 'spawned process owns the endpoint before any product call');
  const report = await packageScenario(directory, base, { render: values.render, renderLog });
  console.log(JSON.stringify({ revision, directory, ...report, totalMs: Date.now() - started }, null, 2));
} catch (error) { console.error(JSON.stringify({ revision, directory, ...(error.scenarioReport ?? error.journeyReport ?? { result: 'failed', error: error.message }), totalMs: Date.now() - started }, null, 2)); process.exitCode = 1; }
finally {
  if (child.exitCode === null) {
    const owners = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
    assert.deepEqual(owners, [child.pid], 'only the spawned server owns this evidence port');
    process.kill(owners[0], 'SIGTERM');
  }
}
