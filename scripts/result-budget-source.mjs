import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const lit = value => `'${value.replaceAll("'", "''")}'`;
const pq = value => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/** Outside fixture only. Resolve the pinned native client in the invoking
 * checkout or image, never add a dependency to the shipped runtime. */
export async function sourceFixture(client) {
  assert.ok(process.env.DEZFIL_TEST_PG_URL, '--full requires DEZFIL_TEST_PG_URL; missing arms never skip');
  const url = new URL(process.env.DEZFIL_TEST_PG_URL);
  if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'prefer');
  const { DuckDBInstance } = createRequire(path.join(process.cwd(), 'package.json'))('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:', process.env.DUCKDB_EXTENSION_DIR ? { extension_directory: process.env.DUCKDB_EXTENSION_DIR } : {});
  const conn = await instance.connect();
  const schema = `budget_${randomUUID().replaceAll('-', '')}`;
  const dsn = `host=${pq(url.hostname)} port=${url.port || 5432} dbname=${pq(decodeURIComponent(url.pathname.slice(1)))} user=${pq(decodeURIComponent(url.username))} password=${pq(decodeURIComponent(url.password))} sslmode=prefer`;
  let attached = false, created = false;
  const execute = async sql => conn.run(`CALL postgres_execute('budget_source', ${lit(sql)})`);
  async function close() {
    try { if (created) await execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { try { if (attached) await conn.run('DETACH budget_source'); } finally { conn.disconnectSync(); instance.closeSync(); } }
  }
  try {
    await conn.run('LOAD postgres');
    await conn.run(`ATTACH ${lit(dsn)} AS budget_source (TYPE postgres)`); attached = true;
    await execute(`CREATE SCHEMA ${schema}`); created = true;
    const saved = await client.read('/api/connections/postgis', { name: schema, url: url.toString() }, 'create owned source');
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const id = saved.body.id;
    assert.ok(id);
    client.owned.push(`/api/connections/postgis/${id}`);
    return { schema, execute, close, preview: async sql => {
      // Replacing only our owned fixture keeps source columns and five-row
      // behavior real. Column shapes may change between controls.
      await execute(`DROP VIEW IF EXISTS ${schema}.sample`);
      await execute(`CREATE VIEW ${schema}.sample AS ${sql}`);
      return client.read(`/api/connections/postgis/${id}/preview`, { schema, table: 'sample' }, 'PostGIS preview');
    } };
  } catch (error) { await close(); throw error; }
}
