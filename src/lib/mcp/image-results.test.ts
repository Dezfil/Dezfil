import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookRetention } from '@/lib/export/look-retention';
import { setLookDriverForTests, type LookResult } from '@/lib/export/map-look';
import { encodePng } from '@/lib/export/png-codec';
import { thumbnailOf } from '@/lib/export/look-thumbnail';
import { GET as readImage } from '@/app/api/maps/look/[renderId]/route';
import { testClient } from './test-client';
let launches = 0;
beforeEach(() => {
  lookRetention.resetForTests(); launches = 0;
  setLookDriverForTests({ launch: async () => { launches++; throw new Error('Unexpected renderer launch'); } });
});
afterEach(() => { lookRetention.resetForTests(); setLookDriverForTests(null); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function retained(id: string): LookResult {
  const png = encodePng({ width: 32, height: 20, rgba: Uint8Array.from({ length: 32 * 20 * 4 }, (_, i) => i % 256) });
  return { id, mapId: 'map', mapName: 'Fixture', appearance: 'light',
    state: { map: 'map', camera: { lng: 0, lat: 0, zoom: 1, pitch: 0, bearing: 0 }, layers: [], legend: { visible: false, corner: 'bottom-left', order: [] }, widgets: [], appearance: 'light', digest: 'fixture' },
    image: { width: 32, height: 20, bytes: png.byteLength, png }, thumbnail: thumbnailOf({ width: 32, height: 20, png }),
    source: { width: 32, height: 20 }, attribution: '', composition: { failures: [], abandoned: [] }, elapsedMs: 1 };
}
const connect = () => testClient(request => readImage(request, { params: Promise.resolve({ renderId: new URL(request.url).pathname.split('/').at(-1)! }) }));
describe('retained image transport through the actual read route', () => {
  it.each(['full', 'thumbnail'] as const)('%s travels byte-true with actual media and two byte copies', async variant => {
    const source = retained('retained-source'); lookRetention.retain(source);
    const expected = variant === 'full' ? source.image.png : source.thumbnail.png;
    const client = await connect();
    try {
      const result = await client.callTool({ name: 'read_map_look_image', arguments: { renderId: source.id, variant } });
      expect(result.isError ?? false).toBe(false);
      const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
      const legacy = JSON.parse(content[0].text!).attachment;
      expect(Buffer.from(legacy.content_base64, 'base64')).toEqual(Buffer.from(expected));
      expect(content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: legacy.content_base64 });
      expect(JSON.stringify(result.structuredContent)).not.toContain(legacy.content_base64);
      expect(JSON.stringify(result).split(legacy.content_base64)).toHaveLength(3);
      expect(launches).toBe(0);
    } finally { await client.close(); }
  });
  for (const departure of ['eviction', 'process-state reset'] as const) it(`${departure} refuses both variants with no render`, async () => {
    const source = retained('gone-source'); lookRetention.retain(source);
    expect(lookRetention.read(source.id, 'full')).not.toBeNull();
    if (departure === 'eviction') lookRetention.evictForTests(source.id); else lookRetention.resetForTests();
    const client = await connect();
    try {
      for (const variant of ['full', 'thumbnail']) {
        const result = await client.callTool({ name: 'read_map_look_image', arguments: { renderId: source.id, variant } });
        expect(result.isError).toBe(true);
        expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ error: { code: 'look_image_unavailable' } });
      }
      expect(launches).toBe(0);
    } finally { await client.close(); }
  });
});
