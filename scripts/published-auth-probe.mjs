import { captureBasis } from './revision-fixtures.mjs';
// Checks the anonymous projection with real data and tiles, without a browser.
import assert from 'node:assert/strict';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';

export async function publishedAuthProbe(base) {
  const credential = await provisionJourney(base), api = journeyApi(base, { token: credential.token });
  const anonymous = journeyApi(base);
  const map = await api('POST', '/api/maps', { body: { name: 'Anonymous data and tiles' } }); assert.equal(map.status, 201);
  const layer = await api('POST', `/api/maps/${map.json.id}/layers`, { basis: captureBasis((await api('GET', `/api/maps/${map.json.id}`)).json), body: { name: 'Filtered points', sql: "SELECT * FROM (VALUES ('a', 10, 20), ('b', 11, 21)) p(name, x, y) CROSS JOIN LATERAL (SELECT ST_Point(x, y) AS geometry)" } }); assert.equal(layer.status, 201);
  assert.equal((await api('PATCH', `/api/layers/${layer.json.id}`, { basis: captureBasis((await api('GET', `/api/layers/${layer.json.id}`)).json), body: { viz: { type: 'cluster', radiusPx: 64, color: 'fixed', showCounts: true } } })).status, 200);
  const defaults = { layerId: layer.json.id, agg: 'count', aggField: null, unit: null, note: null, format: null, visible: true };
  const shown = await api('GET', `/api/maps/${map.json.id}`);
  assert.equal((await api('PATCH', `/api/maps/${map.json.id}`, { basis: captureBasis(shown.json), body: { widgetsPublished: true, widgets: [
    { ...defaults, id: 'category', type: 'category', title: 'Names', field: 'name' },
    { ...defaults, id: 'count', type: 'formula', title: 'Count', field: null },
  ] } })).status, 200);
  const tiled = await api('POST', `/api/maps/${map.json.id}/layers`, { basis: captureBasis((await api('GET', `/api/maps/${map.json.id}`)).json), body: { name: 'Tiled points', sql: 'SELECT i, ST_Point(10 + (i % 49) * 0.001, 20 + floor(i / 49) * 0.001) AS geometry FROM range(2401) AS p(i)' } }); assert.equal(tiled.status, 201);
  let render;
  const deadline = Date.now() + 120_000;
  do {
    render = await api('GET', `/api/layers/${tiled.json.id}/render`);
    if (render.json.tiles?.state !== 'building') break;
    if (Date.now() > deadline) throw new Error('Tiles did not settle');
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (true);
  assert.equal(render.json.mode, 'tiled', 'use DEZFIL_RENDER_CAP_FEATURES=2000');
  assert.equal(render.json.tiles.state, 'ready');
  const publication = await api('POST', `/api/maps/${map.json.id}/publish`); assert.equal(publication.status, 201);
  const token = publication.json.token;
  const view = await anonymous('GET', `/api/published/${token}`); assert.equal(view.status, 200);
  assert.equal(view.json.widgets.length, 2);
  if (process.env.DEZFIL_BASEMAP_URL) assert.equal(view.json.basemapUrl, process.env.DEZFIL_BASEMAP_URL);
  const selections = [{ widgetId: 'category', kind: 'exclude', values: ['b'] }];
  const values = await anonymous('POST', `/api/published/${token}/widget-values`, { body: { selections } }); assert.equal(values.status, 200);
  assert.equal(values.json.widgets.find(widget => widget.id === 'count').value, 1);
  const extent = await anonymous('POST', `/api/published/${token}/extent/${layer.json.id}`, { body: { selections } }); assert.equal(extent.status, 200);
  assert.deepEqual(extent.json.box, [10, 20, 10, 20]);
  const filtered = await anonymous('POST', `/api/published/${token}/render/${layer.json.id}`, { body: { selections: [{ field: 'name', kind: 'values', values: ['a'] }] } }); assert.equal(filtered.status, 200);
  assert.equal(filtered.json.geojson.features.length, 1);
  const tiles = view.json.layers.find(value => value.id === tiled.json.id).render.tiles;
  const url = tiles.url.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');
  assert.ok(url.startsWith(`/api/published/${token}/tiles/`));
  const tile = await anonymous('GET', url, { raw: true }); assert.equal(tile.status, 200); assert.ok((await tile.arrayBuffer()).byteLength > 0);
  const ownTile = await api('GET', render.json.tiles.url.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'), { raw: true });
  assert.equal(ownTile.status, 200); assert.equal(ownTile.headers.get('cache-control'), 'private, no-store'); await ownTile.body?.cancel();
  const privateTile = await anonymous('GET', render.json.tiles.url.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'), { raw: true }); assert.equal(privateTile.status, 401); await privateTile.body?.cancel();
  assert.equal((await api('DELETE', `/api/maps/${map.json.id}/publish`, { raw: true })).status, 200);
  assert.equal((await anonymous('GET', url, { raw: true })).status, 404);
  assert.equal((await api('GET', `/api/maps/${map.json.id}`)).json.widgets.length, 2, 'reader selections did not rewrite the map');
  console.log('confirmed: anonymous configured basemap projection, widgets, selection extent, filtered data, real MVT bytes; private tiles and revoked published tiles refused');
}
if (process.argv[1]?.endsWith('/published-auth-probe.mjs')) await publishedAuthProbe(process.argv[2]);
