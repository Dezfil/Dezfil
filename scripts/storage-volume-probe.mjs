import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { journeyAccount, provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { invite } from './sharing-journey-auth.mjs';
import { captureBasis } from './revision-fixtures.mjs';
import { MB, THRESHOLD, RESERVE, boundedVolume, freeBytes, fillVolume, heldUpload, until, jsonFile, lines, noSpace, partialFiles } from './storage-volume-support.mjs';
const base = process.argv[2], folder = process.env.DEZFIL_DATA_DIR, control = process.env.DEZFIL_PROOF_CONTROL_DIR;
const started = Date.now(), report = [], uploads = [];
let db;
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mark = name => path.join(control, name);
const hold = name => { fs.rmSync(mark(`${name}.started`), { force: true }); fs.writeFileSync(mark(`${name}.hold`), 'hold'); };
const release = name => fs.rmSync(mark(`${name}.hold`), { force: true });
const good = result => { assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result)); return result.json; };
const controlStarted = name => until(() => jsonFile(mark(`${name}.started`)), Boolean, `${name} never reached its held native work`);
const writerState = () => jsonFile(mark('writers.json'), { live: -1 });
const expanded = "SELECT repeat('storage_probe_conversion', 5000) AS payload FROM range(20000)";
try {
  assert.ok(base && new URL(base).hostname === '127.0.0.1' && new URL(base).port !== '3000', 'Use the owned loopback instance');
  assert.ok(folder && control && !path.resolve(control).startsWith(path.resolve(folder) + path.sep), 'Controls must be outside the bounded volume');
  const total = boundedVolume(folder);
  const admin = await provisionJourney(base), api = journeyApi(base, { cookie: admin.cookie });
  const Database = createRequire(path.join(process.cwd(), 'package.json'))('better-sqlite3');
  const openDb = () => { db = new Database(path.join(folder, 'metadata.sqlite')); db.pragma('busy_timeout = 1000'); };
  openDb();
  await until(() => fs.existsSync(path.join(folder, '.storage-reserve')) && fs.statSync(path.join(folder, '.storage-reserve')).size, n => n === RESERVE, 'Reserve not allocated');
  assert.ok(fs.statSync(path.join(folder, '.storage-reserve')).blocks * 512 >= RESERVE, 'Reserve must hold actual blocks');
  async function upload(name) {
    const form = new FormData(); form.append('file', new Blob(['id,lon,lat\n' + Array.from({ length: 40 }, (_, i) => `${i},${13.3 + i / 1000},52.5`).join('\n')]), `${name}.csv`);
    return good(await api('POST', '/api/tables', { form })).tables[0];
  }
  const kept = await upload('storage_kept'), disposable = await upload('storage_delete');
  const map = good(await api('POST', '/api/maps', { body: { name: 'Preserved map' } }));
  const eraseMap = good(await api('POST', '/api/maps', { body: { name: 'Delete while full' } }));
  const layer = good(await api('POST', `/api/maps/${map.id}/layers`, { basis: captureBasis(map), body: { name: 'Points', sql: `SELECT id, geometry FROM ${kept.name}` } }));
  const render = () => api('GET', `/api/layers/${layer.id}/render`).then(good);
  await until(render, value => value.tiles?.state === 'ready', 'Initial real tile archive not built');
  const archive = path.join(folder, 'tiles', `${layer.id}.pmtiles`), evidence = path.join(folder, 'artifact-inputs/tiles', `${layer.id}.json`);
  const tableFile = path.join(folder, db.prepare('SELECT file FROM data_tables WHERE id=?').get(kept.id).file);
  const before = { archive: digest(archive), evidence: digest(evidence), table: digest(tableFile) };
  const target = await invite(base, api, 'storage_erased');
  good(await api('PATCH', `/api/users/${target.id}`, { body: { status: 'deactivated' } }));
  const published = good(await api('POST', `/api/maps/${eraseMap.id}/publish`, { basis: captureBasis(eraseMap), body: {} }));
  assert.ok(published.token);
  const revoked = good(await api('POST', '/api/account/tokens', { body: { name: 'Revoke while full' } }));
  const scratchBefore = partialFiles(folder);
  const ledgerBefore = fs.readdirSync(path.join(folder, 'file-owners')).sort();
  async function capacityBack() {
    fs.rmSync(path.join(folder, '.storage-probe-hog'), { force: true });
    assert.ok(freeBytes(folder) > THRESHOLD + RESERVE, 'Free space must return above the refill boundary');
    good(await api('GET', '/api/config'));
    await until(() => fs.statSync(path.join(folder, '.storage-reserve')).size, n => n === RESERVE, 'Reserve did not replenish');
  }
  function checkpointAndFill() {
    db.pragma('wal_checkpoint(TRUNCATE)');
    fillVolume(folder);
    assert.ok(freeBytes(folder) < 4096);
  }
  // Each declaration fits at admission, but no aggregate capacity reservation exists.
  hold('conversion');
  const nativeConversion = api('POST', '/api/query/export', { body: { sql: expanded, format: 'csv' } });
  void nativeConversion.catch(() => {});
  await controlStarted('conversion');
  assert.ok(freeBytes(folder) - THRESHOLD > 128 * MB);
  const pair = [heldUpload(base, admin.cookie), heldUpload(base, admin.cookie)]; uploads.push(...pair);
  await until(writerState, state => state.live >= 3, 'Two receivers and a conversion were not simultaneously admitted');
  checkpointAndFill();
  release('conversion');
  const nativeAnswers = await Promise.all([nativeConversion, ...pair.map(item => item.finish())]);
  for (const answer of nativeAnswers) noSpace(answer);
  assert.ok(lines(mark('native-errors.ndjson')).some(row => /no space left on device/i.test(row.message)), 'Native conversion must encounter the full filesystem');
  await until(writerState, state => state.live === 0, 'Failed native writes did not settle');
  assert.deepEqual(partialFiles(folder), scratchBefore, 'Native failures leave no partials');
  assert.deepEqual(fs.readdirSync(path.join(folder, 'file-owners')).sort(), ledgerBefore, 'Native failures leave no ownership records');
  assert.equal(digest(tableFile), before.table, 'Existing dataset generation remains byte-identical');
  report.push({ check: 'overlapping native writes', status: 'confirmed', answers: nativeAnswers.map(a => a.status) });
  await capacityBack();

  // Pause a conversion, a real tile process and an open declared body together.
  const currentMap = good(await api('GET', `/api/maps/${map.id}`));
  good(await api('PATCH', `/api/layers/${layer.id}`, { basis: captureBasis(currentMap), body: { sql: `SELECT id, geometry FROM ${kept.name} WHERE id >= 0` } }));
  hold('tile'); assert.equal((await render()).tiles?.state, 'building');
  const tiler = await controlStarted('tile');
  hold('conversion'); const conversion = api('POST', '/api/query/export', { body: { sql: expanded, format: 'csv' } });
  void conversion.catch(() => {});
  await controlStarted('conversion');
  const receiver = heldUpload(base, admin.cookie); uploads.push(receiver);
  await until(writerState, state => state.live >= 3, 'Controlled overlap did not contain all three writers');
  const eventsBefore = lines(mark('writers.ndjson')).length;
  checkpointAndFill();
  good(await api('GET', '/api/maps')); // Existing credential on the full filesystem.
  const signin = await fetch(base + '/api/auth/sign-in', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ email: journeyAccount.email, password: journeyAccount.password }) });
  assert.equal(signin.status, 200, await signin.text());
  const freshCookie = signin.headers.getSetCookie()[0]?.split(';')[0];
  assert.ok(freshCookie, 'Fresh sign-in must issue a session');
  good(await journeyApi(base, { cookie: freshCookie })('GET', '/api/maps'));
  noSpace(await conversion); noSpace(await receiver.result);
  await until(writerState, state => state.live === 0 && !state.fenced, 'Recovery fence did not settle and reopen');
  await until(() => lines(mark('writers.ndjson')).slice(eventsBefore), rows => rows.filter(e => e.event === 'settled' && e.elapsedMs !== null).length >= 3, 'Missing writer settlement evidence');
  const events = lines(mark('writers.ndjson')).slice(eventsBefore), aborted = events.filter(e => e.event === 'aborted');
  assert.ok(aborted.length >= 3, 'All three admitted roads must be fenced');
  for (const event of aborted) {
    assert.equal(event.code, 'storage_exhausted');
    const ended = events.find(e => e.id === event.id && e.event === 'settled');
    assert.ok(ended && ended.elapsedMs <= 35_000, 'Fenced work must settle within the allowance');
  }
  assert.throws(() => process.kill(tiler.pid, 0), { code: 'ESRCH' }, 'The tiler process must be gone');
  await until(() => lines(mark('storage-log.ndjson')), rows => rows.some(row => /fence settled/.test(row.message)), 'No measured fence settlement');
  const failed = await render(); assert.equal(failed.ok, false); assert.equal(failed.error.code, 'storage_exhausted');
  assert.equal(digest(archive), before.archive); assert.equal(digest(evidence), before.evidence); assert.equal(digest(tableFile), before.table);
  assert.deepEqual(partialFiles(folder), scratchBefore, 'Fence cleanup leaves no partials');
  release('conversion'); release('tile');
  const fences = lines(mark('storage-log.ndjson')).map(row => /fence settled in (\d+) ms; (\d+) overdue/.exec(row.message)).filter(Boolean);
  assert.ok(fences.length && fences.every(row => Number(row[1]) <= 35_000 && row[2] === '0'));
  report.push({ check: 'recovery overlap', status: 'confirmed', fenced: aborted.length, fenceToSettlementMs: fences.map(row => Number(row[1])) });

  // Refill the hog before every action: one successful recovery must not mask the next.
  const actions = [
    ['dataset deletion', () => api('DELETE', `/api/tables/${disposable.name}`)],
    ['token revocation', () => api('DELETE', `/api/account/tokens/${revoked.id}`)],
    ['unpublish', async () => api('DELETE', `/api/maps/${eraseMap.id}/publish`, { basis: captureBasis(good(await api('GET', `/api/maps/${eraseMap.id}`))) })],
    ['map deletion', async () => api('DELETE', `/api/maps/${eraseMap.id}`, { basis: captureBasis(good(await api('GET', `/api/maps/${eraseMap.id}`))) })],
    ['cache clear', () => api('DELETE', '/api/instance/caches')],
  ];
  for (const [check, action] of actions) { checkpointAndFill(); const answer = await action(); good(answer); report.push({ check, status: 'confirmed', http: answer.status }); }
  assert.equal(db.prepare('SELECT id FROM data_tables WHERE id=?').get(disposable.id), undefined);
  assert.equal(db.prepare('SELECT id FROM maps WHERE id=?').get(eraseMap.id), undefined);
  assert.equal((await journeyApi(base, { token: revoked.secret })('GET', '/api/maps')).status, 401);
  await capacityBack();

  // A retained fixture row makes VACUUM need more than one recovery slice.
  db.exec('CREATE TABLE storage_probe_padding (payload BLOB)');
  db.prepare('INSERT INTO storage_probe_padding VALUES (zeroblob(?))').run(48 * MB);
  const preview = good(await api('GET', `/api/users/${target.id}/deletion-preview`));
  checkpointAndFill();
  assert.ok(freeBytes(folder) < 2 * fs.statSync(path.join(folder, 'metadata.sqlite')).size);
  db.close(); db = undefined; // No outside handle is allowed to explain compaction failure.
  const deletion = good(await api('DELETE', `/api/users/${target.id}`, { body: { confirmation: preview.confirmation, confirm: true, email: `${target.name}@example.test` } }));
  assert.notEqual(deletion.state, 'completed', 'Compaction cannot claim completion without working space');
  const pending = await until(() => api('GET', `/api/users/deletions/${deletion.id}`).then(good), answer => answer.state === 'needs-retry', 'Compaction must report unfinished');
  assert.equal(pending.id, deletion.id);
  await capacityBack();
  const completed = good(await api('POST', `/api/users/deletions/${deletion.id}/finish`));
  assert.equal(completed.state, 'completed', JSON.stringify(completed));
  assert.equal((await api('GET', `/api/users/deletions/${deletion.id}`)).status, 404);
  report.push({ check: 'account compaction', status: 'confirmed', before: pending.state, after: completed.state });
  openDb();
  assert.equal(db.prepare('SELECT id FROM accounts WHERE id=?').get(target.id), undefined);
  await upload('storage_after');
  await until(render, value => value.tiles?.state === 'ready', 'Tile failure remained sticky after capacity returned');
  const transitions = lines(mark('storage-log.ndjson')).map(row => /^\[storage\] (full|available):/.exec(row.message)?.[1]).filter(Boolean);
  assert.ok(transitions.includes('full') && transitions.includes('available'));
  assert.ok(transitions.every((value, i) => !i || value !== transitions[i - 1]), 'Transitions must not repeat unchanged state');
  const result = { label: 'confirmed', totalBytes: total, elapsedSeconds: (Date.now() - started) / 1000, report };
  fs.writeFileSync(mark('result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  const result = { label: 'failed', message: error.message, report };
  if (control) fs.writeFileSync(mark('result.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result)); process.exitCode = 1;
} finally { db?.close(); for (const upload of uploads) upload.close(); }
