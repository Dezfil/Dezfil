// Outside proof: a built standalone, an owned port and an empty scratch store.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { invite } from './sharing-journey-auth.mjs';
const { values } = parseArgs({ options: { standalone: { type: 'string', default: '.next/standalone' }, port: { type: 'string', default: '3395' }, seed: { type: 'string' } } });
assert.ok(!values.seed || values.seed === 'module-local');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = process.env.DEZFIL_DATA_DIR;
assert.ok(directory && path.isAbsolute(directory)); mkdirSync(directory, { recursive: true });
assert.deepEqual(readdirSync(directory), [], 'only a fresh scratch store');
const port = Number(values.port); assert.ok(port >= 3300 && port <= 65535);
const base = `http://127.0.0.1:${port}`, started = performance.now();
const standalone = path.resolve(values.standalone);
const child = spawn(process.execPath, [
  `--import=${root}/scripts/ingress-preload.mjs`,
  ...(values.seed ? [`--import=${root}/scripts/account-deletion-page-preload.mjs`] : []), 'server.js',
], { cwd: standalone, env: { ...process.env, DEZFIL_DATA_DIR: directory, HOSTNAME: '127.0.0.1', PORT: String(port), NEXT_TELEMETRY_DISABLED: '1', DEZFIL_TRUSTED_PROXIES: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let log = ''; child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
const ended = once(child, 'exit');
async function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await ended; } finally { clearTimeout(timer); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { process.exitCode = 1; void stop(); });
const ok = response => { assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response)); return response.json; };
async function page(route, cookie) {
  const response = await fetch(base + route, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  return { status: response.status, body: await response.text() };
}
try {
  for (let i = 0;; i++) {
    assert.ok(i < 160 && child.exitCode === null, `standalone readiness: ${log.slice(-1500)}`);
    try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  const admin = await provisionJourney(base), api = journeyApi(base, admin);
  const target = await invite(base, api, 'departure-target'), member = await invite(base, api, 'departure-member');
  const targetApi = journeyApi(base, target), memberApi = journeyApi(base, member);
  const project = ok(await targetApi('POST', '/api/projects', { body: { name: 'Shared proof' } }));
  ok(await targetApi('PUT', `/api/projects/${project.id}/people/${member.sqlName}`, { body: { role: 'viewer' } }));
  const targetMap = ok(await targetApi('POST', '/api/maps', { body: { name: 'Target page sentinel', projectId: project.id } }));
  const controlMap = ok(await memberApi('POST', '/api/maps', { body: { name: 'Control page sentinel' } }));
  const db = new Database(path.join(directory, 'metadata.sqlite'));
  try {
    db.prepare("UPDATE maps SET publish_token = ? WHERE id = ?").run('target-page-token', targetMap.id);
    db.prepare("UPDATE maps SET publish_token = ? WHERE id = ?").run('control-page-token', controlMap.id);
    const targets = [`/maps/${targetMap.id}`, '/v/target-page-token', '/v/target-page-token?embed=1'];
    const controls = [`/maps/${controlMap.id}`, '/v/control-page-token'];
    for (const route of [...targets, ...controls]) assert.equal((await page(route, member.cookie)).status, 200, `warm ${route}`);
    db.prepare("UPDATE accounts SET status = 'deleting' WHERE id = ?").run(target.id);
    if (values.seed) {
      const ready = once(child, 'message'); child.send('replay-cached-admission'); await ready;
    }
    for (const route of targets) {
      const response = await page(route, member.cookie);
      // Next can stream the not-found boundary with HTTP 200 after headers.
      assert.ok(response.status === 404 || response.body.includes('NEXT_HTTP_ERROR_FALLBACK;404'), `accepted owner must be absent from built page ${route} (${response.status})`);
      assert.ok(!response.body.includes('Target page sentinel'), 'no target material in refused page');
    }
    for (const route of controls) assert.equal((await page(route, member.cookie)).status, 200, `independent ${route}`);
    console.log(`PASS: confirmed built workspace, published and embedded page refusal with independent controls (${((performance.now() - started) / 1000).toFixed(1)} s)`);
  } finally { db.close(); }
} catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
finally { await stop(); writeFileSync(path.join(directory, 'page-proof-server.log'), log); }
