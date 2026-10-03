import assert from 'node:assert/strict';
import { captureBasis, declaredToolArguments } from './revision-fixtures.mjs';
import { stationsCsv, parksCsv, matchingParkNames, refinedParkNames, distanceMetres, metricCrs } from './mcp-journey-fixtures.mjs';

/** Shared stock-client scenario. No model, provider, renderer or private stores. */
export async function journeyClient(client, readSubject, observe = () => {}) {
  const { tools } = await client.listTools();
  const offered = new Map(tools.map(tool => [tool.name, tool]));
  const exercised = new Set();
  async function call(name, args = {}, expectedCode, expectedHistory = null, basis) {
    args = declaredToolArguments(offered.get(name), args, basis);
    const wire = await client.callTool({ name, arguments: args });
    const text = wire.content.find(content => content.type === 'text')?.text;
    const body = text ? JSON.parse(text) : null;
    assert.equal(wire.isError === true, expectedCode !== undefined, `${name}: ${text}`);
    if (expectedCode) assert.equal(body.error.code, expectedCode);
    const adapted = body?.attachment ? { attachment: { filename: body.attachment.filename, content_type: body.attachment.content_type, size_bytes: body.attachment.size_bytes, content: { index: 0, type: 'text', jsonPointer: '/attachment/content_base64' } } } : body;
    assert.deepEqual(wire.structuredContent, { result: adapted, history: expectedHistory });
    exercised.add(name); observe({ name, args, wire });
    return body;
  }
  const at = (value, pointer) => pointer.split('.').filter(Boolean).reduce((v, key) => v?.[key], value);
  async function gate(name, args, approve, basis) {
    const tool = offered.get(name);
    assert.ok(tool, name);
    const fact = tool._meta['dezfil/confirmation'];
    const effects = tool._meta['dezfil/effects'];
    const planned = fact.policy === 'when_wide' ? await call(name, { ...args, [effects.planningArgument]: true }) : undefined;
    const plan = planned ? { ...planned.plan, editRevision: planned.editRevision } : undefined;
    const needed = fact.policy === 'required' || (fact.policy === 'when_wide' && plan.wide);
    let target;
    if (needed) {
      const subject = fact.subject;
      assert.ok(subject && fact.target && fact.consequence, 'confirmation facts offered');
      const url = subject.path.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(String(args[key])));
      let value = await readSubject(url);
      if (subject.collection !== undefined) value = at(value, subject.collection)?.find(item => item[subject.identity] === args[subject.argument]);
      target = fact.target.replace('{target}', String(at(value, subject.name)));
      assert.ok(!target.includes('undefined'), 'subject resolves a named target');
      if (!approve) return { declined: true, target, consequence: fact.consequence, plan };
    }
    const body = await call(name, { ...args, ...(plan ? { members: plan.members } : {}) }, undefined, null,
      plan?.editRevision ? captureBasis(plan) : basis);
    return { declined: false, target, consequence: fact.consequence, body };
  }
  return { call, gate, tools, exercised };
}
export const parkSql = (parks, stations) => `SELECT p.name, p.area_ha, p.geometry FROM "${parks}" p WHERE EXISTS (SELECT 1 FROM "${stations}" s WHERE ST_DWithin(ST_Transform(p.geometry, 'EPSG:4326', '${metricCrs}', always_xy := true), ST_Transform(s.geometry, 'EPSG:4326', '${metricCrs}', always_xy := true), ${distanceMetres}))`;
export async function coreJourney(journey, { packageChecks = false } = {}) {
  const { call, gate } = journey;
  const tables = [];
  let map;
  let mapBasis;
  // This scenario owns one map. Chain only its accepted write results.
  const edit = async (name, args, code, history = null) => {
    const result = await call(name, args, code, history, mapBasis);
    if (result?.editRevision) mapBasis = captureBasis(result);
    return result;
  };
  const editGate = async (name, args, approve) => {
    const result = await gate(name, args, approve, mapBasis);
    if (result.body?.editRevision) mapBasis = captureBasis(result.body);
    return result;
  };
  try {
    assert.equal((await call('check_health')).status, 'ready');
    const stations = await call('upload_table', { filename: 'mcp_stations.csv', content_base64: Buffer.from(stationsCsv).toString('base64') }); tables.push(stations.name);
    const parks = await call('upload_table', { filename: 'mcp_parks.csv', content_base64: Buffer.from(parksCsv).toString('base64') }); tables.push(parks.name);
    if (packageChecks) {
      const catalog = await call('list_tables');
      for (const name of tables) assert.ok(catalog.some(table => table.name === name));
      assert.deepEqual((await call('inspect_table', { name: stations.name })).preview.map(row => row.name).sort(), ['east', 'west']);
      assert.deepEqual((await call('inspect_table', { name: parks.name })).preview.map(row => row.name).sort(), ['east_inner', 'far', 'west_edge', 'west_inner', 'west_near_miss']);
    }
    const sql = parkSql(parks.name, stations.name);
    const names = result => result.preview.map(row => row.name).sort();
    assert.deepEqual(names(await call('run_sql', { sql })), matchingParkNames, 'fixed 500 metre identities include edge and exclude near miss');
    await call('run_sql', { sql: `DELETE FROM "${parks.name}"` }, 'sql_rejected');
    assert.equal(Number((await call('run_sql', { sql: `SELECT count(*) n FROM "${parks.name}"` })).preview[0].n), 5);
    map = await call('create_map', { name: 'MCP metric parks' });
    mapBasis = captureBasis(map);
    const creationGroup = packageChecks ? 'mcp_create' : 'mcp_metric';
    const layer = await edit('create_layer', { id: map.id, name: 'Parks within 500 metres', sql, change_group: creationGroup }, undefined, { mapId: map.id, group: creationGroup });
    const layerState = value => ({ id: value.id, sql: value.sql, style: value.style, inLegend: value.inLegend, legendTitle: value.legendTitle, legendAttrs: value.legendAttrs, legendLabels: value.legendLabels });
    const original = packageChecks ? layerState(await call('get_layer', { id: layer.id })) : null;
    const fill = await call('compute_fill', { id: layer.id, attribute: 'area_ha', method: 'quantile' });
    const size = await call('compute_scale', { id: layer.id, attribute: 'area_ha', range: [4, 28] });
    assert.deepEqual(size.domain, [10, 40]);
    const stroke = await call('compute_fill', { id: layer.id, attribute: 'area_ha', method: 'natural' });
    assert.equal(stroke.method, 'natural');
    const style = { ...layer.style, fill, strokeBy: stroke, pointRadiusBy: size };
    await edit('update_layer', { id: layer.id, style, change_group: 'mcp_metric' }, undefined, { mapId: map.id, group: 'mcp_metric' });
    const refined = `${sql} AND p.area_ha >= 20`;
    await edit('update_layer', { id: layer.id, sql: refined, change_group: 'mcp_metric' }, undefined, { mapId: map.id, group: 'mcp_metric' });
    if (packageChecks) await edit('update_layer', { id: layer.id, inLegend: true, legendTitle: 'Park area', legendAttrs: { fill: 'Area (ha)' }, change_group: 'mcp_metric' }, undefined, { mapId: map.id, group: 'mcp_metric' });
    const stored = await call('get_layer', { id: layer.id });
    assert.equal(stored.id, layer.id); assert.equal(stored.sql, refined); assert.deepEqual(stored.style, style);
    assert.deepEqual(names(await call('run_sql', { sql: stored.sql })), refinedParkNames);
    const rendered = await call('render_layer', { id: layer.id });
    assert.deepEqual(rendered.geojson.features.map(feature => feature.properties.name).sort(), refinedParkNames);
    const stats = await call('get_field_stats', { id: layer.id, field: 'area_ha' });
    assert.equal(stats.min, 20); assert.equal(stats.max, 40); assert.equal(stats.bins.reduce((a, b) => a + b, 0), 2);
    const fields = await call('list_layer_fields', { id: layer.id });
    assert.equal(fields.filterable.find(field => field.name === 'area_ha').kind, 'numeric');
    const data = await call('export_layer_data', { id: layer.id, format: 'geoparquet' });
    const parquet = Buffer.from(data.attachment.content_base64, 'base64');
    assert.equal(parquet.subarray(0, 4).toString('latin1'), 'PAR1'); assert.equal(parquet.length, data.attachment.size_bytes);
    const history = await call('get_history', { id: map.id });
    assert.deepEqual({ canUndo: history.canUndo, canRedo: history.canRedo }, { canUndo: true, canRedo: false });
    assert.match(history.editRevision, /^[0-9a-f]{32}$/);
    assert.equal(history.undoTarget.eligible, true); assert.equal(history.redoTarget, null);
    if (packageChecks) {
      assert.equal(stored.inLegend, true); assert.equal(stored.legendTitle, 'Park area'); assert.deepEqual(stored.legendAttrs, { fill: 'Area (ha)' });
      await edit('undo_change', { id: map.id });
      assert.deepEqual(layerState(await call('get_layer', { id: layer.id })), original, 'grouped undo restores SQL, style and legend together');
      const undone = await call('get_history', { id: map.id });
      assert.deepEqual({ canUndo: undone.canUndo, canRedo: undone.canRedo }, { canUndo: true, canRedo: true });
      assert.notEqual(undone.editRevision, history.editRevision);
      assert.equal(undone.redoTarget.eligible, true);
      await edit('redo_change', { id: map.id });
      assert.deepEqual(layerState(await call('get_layer', { id: layer.id })), layerState(stored), 'grouped redo restores the same layer state');
      assert.deepEqual(names(await call('run_sql', { sql: stored.sql })), refinedParkNames);
    }
    const declined = await editGate('publish_map', { id: map.id }, false);
    assert.equal(declined.declined, true); assert.equal(declined.target, 'Publish MCP metric parks?');
    assert.equal((await call('get_map', { id: map.id })).publishToken, null);
    const published = await editGate('publish_map', { id: map.id }, true);
    assert.ok(published.body.token);
    const view = await call('view_published_map', { token: published.body.token });
    assert.equal(view.layers[0].id, layer.id);
    await editGate('unpublish_map', { id: map.id }, true);
    await call('view_published_map', { token: published.body.token }, 'not_found');
    return { mapId: map.id, layerId: layer.id, names: matchingParkNames, refined: refinedParkNames };
  } finally {
    if (map) await editGate('delete_map', { id: map.id }, true);
    for (const name of tables.reverse()) await gate('delete_table', { name }, true);
  }
}
export async function pollRun(call, name, args, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { run } = await call(name, args);
    if (Object.hasOwn(run, 'outcome') ? run.outcome !== null : !['queued', 'running'].includes(run.state)) return run;
    assert.ok(Date.now() < deadline, `${name} terminal deadline`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
export async function newerJourney(journey, sourceUrl) {
  const { call, gate } = journey;
  const imported = await call('import_table_from_url', { url: sourceUrl, name: 'mcp_imported' });
  const table = imported.tables?.[0] ?? imported;
  assert.equal(table.rowCount, 1);
  assert.equal((await call('inspect_table', { name: table.name })).preview[0].name, 'remote_fixture');
  const accepted = await call('run_operation', { operation: 'buffer', parameters: { input: table.name, distance: 100, name: 'mcp_buffer' } });
  assert.ok(accepted.run.id); assert.ok(['queued', 'running'].includes(accepted.run.state));
  const run = await pollRun(call, 'get_operation_run', { id: accepted.run.id });
  assert.equal(run.state, 'succeeded');
  const output = await call('run_sql', { sql: 'SELECT name, ST_GeometryType(geometry)::VARCHAR kind FROM mcp_buffer' });
  assert.equal(output.rowCount, 1); assert.equal(output.preview[0].name, 'remote_fixture'); assert.equal(output.preview[0].kind, 'POLYGON');
  const recipe = (await call('create_recipe', { name: 'MCP diagnosis' })).recipe;
  const firstResult = await call('add_recipe_step', { id: recipe.id, operation: 'sql_step', parameters: { name: 'mcp_broken', sql: 'SELECT missing_column FROM mcp_imported' } }, undefined, null, captureBasis(recipe));
  const first = firstResult.step;
  const nextResult = await call('add_recipe_step', { id: recipe.id, operation: 'sql_step', parameters: { name: 'mcp_downstream', sql: 'SELECT * FROM mcp_broken' } }, undefined, null, captureBasis(firstResult));
  const next = nextResult.step;
  const declined = await gate('run_recipe', { id: recipe.id }, false, captureBasis(nextResult));
  assert.equal(declined.declined, true); assert.equal(declined.target, 'Run MCP diagnosis?');
  assert.equal((await call('list_recipe_runs', { id: recipe.id })).runs.length, 0);
  const started = await gate('run_recipe', { id: recipe.id }, true, captureBasis(nextResult));
  const diagnosed = await pollRun(call, 'get_recipe_run', { id: recipe.id, runId: started.body.run.id });
  assert.equal(diagnosed.outcome, 'failed');
  const failed = diagnosed.members.find(member => member.stepId === first.id);
  const unstarted = diagnosed.members.find(member => member.stepId === next.id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.attempt.error.code, 'sql_error');
  assert.equal(unstarted.state, 'not_run'); assert.equal(unstarted.jobId, null);
  const catalogue = await call('list_tables');
  assert.ok(!catalogue.some(t => ['mcp_broken', 'mcp_downstream'].includes(t.name)));
  const removalBasis = captureBasis(await call('get_recipe', { id: recipe.id }));
  await gate('delete_recipe', { id: recipe.id }, true, removalBasis);
  await gate('delete_table', { name: 'mcp_buffer' }, true);
  await gate('delete_table', { name: table.name }, true);
}
