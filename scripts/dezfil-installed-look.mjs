import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startLoopbackBasemap, assertBasemapTraffic } from './loopback-basemap.mjs';
import { decodePng } from './png-probe.mjs';

export async function installedLook(client, { call, gate }, renderLog) {
  assert.ok(renderLog, 'Real rendering requires the process launch observation file');
  const count = async () => (await readFile(renderLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.phase === 'launch').length;
  const fixture = await startLoopbackBasemap();
  let map;
  try {
    map = await call('create_map', { name: 'Installed map check' });
    const layer = await call('create_layer', { id: map.id, name: 'Observed point', sql: "SELECT ST_Point(0, 0) AS geometry, 'point' AS name" });
    const viewport = { lng: 0, lat: 0, zoom: 10, pitch: 0, bearing: 0 };
    await call('update_map', { id: map.id, viewport, customBasemap: { name: 'Loopback', url: fixture.styleUrl, force: true } });
    const trafficBefore = fixture.snapshot(10); const before = await count();
    // Image-result adaptation differs from ordinary JSON; inspect the actual wire.
    const result = await client.callTool({ name: 'look_at_map', arguments: { mapId: map.id, appearance: 'light' } });
    assert.equal(result.isError === true, false, JSON.stringify(result.structuredContent));
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.render.mapId, map.id); assert.equal(body.render.state.map, map.id);
    assert.equal(body.render.appearance, 'light'); assert.equal(body.render.state.appearance, 'light');
    assert.deepEqual(body.render.state.camera, viewport);
    assert.deepEqual(body.render.state.layers.map(value => value.id), [layer.id]);
    assert.ok(body.render.id && body.render.state.digest);
    const bytes = Buffer.from(body.image.content_base64, 'base64'); const image = decodePng(bytes);
    assert.ok([[1024, 640], [768, 480], [512, 320]].some(([w, h]) => image.width === w && image.height === h));
    assert.equal(bytes.length, body.image.bytes); assert.ok(bytes.length > 0 && bytes.length <= 384 * 1024);
    assert.deepEqual(result.structuredContent.result.image.content, { index: 0, type: 'text', jsonPointer: '/image/content_base64' });
    assert.equal(await count(), before + 1, 'exactly one real renderer launch');
    assertBasemapTraffic(fixture.delta(trafficBefore, 10));
    await call('update_map', { id: map.id, name: 'Changed after rendering' });
    for (const variant of ['full', 'thumbnail']) {
      const read = await client.callTool({ name: 'read_map_look_image', arguments: { renderId: body.render.id, variant } });
      assert.equal(read.isError === true, false, JSON.stringify(read.structuredContent));
      const native = read.content.find(content => content.type === 'image'); assert.ok(native); assert.equal(native.mimeType, 'image/png');
      const retrieved = Buffer.from(native.data, 'base64'); const decoded = decodePng(retrieved);
      if (variant === 'full') assert.deepEqual(retrieved, bytes);
      else assert.equal(decoded.width, 132);
      assert.equal(await count(), before + 1, 'retained image read starts no second render');
    }
    return { renderId: body.render.id, state: body.render.state.digest, width: image.width, height: image.height, bytes: bytes.length, launches: 1 };
  } finally { if (map) await gate('delete_map', { id: map.id }, true); await fixture.close(); }
}
