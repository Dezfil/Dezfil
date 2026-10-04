/** Maximal finite fields. Unbounded names, whitespace and escaping remain
 * subject to the separate wire-byte cap. Tests pin these counts to validators. */
export const FIXTURE_BOUNDS = { vertices: 10_000, svgBytes: 262_144, widgets: 12, values: 50, dimension: 4096 };
export const widgetIds = Array.from({ length: FIXTURE_BOUNDS.widgets }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
export const fields = Array.from({ length: 16 }, (_, i) => `field_${String(i).padStart(10, '0')}`);
export const viewerValues = Array.from({ length: 50 }, (_, i) => '雪'.repeat(30) + String(i).padStart(3, '0'));
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/>';
export const iconFixture = { viz: { type: 'icon', glyph: 'cafe', customSvg: svg + ' '.repeat(FIXTURE_BOUNDS.svgBytes - svg.length - 6) + '</svg>' } };
export const sketchFixture = { feature: { kind: 'line', geometry: { type: 'LineString', coordinates: Array.from({ length: FIXTURE_BOUNDS.vertices }, (_, i) => [(i % 2 ? -1 : 1) * 179.12345678901234, (i % 2 ? -1 : 1) * 89.12345678901234]) } } };
export const widgetFixture = { selections: widgetIds.map(widgetId => ({ widgetId, kind: 'exclude', values: Array.from({ length: 50 }, (_, i) => String(i).padStart(32, 'x')) })) };
export const extentFixture = { ...widgetFixture, timeline: { min: '2026-01-01T00:00:00.000Z', max: '2026-12-31T00:00:00.000Z' } };
export const renderFixture = width => ({ selections: fields.map(field => ({ field, kind: 'values', values: Array.from({ length: 200 }, (_, i) => String(i).padStart(width, 'x')) })) });
export const viewerFixture = { selections: fields.slice(0, 12).map(field => ({ field, kind: 'values', values: viewerValues })) };
export const exportFixture = { definition: {
  viewport: { lng: -540, lat: -85.051129, zoom: 24, pitch: 60, bearing: -360 }, size: { width: 4096, height: 4096 },
  legend: { visible: true, corner: 'top-left', size: 'xs' }, widgets: widgetIds, widgetSize: 'xs',
  title: { text: '雪'.repeat(200), size: 'xs' }, credit: { corner: 'bottom-right', size: 'xs' },
  basemapLayers: { labels: true, roads: true, borders: true, buildings: true, water: true, land: true }, appearance: 'light', mapScale: 1,
} };
export const fixtureBytes = value => Buffer.byteLength(JSON.stringify(value));
