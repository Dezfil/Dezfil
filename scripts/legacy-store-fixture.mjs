// Synthetic pre-account store. The fixture writes only a newly created scratch
// directory; callers upgrade a copy and keep the source untouched for restore.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DuckDBInstance } from '@duckdb/node-api';
import { MIGRATIONS } from '../src/lib/metadata/migrations.ts';

export const legacy = { version: 39, name: 'Legacy cartographer', instance: 'Survey archive',
  table: 'legacy_survey', map: 'legacy-map', layer: 'legacy-layer', project: 'legacy-project',
  workflow: 'legacy-workflow', step: 'legacy-step', connection: 'legacy-connection', token: 'abcdefghijklmnopqrstuvwx',
  preferences: { maps: { view: 'list', sort: 'name' }, data: { view: 'grid' }, workflows: { sort: 'updated' } },
  password: 'synthetic-postgis-password' };

export async function createLegacyStore(directory) {
  assert.equal((await readdir(directory)).length, 0, 'seed directory must be empty');
  assert.equal(MIGRATIONS[legacy.version].includes('CREATE TABLE accounts'), true, 'fixture pins the last pre-account schema');
  await mkdir(path.join(directory, 'tables'));
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run('LOAD spatial');
    const file = path.join(directory, 'tables/legacy.parquet').replaceAll("'", "''");
    await connection.run(`COPY (SELECT 'station' AS name, 7 AS value, ST_SetCRS(ST_Point(13.4, 52.5), 'EPSG:4326') AS geometry) TO '${file}' (FORMAT PARQUET)`);
  } finally { connection.closeSync(); instance.closeSync(); }
  const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(legacy.password, 'utf8'), cipher.final()]);
  const envelope = [iv, cipher.getAuthTag(), ciphertext].map(bytes => bytes.toString('base64')).join(':');
  await writeFile(path.join(directory, 'secret.key'), key.toString('hex') + '\n', { mode: 0o600 });
  const db = new Database(path.join(directory, 'metadata.sqlite'));
  const now = '2026-01-01T00:00:00.000Z';
  try {
    db.pragma('foreign_keys = ON');
    for (const migration of MIGRATIONS.slice(0, legacy.version)) db.exec(migration);
    db.pragma(`user_version = ${legacy.version}`);
    const setting = db.prepare('INSERT INTO workspace_settings VALUES (?, ?, ?)');
    for (const [key, value] of [['display_name', legacy.name], ['instance_name', legacy.instance], ['view_prefs', JSON.stringify(legacy.preferences)]]) setting.run(key, value, now);
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(legacy.project, 'Legacy project', 'Keep this note', now, now);
    db.prepare('INSERT INTO data_tables (id, name, source_filename, format, file, geometry_column, geometry_type, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-table', legacy.table, 'survey.geojson', 'geojson', 'tables/legacy.parquet', 'geometry', 'POINT', 1, now);
    db.prepare('INSERT INTO project_datasets VALUES (?, ?, ?)').run(legacy.project, 'legacy-table', now);
    db.prepare('INSERT INTO maps (id, name, publish_token, published_at, created_at, updated_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(legacy.map, 'Legacy map', legacy.token, now, now, now, legacy.project);
    const style = { fill: { type: 'constant', color: { r: 26, g: 93, b: 74, a: 1 } }, fillOpacity: 1, stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeOpacity: 1, strokeWidth: 0, pointRadius: 3, opacity: 1 };
    db.prepare('INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(legacy.layer, legacy.map, 'Legacy layer', `SELECT * FROM ${legacy.table}`, JSON.stringify(style), 0, now, now);
    db.prepare('INSERT INTO recipes (id, name, origin, created_at, updated_at, project_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(legacy.workflow, 'Legacy workflow', 'workflow', now, now, legacy.project);
    db.prepare('INSERT INTO recipe_steps (id, recipe_id, ordinal, operation, parameters, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(legacy.step, legacy.workflow, 0, 'sql_step', JSON.stringify({ sql: `SELECT name, value FROM ${legacy.table}`, name: 'legacy_result' }), now, now);
    db.prepare('INSERT INTO pg_connections (id, name, host, port, database, username, password_encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(legacy.connection, 'Legacy PostGIS', 'db.example.test', 5432, 'survey', 'reader', envelope, now);
  } finally { db.close(); }
}

export async function legacyFiles(directory) {
  return Object.fromEntries(await Promise.all(['metadata.sqlite', 'secret.key', 'tables/legacy.parquet'].map(async file =>
    [file, createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex')])));
}
export function legacyRows(db) {
  return Object.fromEntries(['projects', 'maps', 'layers', 'data_tables', 'project_datasets', 'recipes', 'recipe_steps', 'pg_connections']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all().map(row =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== "owner_id")))]));
}
export async function readLegacyPassword(directory, db) {
  const key = Buffer.from((await readFile(path.join(directory, 'secret.key'), 'utf8')).trim(), 'hex');
  const [iv, tag, ciphertext] = db.prepare('SELECT password_encrypted FROM pg_connections WHERE id = ?').get(legacy.connection).password_encrypted.split(':').map(value => Buffer.from(value, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
