import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { closeMetadataDb } from '@/lib/metadata/db';
import { resetQueryInstance } from '@/lib/duckdb';
import { dispatchAssistantTestRoute } from '@/lib/assistant/testing/route-dispatch';
import { testClient } from '@/lib/mcp/test-client';
import { coreJourney, journeyClient } from '../../../scripts/mcp-journey-core.mjs';
afterEach(() => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('4b checks-lane scenario: grouped edits, legend and publication through real routes', async () => {
  await mkdir('.claude', { recursive: true }); const dir = await mkdtemp(`${process.cwd()}/.tmp-journey-`);
  vi.stubEnv('DEZFIL_DATA_DIR', dir); closeMetadataDb(); resetQueryInstance();
  const mutations: string[] = [];
  const client = await testClient(request => { if (!['GET', 'HEAD'].includes(request.method)) mutations.push(`${request.method} ${new URL(request.url).pathname}`); return dispatchAssistantTestRoute(request); });
  try {
    const journey = await journeyClient(client, async (url: string) => (await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`))).json());
    const result = await coreJourney(journey, { packageChecks: true });
    expect(mutations.filter(m => m === `POST /api/maps/${result.mapId}/publish`)).toHaveLength(1);
    expect(journey.exercised.has('undo_change')).toBe(true); expect(journey.exercised.has('redo_change')).toBe(true);
  } finally { await client.close(); closeMetadataDb(); resetQueryInstance(); await rm(dir, { recursive: true, force: true }); }
}, 30000);
