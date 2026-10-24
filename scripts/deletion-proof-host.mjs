import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export async function deletionProofHost({ standalone = '.next/standalone', port = 3397, wirePort } = {}) {
  const root = process.cwd(), scratch = process.env.DEZFIL_DATA_DIR;
  assert.ok(scratch && path.isAbsolute(scratch), 'set a fresh absolute DEZFIL_DATA_DIR');
  assert.ok(path.resolve(scratch) !== path.join(root, 'data'), 'scratch only');
  mkdirSync(scratch, { recursive: true }); assert.deepEqual(readdirSync(scratch), [], 'proof owns an empty scratch directory');
  assert.ok(port >= 3300 && port <= 65535, 'isolated port, never 3000');
  const base = `http://127.0.0.1:${port}`, directory = path.join(scratch, 'store');
  const controlDirectory = path.join(scratch, 'control'); mkdirSync(controlDirectory);
  let log = '', sequence = 0;
  const child = spawn(process.execPath, [`--import=${root}/scripts/ingress-preload.mjs`, `--import=${root}/scripts/deletion-proof-preload.mjs`, 'server.js'], {
    cwd: path.resolve(standalone), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, DEZFIL_DATA_DIR: directory, DEZFIL_PROOF_CONTROL_DIR: controlDirectory,
      HOSTNAME: '127.0.0.1', PORT: String(port), NEXT_TELEMETRY_DISABLED: '1', DEZFIL_TRUSTED_PROXIES: '',
      ...(wirePort ? { DEZFIL_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'proof-only', OPENAI_BASE_URL: `http://127.0.0.1:${wirePort}/v1` } : {}) },
  });
  child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  const ended = once(child, 'exit');
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await ended; } finally { clearTimeout(timer); }
    }
    writeFileSync(path.join(scratch, 'server.log'), log);
  }
  try {
    for (let i = 0;; i++) {
      assert.ok(i < 160 && child.exitCode === null && child.signalCode === null, `readiness: ${log.slice(-2500)}`);
      try { const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }); if (response.ok) { await response.body?.cancel(); break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) { await stop(); throw error; }
  function control(message) {
    const requestId = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error('Proof control timeout')), 30000);
      const receive = response => { if (response.requestId === requestId) done(response.error ? new Error(response.error) : null, response.value); };
      const exit = () => done(new Error('Proof host exited'));
      function done(error, value) { clearTimeout(timer); child.off('message', receive); child.off('exit', exit); if (error) reject(error); else resolve(value); }
      child.on('message', receive); child.once('exit', exit); child.send({ ...message, requestId });
    });
  }
  return { base, directory, controlDirectory, control, stop, ended };
}
if (process.argv[1]?.endsWith('/deletion-proof-host.mjs')) {
  const { values } = parseArgs({ options: { standalone: { type: 'string', default: '.next/standalone' }, port: { type: 'string', default: '3399' } } });
  const host = await deletionProofHost({ standalone: values.standalone, port: Number(values.port) });
  console.log(`READY: production browser proof at ${host.base}; control ${host.controlDirectory}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void host.stop());
  await host.ended;
}
