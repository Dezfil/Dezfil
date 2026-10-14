import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { invite } from './sharing-journey-auth.mjs';
const { values } = parseArgs({ options: { standalone: { type: 'string', default: '.next/standalone' }, port: { type: 'string', default: '3396' }, seed: { type: 'string' } } });
assert.ok(!values.seed || values.seed === 'lost-journal');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), standalone = path.resolve(values.standalone);
const scratch = process.env.DEZFIL_DATA_DIR, port = Number(values.port);
assert.ok(scratch && path.isAbsolute(scratch)); mkdirSync(scratch, { recursive: true }); assert.deepEqual(readdirSync(scratch), []);
assert.ok(port >= 3300 && port <= 65535);
const base = `http://127.0.0.1:${port}`, begun = performance.now();
let child, ended, log = '', sequence = 0;
async function stop(signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await ended; } finally { clearTimeout(timer); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { process.exitCode = 1; void stop(); });
async function start(directory, restart = false) {
  child = spawn(process.execPath, [`--import=${root}/scripts/ingress-preload.mjs`, `--import=${root}/scripts/account-deletion-restart-preload.mjs`, 'server.js'], {
    cwd: standalone, env: { ...process.env, DEZFIL_DATA_DIR: directory, HOSTNAME: '127.0.0.1', PORT: String(port), NEXT_TELEMETRY_DISABLED: '1', DEZFIL_TRUSTED_PROXIES: '', DEZFIL_PROOF_LOSE_JOURNAL: restart && values.seed ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; }); ended = once(child, 'exit');
  for (let i = 0;; i++) {
    assert.ok(i < 160 && child.exitCode === null && child.signalCode === null, `server readiness: ${log.slice(-2000)}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
}
function ipc(message) {
  const requestId = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => cleanup(new Error('Proof IPC timed out')), 90000);
    const exit = () => cleanup(new Error('Proof worker exited before replying'));
    const receive = reply => { if (reply.requestId === requestId) cleanup(reply.error ? new Error(reply.error) : null, reply.value); };
    function cleanup(error, value) { clearTimeout(timer); child.off('message', receive); child.off('exit', exit); if (error) reject(error); else resolve(value); }
    child.on('message', receive); child.once('exit', exit); child.send({ ...message, requestId });
  });
}
const ok = response => { assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response)); return response.json; };
try {
  for (const stage of ['acceptance', 'rows', 'files', 'compaction', 'removal']) {
    const directory = path.join(scratch, stage); mkdirSync(directory); await start(directory);
    const admin = await provisionJourney(base), adminApi = journeyApi(base, admin);
    const target = await invite(base, adminApi, `target-${stage}`), control = await invite(base, adminApi, `control-${stage}`);
    const targetMap = ok(await journeyApi(base, target)('POST', '/api/maps', { body: { name: 'Target restart sentinel' } }));
    const controlMap = ok(await journeyApi(base, control)('POST', '/api/maps', { body: { name: 'Control restart sentinel' } }));
    const file = path.join(directory, 'metadata.sqlite'); let db = new Database(file);
    db.prepare("INSERT INTO projects(id,name,owner_id,created_at,updated_at) VALUES('owned-project','Same',?,'time','time')").run(target.id);
    db.prepare("UPDATE maps SET project_id='owned-project' WHERE id=?").run(controlMap.id);
    db.prepare("UPDATE maps SET publish_token='restart-token' WHERE id=?").run(targetMap.id);
    for (const [owner, name] of [[target, 'target'], [control, 'control']]) {
      const file = `tables/${name}.parquet`;
      mkdirSync(path.join(directory, 'tables'), { recursive: true }); mkdirSync(path.join(directory, 'file-owners'), { recursive: true });
      writeFileSync(path.join(directory, file), `${name}-restart-file-sentinel`);
      writeFileSync(path.join(directory, 'file-owners', `${createHash('sha256').update(file).digest('hex')}.json`), JSON.stringify({ accountId: owner.id, file, directory: false }));
      db.prepare("INSERT INTO data_tables(id,name,format,file,row_count,created_at,owner_id) VALUES(?, 'same_dataset','parquet',?,1,'time',?)").run(`dataset-${name}`, file, owner.id);
    }
    db.prepare("UPDATE accounts SET status='deactivated' WHERE id=?").run(target.id); db.close();
    const secret = admin.cookie?.slice(admin.cookie.indexOf("=") + 1); assert.ok(secret, 'admin session');
    const accepted = await ipc({ command: 'accept', accountId: target.id, secret });
    assert.equal(accepted.state, 'pending');
    const journalFile = path.join(directory, 'account-deletions', `${accepted.id}.json`);
    if (stage === 'acceptance') await stop('SIGKILL');
    else {
      const response = ipc({ command: 'finish', id: accepted.id, killAt: stage, secret }).then(() => { throw new Error('Expected process kill'); }, error => error);
      await ended; await response; assert.equal(child.signalCode, 'SIGKILL', 'kill at durable boundary');
    }
    assert.ok(existsSync(journalFile), 'kill retains the private journal');
    await start(directory, true);
    // Read the physical record before invoking the source coordinator: this
    // assertion observes production instrumentation, not a second discovery call.
    assert.ok(existsSync(journalFile), 'restart retains the accepted deletion identifier');
    assert.equal(JSON.parse(readFileSync(journalFile, 'utf8')).state, 'needs-retry', 'production startup discovers pending work');
    assert.deepEqual(await ipc({ command: 'status', accountId: target.id, secret }), { id: accepted.id, state: 'needs-retry' });
    const publication = await fetch(base + '/api/published/restart-token'); assert.equal(publication.status, 404); await publication.body?.cancel();
    assert.equal((await journeyApi(base, control)('GET', `/api/maps/${controlMap.id}`)).status, 200, 'independent owner keeps working');
    db = new Database(file); const before = db.prepare('SELECT edit_revision FROM maps WHERE id=?').get(controlMap.id); db.close();
    assert.deepEqual(await ipc({ command: 'finish', id: accepted.id, secret }), { id: accepted.id, state: 'completed' });
    assert.equal(existsSync(journalFile), false);
    assert.equal(existsSync(path.join(directory, 'tables/target.parquet')), false);
    assert.equal(readFileSync(path.join(directory, 'tables/control.parquet'), 'utf8'), 'control-restart-file-sentinel');
    db = new Database(file);
    const survivor = db.prepare('SELECT project_id,last_changed_by,edit_revision FROM maps WHERE id=?').get(controlMap.id);
    assert.equal(survivor.project_id, null); assert.ok(survivor.last_changed_by);
    if (stage !== 'acceptance') assert.equal(survivor.edit_revision, before.edit_revision, 'retry never repeats dissolution');
    assert.equal(db.prepare('SELECT status FROM accounts WHERE id=?').get(target.id)?.status, 'deleted');
    assert.equal(db.prepare('SELECT id FROM maps WHERE id=?').get(targetMap.id), undefined); db.close();
    assert.equal(await ipc({ command: 'status', accountId: target.id, secret }), null);
    await stop(); console.log(`PASS: confirmed restart and same-id continuation after ${stage}`);
  }
  console.log(`PASS: all restart boundaries (${((performance.now() - begun) / 1000).toFixed(1)} s)`);
} catch (error) { console.error(`FAIL: ${error.stack}`); process.exitCode = 1; }
finally { await stop(); writeFileSync(path.join(scratch, 'restart-proof-server.log'), log); }
