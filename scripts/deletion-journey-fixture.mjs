import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { journeyApi } from './journey-http.mjs';
import { invite } from './sharing-journey-auth.mjs';
import { captureBasis } from './revision-fixtures.mjs';
import { until } from './mcp-probe-wait.mjs';
import { good } from './deletion-journey-roads.mjs';
import { digest, writeProofFile, plantImages, fileLedger, scanStore } from './deletion-journey-store.mjs';
export async function deletionFixture(base, admin, directory, db) {
  const api = journeyApi(base, { token: admin.token });
  const target = await invite(base, api, 'erase_owner'), control = await invite(base, api, 'keep_owner');
  const own = journeyApi(base, target), keep = journeyApi(base, control);
  const tag = randomUUID(), mark = name => `deletion-${name}-${tag}`;
  const erased = ['former-name', 'former-email', 'former-password', 'name', 'email', 'password', 'connection', 'content'].map(mark);
  const retained = [mark('control')];
  async function upload(client) {
    const form = new FormData(); form.append('file', new Blob(['value,lon,lat\n7,13.4,52.5\n']), 'same.csv');
    return good(await client('POST', '/api/tables', { form }));
  }
  const data = await upload(own), controlData = await upload(keep);
  const project = good(await own('POST', '/api/projects', { body: { name: 'Same project' } }));
  good(await own('PUT', `/api/projects/${project.id}/people/${control.sqlName}`, { body: { role: 'editor' } }));
  good(await own('PATCH', `/api/projects/${project.id}/members`, { body: { addTables: [data.id] } }));
  const targetMap = good(await own('POST', '/api/maps', { body: { name: erased[7], projectId: project.id } }));
  const foreignMap = good(await keep('POST', '/api/maps', { body: { name: 'Surviving input definition', projectId: project.id } }));
  const controlMap = good(await keep('POST', '/api/maps', { body: { name: retained[0] } }));
  const workflow = good(await own('POST', '/api/recipes', { body: { name: 'Owned workflow', projectId: project.id } })).recipe;
  const step = good(await own('POST', `/api/recipes/${workflow.id}/steps`, { basis: captureBasis(workflow), body: { operation: 'sql_step', parameters: { sql: 'SELECT value FROM same', name: 'owned_output' } } })).step;
  const run = good(await own('POST', `/api/recipes/${workflow.id}/runs`, { basis: captureBasis(step), body: {} })).run;
  await until(async () => good(await own('GET', `/api/recipes/${workflow.id}/runs/${run.id}`)).run, result => result.outcome === 'completed', 'owned workflow output');
  const survivorWorkflow = good(await keep('POST', '/api/recipes', { body: { name: 'Surviving workflow', projectId: project.id } })).recipe;
  good(await keep('POST', `/api/recipes/${survivorWorkflow.id}/steps`, { basis: captureBasis(survivorWorkflow), body: { operation: 'sql_step', parameters: { sql: `SELECT value FROM ${target.sqlName}.same`, name: 'survivor_output' } } }));
  // Synthetic child rows and opaque derivative bytes are a fixture ledger, not a render claim.
  const layers = { target: '', foreign: '', control: '' };
  for (const [name, map, sql] of [['target', targetMap, 'SELECT * FROM same'], ['foreign', foreignMap, `SELECT * FROM ${target.sqlName}.same`], ['control', controlMap, 'SELECT * FROM same']]) {
    const client = name === 'target' ? own : keep;
    layers[name] = good(await client('POST', `/api/maps/${map.id}/layers`, { basis: captureBasis(map), body: { name: 'Same', sql } })).id;
  }
  db.prepare("INSERT INTO pg_connections(id,name,host,port,database,username,password_encrypted,created_at,owner_id) VALUES(?,'Same','db.example.test',5432,'proof','proof',?,'time',?)").run(randomUUID(), erased[6], target.id);
  db.prepare("INSERT INTO pg_connections(id,name,host,port,database,username,password_encrypted,created_at,owner_id) VALUES(?,'Same','db.example.test',5432,'proof','proof',?,'time',?)").run(randomUUID(), retained[0], control.id);
  const row = id => db.prepare('SELECT id,file FROM data_tables WHERE id=?').get(id);
  const targetData = row(data.id), independentData = row(controlData.id);
  const removedFiles = db.prepare('SELECT file FROM data_tables WHERE owner_id=?').all(target.id).map(row => row.file);
  removedFiles.push(...plantImages(directory, targetMap.id, targetData, erased[7]), ...plantImages(directory, foreignMap.id, targetData, erased[7]));
  const controlPaths = [independentData.file, ...plantImages(directory, controlMap.id, independentData, retained[0])];
  for (const [name, dataset] of [['target', targetData], ['foreign', targetData], ['control', independentData]]) {
    const id = layers[name], inputs = { catalogue: false, datasets: [dataset] };
    db.prepare("INSERT INTO layer_tiles(layer_id,state,fingerprint,built_at,feature_count,updated_at) VALUES(?,'ready','proof','time',1,'time')").run(id);
    const paths = [`tiles/${id}.pmtiles`, `tiles/scratch/${id}.proof.geojsonl`, `artifact-inputs/tiles/${id}.json`];
    writeProofFile(directory, paths[0], name === 'control' ? retained[0] : erased[7]);
    if (name !== 'control') writeProofFile(directory, paths[1], erased[7]);
    writeProofFile(directory, paths[2], JSON.stringify({ fingerprint: 'proof', builtAt: 'time', inputs }));
    (name === 'control' ? controlPaths : removedFiles).push(...paths.filter((_, index) => name !== 'control' || index !== 1));
  }
  const scratch = `tmp/owned-${randomUUID()}.txt`; writeProofFile(directory, scratch, erased[7]);
  writeProofFile(directory, `file-owners/${digest(scratch)}.json`, JSON.stringify({ accountId: target.id, file: scratch, directory: false }));
  removedFiles.push(scratch, `file-owners/${digest(scratch)}.json`);
  for (const provider of ['geocode', 'isochrone', 'overpass']) {
    const file = `cache/${provider}/proof.json`; writeProofFile(directory, file, erased[7]); removedFiles.push(file);
  }
  const secretHashes = ['auth_sessions', 'auth_tokens', 'auth_links'].flatMap(table => db.prepare(`SELECT secret_hash FROM ${table} WHERE account_id=?`).all(target.id).map(row => row.secret_hash));
  erased.push(...secretHashes);
  db.pragma('secure_delete = OFF');
  db.prepare('UPDATE accounts SET name=?,email=?,password_hash=? WHERE id=?').run(erased[0].repeat(200), erased[1].repeat(200), erased[2].repeat(200), target.id);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const email = `${erased[4]}@example.test`;
  db.prepare('UPDATE accounts SET name=?,email=?,password_hash=? WHERE id=?').run(erased[3], email, erased[5], target.id);
  db.prepare("UPDATE maps SET publish_token=? WHERE id=?").run('deletion-target-page', targetMap.id);
  db.prepare("UPDATE maps SET publish_token=? WHERE id=?").run('deletion-control-page', controlMap.id);
  const owned = Object.fromEntries(['maps', 'recipes', 'data_tables', 'projects', 'pg_connections', 'operation_jobs'].map(table => [table, db.prepare(`SELECT id FROM ${table} WHERE owner_id=?`).all(target.id).map(row => row.id)]));
  for (const ids of Object.values(owned)) assert.ok(ids.length, 'every owned kind populated');
  for (const files of Object.values(scanStore(directory, [...erased, ...retained]))) assert.ok(files.length, 'every sentinel found before acceptance');
  return { target, control, email, owned, layers, targetMap, foreignMap, controlMap, survivorWorkflow, targetName: erased[7],
    ledger: { erased, retained, removedFiles, controlFiles: fileLedger(directory, controlPaths) },
    controlRow: db.prepare('SELECT * FROM maps WHERE id=?').get(controlMap.id),
    foreignRevision: db.prepare('SELECT edit_revision FROM maps WHERE id=?').get(foreignMap.id).edit_revision };
}
