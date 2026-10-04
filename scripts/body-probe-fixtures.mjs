import assert from 'node:assert/strict';
import { captureBasis } from './revision-fixtures.mjs';
import { sketchFixture, iconFixture, exportFixture, widgetFixture, extentFixture, renderFixture, viewerFixture, fields, viewerValues, widgetIds, fixtureBytes } from './body-fixtures.mjs';

export async function seedBodyFixtures(api, publicApi) {
  const accept = async (method, url, options, status = 200) => { const answer = await api(method, url, options); assert.equal(answer.status, status, `${method} ${url}: ${JSON.stringify(answer.json)}`); return answer.json; };
  // Deletion must reach its body reader, past the earlier self/active refusals.
  const invitation = await accept('POST', '/api/users', { body: { name: 'Body target', email: 'body-target@example.test' } }, 201);
  const map = await accept('POST', '/api/maps', {}, 201); // optional empty body
  const project = await accept('POST', '/api/projects', { body: { name: 'Body controls' } }, 201);
  const recipe = (await accept('POST', '/api/recipes', { body: { name: 'Body controls' } }, 201)).recipe;
  const step = await accept('POST', `/api/recipes/${recipe.id}/steps`, { body: { operation: 'sql_step', parameters: { name: 'body_control_output', sql: 'SELECT 1 AS value' } }, basis: captureBasis(recipe) }, 201);
  const form = new FormData();
  const csv = [...fields, 'lon', 'lat'].join(',') + '\n' + [...fields.map(() => viewerValues[0]), '1', '2'].join(',') + '\n' + [...fields.map(() => '0'.padStart(16, 'x')), '3', '4'].join(',') + '\n';
  form.append('file', new Blob([csv]), 'body_selections.csv');
  const table = await accept('POST', '/api/tables', { form }, 201);
  const currentMap = () => accept('GET', `/api/maps/${map.id}`);
  const edit = async (method, url, body, status = 200) => accept(method, url, { body, basis: captureBasis(await currentMap()) }, status);
  const layer = await edit('POST', `/api/maps/${map.id}/layers`, { name: 'Selection control', sql: `SELECT * FROM "${table.name}"` }, 201);
  await edit('PATCH', `/api/layers/${layer.id}`, { viz: { type: 'heatmap', radiusPx: 30, intensity: 1, weight: null }, publishedFields: fields });
  for (let i = 0; i < 8; i++) {
    const icon = await edit('POST', `/api/maps/${map.id}/layers`, { name: `Icon ${i}`, sql: `SELECT * FROM "${table.name}"` }, 201);
    await edit('PATCH', `/api/layers/${icon.id}`, iconFixture);
  }
  const sketch = await edit('POST', `/api/maps/${map.id}/sketches`, sketchFixture, 201);
  const widgets = widgetIds.map((id, i) => ({ id, type: 'category', layerId: layer.id, title: `Field ${i}`, field: fields[i], agg: 'count', aggField: null, unit: null, note: null, format: null, visible: true }));
  await edit('PATCH', `/api/maps/${map.id}`, { widgets, widgetsPublished: true });
  const complete = await currentMap();
  assert.ok(fixtureBytes(complete) > 8 * 262_144, 'complete map retains eight maximal icons');
  const exported = await api('POST', `/api/maps/${map.id}/export/image`, { body: exportFixture, raw: true });
  assert.equal(exported.status, 200, 'maximal export definition renders through its real operation');
  const png = Buffer.from(await exported.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.equal(png.readUInt32BE(16), 4096); assert.equal(png.readUInt32BE(20), 4096);
  const publication = await accept('POST', `/api/maps/${map.id}/publish`, { basis: captureBasis(await currentMap()) }, 201); // optional empty body
  const token = publication.token;
  for (const fixture of [viewerFixture, renderFixture(16), renderFixture(18)]) {
    const answer = await publicApi('POST', `/api/published/${token}/render/${layer.id}`, { body: fixture });
    assert.equal(answer.status, fixtureBytes(fixture) > 65_536 ? 413 : 200, JSON.stringify(answer.json));
    if (fixture === viewerFixture) { assert.equal(answer.json.ok, true); assert.equal(answer.json.geojson.features.length, 1, 'viewer maximum does useful filtering'); }
  }
  for (const [suffix, body] of [['widget-values', widgetFixture], [`extent/${layer.id}`, extentFixture]]) {
    const answer = await publicApi('POST', `/api/published/${token}/${suffix}`, { body }); assert.equal(answer.status, 200, JSON.stringify(answer.json));
  }
  for (const suffix of ['widget-values', `render/${layer.id}`, `extent/${layer.id}`]) assert.equal((await publicApi('POST', `/api/published/${token}/${suffix}`)).status, 200, 'optional empty selection body');
  return { userId: invitation.account.id, mapId: map.id, projectId: project.id, recipeId: recipe.id, stepId: step.step.id, layerId: layer.id, tableName: table.name, sketchName: sketch.table, featureId: sketch.featureId, token,
    bytes: { sketch: fixtureBytes(sketchFixture), icon: fixtureBytes(iconFixture), export: fixtureBytes(exportFixture), widgets: fixtureBytes(widgetFixture), extent: fixtureBytes(extentFixture), render16: fixtureBytes(renderFixture(16)), render18: fixtureBytes(renderFixture(18)), viewer: fixtureBytes(viewerFixture), completeMap: fixtureBytes(complete) } };
}

/** Invalid finite fields exercise parsing and validation without starting work. */
export const invalidBody = { name: 0, email: 0, password: 0, secret: 0, currentPassword: 0, isAdmin: 0, status: 0,
  sql: 0, geometry: 0, writtenIn: false, to: 0, role: 0, selections: 0, dims: 0, feature: 0, definition: 0, theme: 0,
  mapId: 0, attribute: 0, field: 0, kind: 0, palette: 0, label: 0, stops: 0, displayName: 0, url: 0, svg: 0, release: 0,
  operation: 0, parameters: { name: 0, sql: 0 }, fromLayerId: 0, ordinal: 'invalid', fromStepId: 0, steps: 0, notes: 0,
  addMaps: 0, maps: 0, expectedRevision: 0, choice: 0, connectionId: 0, schema: 0, table: 0, host: 0, message: 0 };
export function concreteBodyPath(template, fixture, account) {
  return template.replace(/\{([^}]+)\}/g, (_match, key) => encodeURIComponent(
    key === 'id' ? template.startsWith('/api/maps') ? fixture.mapId : template.startsWith('/api/layers') ? fixture.layerId : template.startsWith('/api/projects') ? fixture.projectId : template.startsWith('/api/recipes') ? fixture.recipeId : template.startsWith('/api/users') ? fixture.userId : 'absent-connection' :
    key === 'name' ? template.startsWith('/api/sketches') ? fixture.sketchName : fixture.tableName :
    key === 'layerId' ? fixture.layerId : key === 'stepId' ? fixture.stepId : key === 'featureId' ? fixture.featureId : key === 'token' ? fixture.token : key === 'sqlName' ? account.sqlName : (() => { throw new Error(`Uncovered body path parameter ${key}`); })()));
}
