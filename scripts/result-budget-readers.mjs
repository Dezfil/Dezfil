import assert from 'node:assert/strict';
import { boundary, bytesOf, cellBytes, resultBytes } from './result-budget-client.mjs';
import { sourceFixture } from './result-budget-source.mjs';

// Native, valid multipoints survive geometry-choice simplification. Expected
// compact GeoJSON sizes are defined here, independently of producer counters.
export function geometrySQL(bytes) {
  const prefix = '{"type":"MultiPoint","coordinates":[';
  const fixed = Buffer.byteLength(prefix) + 1;
  const points = Math.floor((bytes - fixed) / 6), extra = bytes - fixed - points * 6;
  assert.ok(points > 0 && extra >= 0 && extra < 6);
  const [x, y] = [[1, 1], [10, 1], [100, 1], [-100, 1], [-100, 10], [-100, -90]][extra];
  return `ST_GeomFromGeoJSON('${prefix}' || repeat('[0,0],', ${points - 1}) || '[${x},${y}]]}')`;
}
export function countriesSQL(postgres = false) {
  const other = Math.floor((12395238 - 1573724) / 257), second = 12395238 - 1573724 - other * 256;
  return `SELECT i::INTEGER AS id, CASE i WHEN 0 THEN ${geometrySQL(1573724)} WHEN 1 THEN ${geometrySQL(second)} ELSE ${geometrySQL(other)} END AS geometry FROM ${postgres ? 'generate_series(0,257)' : 'range(258)'} t(i)`;
}
const point = 'ST_Point(1,2) AS geometry';
const select = value => `SELECT ${value}, ${point}`;

export async function fourReaders(client) {
  const source = await sourceFixture(client);
  try {
    const readers = [
      { name: 'SQL GeoJSON', limit: 1000, rows: b => b.preview, geometry: r => r.geometry, read: sql => client.read('/api/query', { sql, geometry: 'geojson' }, 'SQL GeoJSON') },
      { name: 'SQL WKT', limit: 1000, rows: b => b.preview, geometry: r => r.geometry, read: sql => client.read('/api/query', { sql }, 'SQL WKT') },
      ...['inspection', 'geometry-choice'].map(name => ({ name, limit: 50,
        rows: b => name === 'inspection' ? b.preview : b.sample.features.features,
        geometry: r => r.geometry,
        read: async sql => {
          const table = await client.upload(`SELECT * REPLACE (ST_AsWKB(geometry) AS geometry) FROM (${sql}) q`);
          const path = `/api/tables/${encodeURIComponent(table.name)}`;
          try {
            if (name === 'inspection') return await client.read(path, undefined, name);
            const inspection = client.fitting(await client.read(`${path}/geometry`, undefined, 'geometry revision'));
            return await client.read(`${path}/geometry/preview`, { expectedRevision: inspection.revision, choice: { format: 'wkb', columns: ['geometry'], epsg: 4326 } }, name);
          } finally {
            const removed = await client.request(path, undefined, 'DELETE');
            assert.equal(removed.status, 204); await removed.body?.cancel();
            client.owned.splice(client.owned.indexOf(path), 1);
          }
        },
      })),
      { name: 'PostGIS', limit: 5, rows: b => b.rows, geometry: r => r.geometry, read: sql => source.preview(sql), postgres: true },
    ];
    for (const reader of readers) {
      const read = reader.read;
      // These are arrays to keep geometry-choice's existing scalar excerpts
      // out of the boundary oracle. The one cell includes brackets and quotes.
      for (const delta of [-1, 0, 1]) {
        const answer = await read(select(`ARRAY[repeat('x', ${cellBytes - 4 + delta})] AS v`));
        if (delta > 0) client.refused(answer);
        else {
          const body = client.fitting(answer);
          const row = reader.name === 'geometry-choice' ? body.sample.rows[0].values : reader.rows(body)[0];
          assert.equal(bytesOf(row.v), cellBytes + delta);
        }
      }
      const wide = tail => select(Array.from({ length: 17 }, (_, i) => `ARRAY[repeat('x', ${i === 16 ? tail : 2000000})] AS v${i}`).join(', '));
      await boundary(tail => read(wide(tail)), client, 1, reader.name);
      // Multi-byte, escaped, null, JSON, list and struct/object controls. JSON
      // remains a source value even when its content resembles geometry.
      client.fitting(await read(select(`'é' AS label, NULL::INTEGER AS missing, ARRAY['é', chr(10), '"'] AS nested, CAST('{"a":[1,null],"text":"é"}' AS JSON) AS object`)));
      client.fitting(await read(select(`repeat('x', 2000000) AS wide_text, CAST('{"value":"' || repeat('x', 2000000) || '"}' AS JSON) AS wide_json`)));
      client.refused(await read(select(`ARRAY[repeat(chr(10), 1048576)] AS escaped`)));
      client.refused(await read(select(`ARRAY[repeat('é', 1048576)] AS multibyte`)));
      client.refused(await read(select(`CAST('"' || repeat('x', 2097152) || '"' AS JSON) AS object`)));
      client.fitting(await read(select(Array.from({ length: 80 }, (_, i) => `'é"' AS "wide_${i}"`).join(', '))));
      // Native geometries retain the measured feature counts. Put each large
      // geometry first so every reader sees it within its unchanged row window.
      for (const size of [10151576, 6138709, 267502]) {
        const body = client.fitting(await read(`SELECT ${geometrySQL(size)} AS geometry`));
        const geometry = reader.geometry(reader.rows(body)[0]);
        if (typeof geometry !== 'string') assert.equal(bytesOf(geometry), size);
        else assert.match(geometry, /^MULTIPOINT/);
        console.log(JSON.stringify({ reader: reader.name, nativeGeometryControl: size, emittedGeometryBytes: bytesOf(geometry), envelopeBytes: bytesOf(body) }));
        if (size > cellBytes) {
          // Coordinate text inside a list is not excerpted and must refuse.
          client.refused(await read(select(`ARRAY[CAST(ST_AsGeoJSON(${geometrySQL(size)}) AS VARCHAR)] AS coordinate_text`)));
        }
      }
      const countries = client.fitting(await read(countriesSQL(reader.postgres)));
      assert.equal(reader.rows(countries).length, Math.min(reader.limit, 258));
      if (reader.name === 'SQL GeoJSON') {
        const sizes = countries.preview.map(row => bytesOf(row.geometry));
        assert.equal(sizes.reduce((a, b) => a + b, 0), 12395238); assert.equal(Math.max(...sizes), 1573724);
        assert.equal(countries.rowCount, 258); assert.equal(countries.previewTruncated, false);
      }
      client.refused(await read(`SELECT ${geometrySQL(10151576)} AS geometry FROM ${reader.postgres ? 'generate_series(1,4)' : 'range(4)'}`));
      console.log(`confirmed: ${reader.name} served cell/result boundaries, fitting controls and complete geometry refusal`);
    }
    for (const kind of ['geometry', 'geography']) {
      client.fitting(await source.preview(`SELECT ST_SetSRID(${geometrySQL(6138709)},4326)::${kind} AS geometry`));
    }
    await completeExports(client);
  } finally { await source.close(); }
}

async function completeExports(client) {
  const sql = "SELECT i::INTEGER AS id, repeat('x', 2097153) AS payload, ST_Point(0,0) AS geometry FROM range(20) t(i)";
  const table = await client.upload(`SELECT * REPLACE (ST_AsWKB(geometry) AS geometry) FROM (${sql}) q`, 'exports');
  const tablePath = `/api/tables/${encodeURIComponent(table.name)}`;
  client.refused(await client.read(tablePath));
  const map = await client.read('/api/maps', { name: `Budget exports ${table.id}` });
  assert.equal(map.status, 201); const mapPath = `/api/maps/${map.body.id}`;
  // Map deletion has a revision precondition; use its current revision in
  // unconditional cleanup, including when an export assertion fails.
  try {
    const layer = await client.read(`${mapPath}/layers`, { name: 'Complete exports', sql: `SELECT * FROM "${table.name}"`, }, 'create export layer', 'POST', { 'X-Edit-Revision': map.body.editRevision });
    assert.equal(layer.status, 201, JSON.stringify(layer.body));
    const id = layer.body.id;
    for (const [path, body] of [['/api/query/export', { sql, format: 'csv' }], [`${tablePath}/export?format=csv`], [`/api/layers/${id}/export/csv`]]) {
      const response = await client.request(path, body);
      assert.equal(response.status, 200, response.ok ? '' : await response.clone().text());
      let bytes = 0, lines = 0, xs = 0;
      for await (const chunk of response.body) { bytes += chunk.byteLength; for (const byte of chunk) { if (byte === 10) lines++; if (byte === 120) xs++; } }
      assert.ok(bytes > resultBytes); assert.equal(lines, 21); assert.equal(xs, 20 * 2097153);
      assert.equal(bytes, Number(response.headers.get('content-length')));
      console.log(JSON.stringify({ export: path, bytes, lines, xs, complete: true }));
    }
  } finally {
    const current = await client.read(mapPath);
    if (current.status === 200) {
      const removed = await client.request(mapPath, undefined, 'DELETE', { 'X-Edit-Revision': current.body.editRevision });
      assert.equal(removed.status, 204); await removed.body?.cancel();
    }
  }
}
