import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { closeMetadataDb } from '@/lib/metadata/db';
import { resetQueryInstance, withConnection } from '@/lib/duckdb';
import { dispatchAssistantTestRoute } from '@/lib/assistant/testing/route-dispatch';
import { testClient } from '@/lib/mcp/test-client';
import { legendFor } from '@/lib/style/legend';
import { journeyClient } from '../../../scripts/mcp-journey-core.mjs';

const examples = new Map<string, string>();
for (const file of ['cartography', 'duckdb-spatial']) {
  const text = readFileSync(`plugins/dezfil/skills/dezfil/references/${file}.md`, 'utf8');
  for (const [, id, sql] of text.matchAll(/```sql\n-- example: ([\w-]+)\n([\s\S]*?)\n```/g)) examples.set(id, sql);
  expect([...text.matchAll(/```sql/g)]).toHaveLength([...text.matchAll(/-- example:/g)].length);
}
let dir: string;
let client: Awaited<ReturnType<typeof testClient>>;
let journey: Awaited<ReturnType<typeof journeyClient>>;
beforeAll(async () => {
  await mkdir('.claude', { recursive: true }); dir = await mkdtemp(`${process.cwd()}/.tmp-examples-`);
  vi.stubEnv('DEZFIL_DATA_DIR', dir); closeMetadataDb(); resetQueryInstance();
  client = await testClient(dispatchAssistantTestRoute);
  journey = await journeyClient(client, async (url: string) => (await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`))).json());
});
afterAll(async () => { await client?.close(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const run = (id: string) => journey.call('run_sql', { sql: examples.get(id)! });
it('3b flip availability: locked read-only SQL route flips longitude and latitude', async () => {
  const result = await journey.call('run_sql', { sql: "SELECT ST_AsText(ST_FlipCoordinates(ST_Point(13.4, 52.5))) AS flipped" });
  expect(result.preview).toEqual([{ flipped: 'POINT (52.5 13.4)' }]);
});
it('every shipped executable example is in the independent inventory', () => {
  expect([...examples.keys()].sort()).toEqual(['categorical', 'crossing', 'distance', 'empty-null', 'encoding', 'lonlat-spheroid', 'measurement', 'quantitative', 'units-axis']);
});
it('3b encoding: WKT, WKB, GeoJSON and quoted identifiers', async () => {
  expect((await run('encoding')).preview).toEqual([{ wkt: 'POINT (13.4 52.5)', wkb_roundtrip: 'POINT (13.4 52.5)', geojson_roundtrip: 'POINT (13.4 52.5)', 'label with space': 'quoted' }]);
});
it('3b crossing: exact intersection keeps the crossing feature and distinguishes containment', async () => {
  expect((await run('crossing')).preview).toEqual([{ id: 'crossing', wholly_within: false }, { id: 'inside', wholly_within: true }]);
});
it('3b distance: expanded candidates keep both nonoverlapping near boxes and exclude the near miss', async () => {
  expect((await run('distance')).preview).toEqual([{ id: 'near_east' }, { id: 'near_west' }]);
});
it('3b axis: known Berlin UTM easting and northing, independently bounded', async () => {
  const row = (await run('units-axis')).preview[0];
  expect(row.easting_m).toBeGreaterThan(391000); expect(row.easting_m).toBeLessThan(392000);
  expect(row.northing_m).toBeGreaterThan(5817000); expect(row.northing_m).toBeLessThan(5819000);
});
it('3b units: degree distance and spheroid metres remain distinct', async () => {
  const row = (await run('units-axis')).preview[0];
  expect(row.degrees).toBeCloseTo(0.004, 9);
  expect(row.geodesic_m).toBeGreaterThan(678); expect(row.geodesic_m).toBeLessThan(680);
});
it('3b stored lonlat: flipped geometry columns measure 678 to 680 metres', async () => {
  const row = (await run('lonlat-spheroid')).preview[0];
  expect(row.geodesic_m).toBeGreaterThan(678); expect(row.geodesic_m).toBeLessThan(680);
});
/** The shared `units` guidance now states that the spheroid functions
 * read latitude first. The counterexample makes the pair a control: the same
 * stored points, measured without the flip, answer a plausible number that is
 * not the distance. Recorded 1,106 m unflipped against 678 to 680 m flipped.
 * */
it('3b stored lonlat unflipped: the same points measure something else entirely', async () => {
  const sql = examples.get('lonlat-spheroid')!.replace(/ST_FlipCoordinates\((a|b)\.geometry\)/g, '$1.geometry');
  expect(sql).not.toContain('ST_FlipCoordinates');
  const unflipped = (await journey.call('run_sql', { sql })).preview[0].geodesic_m as number;
  expect(unflipped).toBeGreaterThan(1100); expect(unflipped).toBeLessThan(1115);
  const flipped = (await run('lonlat-spheroid')).preview[0].geodesic_m as number;
  expect(flipped).toBeGreaterThan(678); expect(flipped).toBeLessThan(680);
  expect(unflipped / flipped).toBeGreaterThan(1.5);
});
it('3b empty: empty geometry and invalid bowtie are distinct', async () => {
  const row = (await run('empty-null')).preview[0]; expect(row.empty).toBe(true); expect(row.valid).toBe(false);
});
it('3b null: unknown distance stays null and unknown predicate matches no rows', async () => {
  const row = (await run('empty-null')).preview[0]; expect(row.unknown_distance).toBeNull(); expect(Number(row.matches)).toBe(0);
});
it('3b measurement: exact local area aggregation and 3-4-5 length', async () => {
  const row = (await run('measurement')).preview[0];
  expect(Number(row.records)).toBe(2); expect(row.total_m2).toBe(30000); expect(row.mean_m2).toBe(15000); expect(row.length_m).toBe(5);
});
it('3a quantitative: stored field, method, palette, breaks, units and legend labels agree', async () => {
  expect((await run('quantitative')).preview.map((r: { area_ha: number }) => r.area_ha)).toEqual([0, 10, 20, 30, 40]);
  const map = await journey.call('create_map', { name: 'Quantitative example' });
  const layer = await journey.call('create_layer', { id: map.id, name: 'Areas', sql: examples.get('quantitative') });
  const fill = await journey.call('compute_fill', { id: layer.id, attribute: 'area_ha', method: 'equal', palette: 'viridis', classes: 2 });
  expect(fill).toMatchObject({ type: 'quantile', attribute: 'area_ha', method: 'equal', palette: 'viridis', breaks: [20] });
  await journey.call('update_layer', { id: layer.id, style: { ...layer.style, fill }, inLegend: true, legendTitle: 'Park area', legendAttrs: { fill: 'Area (ha)' }, legendLabels: ['Below 20 ha', '20 ha and above'] });
  const stored = await journey.call('get_layer', { id: layer.id });
  expect(stored).toMatchObject({ inLegend: true, legendTitle: 'Park area', legendAttrs: { fill: 'Area (ha)' }, legendLabels: ['Below 20 ha', '20 ha and above'] });
  expect(stored.style.fill).toEqual(fill);
  const legend = legendFor(stored.style)!; expect(legend.paints[0].attribute).toBe('area_ha');
  expect(legend.paints[0].entries.map(e => e.color)).toEqual(fill.colors);
  expect(legend.paints[0].entries.map(e => e.label)).toEqual(['< 20', '≥ 20']);
});
it('3a categorical: ten classes, fallback, corresponding labels and visibility', async () => {
  expect((await run('categorical')).rowCount).toBe(66);
  const map = await journey.call('create_map', { name: 'Category example' });
  const layer = await journey.call('create_layer', { id: map.id, name: 'Kinds', sql: examples.get('categorical') });
  const fill = await journey.call('compute_fill', { id: layer.id, attribute: 'kind', method: 'categorical', palette: 'tab10' });
  expect(fill.type).toBe('categorical'); expect(fill.palette).toBe('tab10'); expect(fill.attribute).toBe('kind');
  expect(fill.map.map((e: { value: string }) => e.value)).toEqual(Array.from({ length: 10 }, (_, i) => `kind_${i + 1}`));
  expect(fill.other).toEqual({ r: 120, g: 130, b: 150, a: 0.55 });
  const labels = [...Array.from({ length: 10 }, (_, i) => `Kind ${i + 1}`), 'Other kinds'];
  await journey.call('update_layer', { id: layer.id, style: { ...layer.style, fill }, inLegend: true, legendLabels: labels });
  const stored = await journey.call('get_layer', { id: layer.id }); expect(stored.style.fill).toEqual(fill); expect(stored.legendLabels).toEqual(labels);
  const entries = legendFor(stored.style)!.paints[0].entries;
  expect(entries.map(e => e.label)).toEqual([...Array.from({ length: 10 }, (_, i) => `kind_${i + 1}`), 'other']);
  expect(entries.at(-1)!.color).toEqual(fill.other);
  await journey.call('update_layer', { id: layer.id, inLegend: false });
  expect((await journey.call('get_layer', { id: layer.id })).inLegend).toBe(false);
  await journey.call('update_map', { id: map.id, legendCorner: 'top-right', legendOrder: [layer.id] });
  expect(await journey.call('get_map', { id: map.id })).toMatchObject({ legendCorner: 'top-right', legendOrder: [layer.id] });
});
it('3b provenance: record the actual engine and spatial extension versions', async () => {
  // Trusted connection is version census only; every example above uses run_sql.
  const versions = await withConnection(async conn => {
    const engine = (await conn.runAndReadAll('SELECT version() AS version')).getRowObjects();
    const extension = (await conn.runAndReadAll("SELECT extension_name, extension_version, loaded FROM duckdb_extensions() WHERE extension_name = 'spatial'")).getRowObjects();
    return { engine, extension };
  });
  expect(versions.extension).toHaveLength(1); expect(versions.extension[0].loaded).toBe(true);
  if (process.env.DEZFIL_PLUGIN_EVIDENCE) await writeFile(`${process.env.DEZFIL_PLUGIN_EVIDENCE}/engine-versions.json`, JSON.stringify(versions, null, 2) + '\n');
});
