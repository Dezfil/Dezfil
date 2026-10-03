import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { Client } from '@modelcontextprotocol/client';
import { closeMetadataDb } from '@/lib/metadata/db';
import { resetQueryInstance } from '@/lib/duckdb';
import { dispatchAssistantTestRoute } from '@/lib/assistant/testing/route-dispatch';
import { testClient } from './test-client';
import { journeyClient } from '../../../scripts/mcp-journey-core.mjs';

let dir: string, client: Client;
beforeEach(async () => {
  await mkdir('.claude', { recursive: true });
  dir = await mkdtemp(`${process.cwd()}/.tmp-conformance-`);
  vi.stubEnv('DEZFIL_DATA_DIR', dir);
  vi.stubEnv('DEZFIL_PREVIEW_ROWS', undefined);
  closeMetadataDb(); resetQueryInstance();
  client = await testClient(dispatchAssistantTestRoute);
});
afterEach(async () => {
  await client?.close(); closeMetadataDb(); resetQueryInstance();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
const journey = () => journeyClient(client, async (path: string) => {
  const response = await dispatchAssistantTestRoute(new Request(`http://localhost:3307${path}`));
  expect(response.ok).toBe(true); return response.json();
});

it('real publication, sketch and prepared/binary export branches conform to the listed output contract', async () => {
  const { call } = await journey();
  const project = await call('create_project', { name: 'Conformance' });
  const map = await call('create_map', { name: 'Conformance', projectId: project.id });
  expect(await call('get_publication_state', { id: map.id })).toBeNull();
  const publication = await call('publish_map', { id: map.id, expected_revision: map.editRevision });
  expect(await call('get_publication_state', { id: map.id })).toMatchObject({ token: publication.token });
  const sketch = await call('create_sketch', { id: map.id, expected_revision: publication.editRevision, feature: {
    kind: 'polygon', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  } });
  expect(await call('move_sketch_vertex', { name: sketch.table, featureId: sketch.featureId, vertexIndex: 1, position: [0.5, 0] })).toEqual({ rowCount: 1 });
  expect(await call('delete_sketch_feature', { name: sketch.table, featureId: sketch.featureId })).toEqual({ rowCount: 0 });
  for (const [name, args] of [
    ['export_sql_result', { sql: 'SELECT 207 AS n', format: 'csv' }],
    ['export_project', { id: project.id, maps: [map.id] }],
  ] as const) {
    const prepared = await call(name, { ...args, prepare: true });
    expect(prepared.ticket).toEqual(expect.any(String));
    expect(prepared.key).toEqual(expect.any(String));
    if (name === 'export_project') expect(prepared.filename).toMatch(/\.zip$/);
    else expect(prepared.format).toBe('csv');
    const direct = await call(name, args);
    const bytes = Buffer.from(direct.attachment.content_base64, 'base64');
    expect(bytes.length).toBe(direct.attachment.size_bytes);
    expect(bytes.subarray(0, 2).toString()).toBe(name === 'export_project' ? 'PK' : 'n\n');
    if (name === 'export_sql_result') expect(bytes.toString()).toBe('n\n207\n');
  }
}, 30_000);

it('real default and configured previews retain one logical row set and the exact total', async () => {
  const { call } = await journey();
  const standard = await call('run_sql', { sql: 'SELECT range AS n FROM range(1001)' });
  expect(standard.rowCount).toBe(1001); expect(standard.preview).toHaveLength(1000);
  expect(standard.previewTruncated).toBe(true);
  expect(new Set(standard.preview.map((row: { n: number }) => row.n)).size).toBe(1000);
  vi.stubEnv('DEZFIL_PREVIEW_ROWS', '2');
  const configured = await call('run_sql', { sql: 'SELECT range AS n FROM range(3)' });
  expect(configured.rowCount).toBe(3); expect(configured.preview).toEqual([{ n: '0' }, { n: '1' }]);
  expect(configured.previewTruncated).toBe(true);
});
