// Checkout mirror of the image journey, using exactly the same seed/verify probe.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { recoveryCommandLink } from './account-identity-recovery.mjs';
const { values } = parseArgs({ options: { standalone: { type: 'string', default: '.next/standalone' }, port: { type: 'string', default: '3403' }, 'wire-port': { type: 'string', default: '3404' } } });
const root = process.cwd(), standalone = path.resolve(values.standalone), scratch = process.env.DEZFIL_DATA_DIR;
assert.ok(scratch && path.isAbsolute(scratch)); mkdirSync(scratch, { recursive: true }); assert.deepEqual(readdirSync(scratch), []);
const directory = path.join(scratch, 'store'), controls = path.join(scratch, 'control'), state = path.join(scratch, 'state.json');
mkdirSync(controls); const port = Number(values.port), wirePort = Number(values['wire-port']);
assert.ok(port >= 3300 && port <= 65535 && wirePort >= 3300 && wirePort <= 65535 && port !== wirePort);
const base = `http://127.0.0.1:${port}`, started = Date.now();
let server, ended, probe, log = '';
async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill(); const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  }
}
async function boot() {
  server = spawn(process.execPath, [`--import=${root}/scripts/ingress-preload.mjs`, `--import=${root}/scripts/account-deletion-journey-preload.mjs`, 'server.js'], {
    cwd: standalone, env: { ...process.env, DEZFIL_DATA_DIR: directory, DEZFIL_PROOF_CONTROL_DIR: controls, PORT: String(port), HOSTNAME: '127.0.0.1',
      DEZFIL_EGRESS_ALLOWLIST: '127.0.0.1', DEZFIL_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'proof-only', OPENAI_BASE_URL: `http://127.0.0.1:${wirePort}/v1` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  ended = once(server, 'exit'); server.stdout.on('data', b => { log += b; }); server.stderr.on('data', b => { log += b; });
  for (let i = 0; i < 160; i++) {
    assert.equal(server.exitCode, null, 'production server stays alive');
    try { const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }); await r.body?.cancel(); if (r.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Production server readiness');
}
async function run(mode) {
  probe = spawn(process.execPath, [path.join(root, 'scripts/account-deletion-journey.mjs'), mode, base, state, directory, controls, String(wirePort)], { cwd: standalone, env: { ...process.env, DEZFIL_DATA_DIR: directory }, stdio: 'inherit' });
  assert.equal((await once(probe, 'exit'))[0], 0, `${mode} journey`); probe = undefined;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { probe?.kill(); void stop(); process.exitCode = 1; });
try {
  await boot(); const first = server.pid; await run('seed'); await stop(); await boot(); assert.notEqual(server.pid, first);
  await run('verify');
  writeFileSync(path.join(controls, 'recovery-link'), recoveryCommandLink(root, directory, base, 'journey@example.test'), { mode: 0o600 });
  await run('recover');
  console.log(`PASS: confirmed account deletion checkout journey in ${(Date.now() - started) / 1000} seconds`);
} finally {
  probe?.kill(); await stop(); writeFileSync(path.join(scratch, 'server.log'), log);
  rmSync(directory, { recursive: true, force: true }); rmSync(controls, { recursive: true, force: true }); rmSync(state, { force: true });
}
