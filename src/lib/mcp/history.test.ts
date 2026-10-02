import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { closeMetadataDb, metadataDb } from '@/lib/metadata/db';
import { resetQueryInstance } from '@/lib/duckdb';
import { ingestFile } from '@/lib/ingest/ingest';
import { createMap } from '@/lib/map-service';
import { createLayer } from '@/lib/layer-service';
import { dispatchAssistantTestRoute } from '@/lib/assistant/testing/route-dispatch';
import { testClient } from './test-client';
import type { Client } from '@modelcontextprotocol/client';
let dir: string, client: Client, mapId: string, layerId: string;
let seen: Request[];
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), '.claude'), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), '.tmp-history-'));
  vi.stubEnv('DEZFIL_DATA_DIR', dir);
  closeMetadataDb(); resetQueryInstance();
  const csv = path.join(dir, 'facts.csv'); await writeFile(csv, 'name,lon,lat\na,0,0\n'); await ingestFile(testAccountScope(), csv, 'facts.csv');
  mapId = createMap(testAccountScope(), 'Original').id;
  layerId = (await createLayer(testAccountScope(), mapId, { name: 'Layer', sql: 'SELECT * FROM facts' })).id;
  metadataDb().prepare('DELETE FROM map_history').run();
  seen = [];
  client = await testClient(request => { seen.push(request.clone()); return dispatchAssistantTestRoute(request); });
});
afterEach(async () => {
  await client?.close(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
const steps = () => metadataDb().prepare('SELECT map_id AS mapId, group_id AS groupId, scope, op FROM map_history ORDER BY seq').all();
const call = async (name: string, args: Record<string, unknown> = {}) => await client.callTool({ name, arguments: args }) as Awaited<ReturnType<Client['callTool']>> & { structuredContent?: { history?: unknown } };
const body = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((result.content as { text: string }[])[0].text);

describe('external group association', () => {
  for (const name of ['update_map', 'create_layer', 'update_layer', 'delete_layer', 'duplicate_layer']) {
    it(`${name}: valid group forwards and matches stored history`, async () => {
      const args = name === 'update_map' ? { id: mapId, name: 'Renamed' } : name === 'create_layer' ? { id: mapId, name: 'Added', sql: 'SELECT * FROM facts' } : name === 'update_layer' ? { id: layerId, name: 'Renamed' } : { id: layerId };
      const result = await call(name, {...(name === 'update_map' ? { expected_revision: readEditRevision({ kind: "map", id: mapId })?.editRevision } : {}),  ...args, change_group: 'external_group' });
      expect(result.isError ?? false).toBe(false);
      expect(seen.some(request => request.method !== 'GET' && request.headers.get('X-Change-Group') === 'external_group')).toBe(true);
      expect(steps()).toEqual([expect.objectContaining({ mapId, groupId: 'external_group' })]);
      expect(result.structuredContent?.history).toEqual({ mapId, group: 'external_group' });
    });
    it(`${name}: invalid group dispatches nothing`, async () => {
      const result = await call(name, { id: name === 'create_layer' || name === 'update_map' ? mapId : layerId, name: 'Changed', sql: 'SELECT * FROM facts', change_group: 'bad group' });
      expect(result.isError).toBe(true);
      expect(seen).toHaveLength(0);
      expect(steps()).toEqual([]);
    });
  }
  it('an omitted marker has explicit absent association and an ungrouped step', async () => {
    const result = await call('update_map', {expected_revision: readEditRevision({ kind: "map", id: mapId })?.editRevision,  id: mapId, name: 'Ungrouped' });
    expect(steps()).toEqual([expect.objectContaining({ groupId: null })]);
    expect(result.structuredContent?.history).toBeNull();
  });
  it('an internally grouped duplicate without a supplied marker has no association', async () => {
    const result = await call('duplicate_layer', { id: layerId });
    expect(result.isError ?? false).toBe(false);
    expect(steps()).toHaveLength(1);
    expect(result.structuredContent?.history).toBeNull();
  });
  it('history tools expose only map identity, with no selective group control', async () => {
    const { tools } = await client.listTools();
    for (const name of ['get_history', 'undo_change', 'redo_change']) {
      expect(Object.keys(tools.find(tool => tool.name === name)!.inputSchema.properties!)).toEqual(['id']);
    }
  });
  it('a no-op has association but no history step', async () => {
    const result = await call('update_map', {expected_revision: readEditRevision({ kind: "map", id: mapId })?.editRevision,  id: mapId, name: 'Original', change_group: 'noop' });
    expect(steps()).toEqual([]);
    expect(result.structuredContent?.history).toEqual({ mapId, group: 'noop' });
  });
  it('a failed call has no association or step', async () => {
    const result = await call('update_map', {expected_revision: readEditRevision({ kind: "map", id: 'missing' })?.editRevision,  id: 'missing', name: 'Failed', change_group: 'failure' });
    expect(result.isError).toBe(true);
    expect(steps()).toEqual([]);
    expect(result.structuredContent?.history).toBeNull();
  });
  it('publication is outside this history association', async () => {
    const result = await call('publish_map', { id: mapId });
    expect(result.isError ?? false).toBe(false);
    expect(steps()).toEqual([]);
    expect(result.structuredContent?.history).toBeNull();
  });
  it('two maps and a manual interleaving have independent literal undo/redo states', async () => {
    const other = createMap(testAccountScope(), 'Other').id;
    await call('update_map', {expected_revision: readEditRevision({ kind: "map", id: mapId })?.editRevision,  id: mapId, name: 'First', change_group: 'shared' });
    await call('update_map', {expected_revision: readEditRevision({ kind: "map", id: other })?.editRevision,  id: other, name: 'Other changed', change_group: 'shared' });
    await call('update_map', {expected_revision: readEditRevision({ kind: "map", id: mapId })?.editRevision,  id: mapId, name: 'Manual' });
    await call('update_map', {expected_revision: readEditRevision({ kind: "map", id: mapId })?.editRevision,  id: mapId, name: 'Last', change_group: 'shared' });
    expect(steps().filter(row => (row as { mapId: string }).mapId === mapId)).toEqual([
      expect.objectContaining({ mapId, groupId: 'shared' }),
      expect.objectContaining({ mapId, groupId: null }), expect.objectContaining({ mapId, groupId: 'shared' }),
    ]);
    expect(steps().filter(row => (row as { mapId: string }).mapId === other)).toEqual([expect.objectContaining({ mapId: other, groupId: 'shared' })]);
    for (const expected of ['Manual', 'First', 'Original']) {
      const result = await call('undo_change', { id: mapId }); expect(body(result).name).toBe(expected);
      expect(result.structuredContent?.history).toBeNull();
      expect(body(await call('get_map', { id: other })).name).toBe('Other changed');
    }
    for (const expected of ['First', 'Manual', 'Last']) expect(body(await call('redo_change', { id: mapId })).name).toBe(expected);
    expect(body(await call('undo_change', { id: other })).name).toBe('Other');
    expect(body(await call('redo_change', { id: other })).name).toBe('Other changed');
    expect(body(await call('get_history', { id: mapId }))).toMatchObject({ canUndo: true, canRedo: false });
  });
});
