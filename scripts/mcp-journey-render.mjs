import assert from 'node:assert/strict';
import { startLoopbackBasemap, assertBasemapTraffic } from './loopback-basemap.mjs';
import { decodePng, countColored } from './png-probe.mjs';
/** Optional actual-render arm. A transport fixture never counts as this arm. */
export async function renderJourney({ call, gate }) {
  const started = Date.now();
  const fixture = await startLoopbackBasemap();
  let map, table;
  try {
    table = await call('upload_table', { filename: 'mcp_render.csv', content_base64: Buffer.from('name,lon,lat\nrender,0,0\n').toString('base64') });
    map = await call('create_map', { name: 'MCP render arm' });
    await call('create_layer', { id: map.id, name: 'Render point', sql: `SELECT * FROM "${table.name}"` });
    await call('update_map', { id: map.id, customBasemap: { url: fixture.styleUrl, name: 'Loopback fixture', force: true } });
    const definition = { viewport: { lng: 0, lat: 0, zoom: 10, pitch: 0, bearing: 0 }, size: { width: 480, height: 320 }, legend: { visible: false, corner: 'bottom-left', size: 'm' }, widgets: [], title: null, appearance: 'light', overlayScale: 2 };
    const before = fixture.snapshot(10);
    const result = await call('export_map_image', { id: map.id, definition });
    const image = decodePng(Buffer.from(result.attachment.content_base64, 'base64'));
    assert.equal(image.width, 480); assert.equal(image.height, 320); assert.ok(countColored(image) > 20);
    assertBasemapTraffic(fixture.delta(before, 10));
    console.log(JSON.stringify({ arm: 'real-render', elapsedMs: Date.now() - started }));
  } finally {
    if (map) await gate('delete_map', { id: map.id }, true);
    if (table) await gate('delete_table', { name: table.name }, true);
    await fixture.close();
  }
}
