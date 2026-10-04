// Runs inside the app container. Uses the published save/export routes.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { captureBasis } from './revision-fixtures.mjs';
import { countColored, countPixels, decodePng } from './png-probe.mjs';
import { readRows, privateAddress } from './render-egress-assert.mjs';

const directory = process.env.PROBE_EVIDENCE;
const arm = JSON.parse(await readFile(`${directory}/active.json`, 'utf8'));
const result = { arm: arm.id, saved: false, png: null };
const base = 'http://127.0.0.1:3187';
const phase = async phase => {
  await writeFile(`${directory}/active.next.json`, JSON.stringify({ ...arm, phase }));
  await rename(`${directory}/active.next.json`, `${directory}/active.json`);
};
async function liveListener(file, url) {
  const live = await fetch(url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(3000) });
  assert.equal(live.status, 200);
  const liveBody = await live.text();
  let rows;
  for (let i = 0; i < 60; i++) {
    rows = readRows(await readFile(`${directory}/${file}.ndjson`, 'utf8'));
    const request = rows.find(row => row.phase === 'live' && row.event === 'request' && row.path === '/live');
    if (request && rows.some(row => row.event === 'close' && row.socket === request.socket)) {
      return { liveBody };
    }
    await delay(50);
  }
  throw new Error(`${file} liveness connection did not close`);
}
try {
  const credentials = await provisionJourney(base);
  const api = journeyApi(base, { token: credentials.token });
  const form = new FormData();
  form.append('file', new Blob(['name,lon,lat\na,13.41,52.52\nb,13.40,52.53\nc,13.33,52.51\n'], { type: 'text/csv' }), 'egress_points.csv');
  const uploaded = await api('POST', '/api/tables', { form });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));
  const made = await api('POST', '/api/maps', { body: { name: `Egress ${arm.id}` } });
  assert.equal(made.status, 201);
  const map = `/api/maps/${made.json.id}`;
  const layer = await api('POST', `${map}/layers`, { basis: captureBasis(made.json), body: { name: 'Points', sql: `SELECT * FROM "${uploaded.json.name}"` } });
  assert.equal(layer.status, 201, JSON.stringify(layer.json));
  const current = await api('GET', map);
  const saved = await api('PATCH', map, { basis: captureBasis(current.json), body: {
    customBasemap: { url: arm.url ?? `http://${arm.author}:8080/style.json`, name: 'Egress fixture', force: true },
  } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json)); result.saved = true;
  await phase('live');
  // Wait for the separately logged liveness connection to close, before
  // the measurement epoch starts. A dead listener cannot prove silence.
  const liveUrl = arm.local ? `http://${privateAddress}:8080/live` : arm.liveUrl ?? `http://${arm.privateIp ?? privateAddress}:8080/live`;
  Object.assign(result, await liveListener('listener', liveUrl));
  if (arm.local) result.localLive = await liveListener('local', arm.liveUrl);
  result.armedAt = Date.now(); await phase('render');
  const definition = arm.definition ?? {
    viewport: { lng: 13.37, lat: 52.5, zoom: 10, pitch: 0, bearing: 0 },
    size: { width: 640, height: 360 }, legend: { visible: false, corner: 'bottom-left', size: 'm' },
    widgets: [], title: null, appearance: 'light', mapScale: 1,
  };
  const start = performance.now();
  const response = await api('POST', `${map}/export/image`, { body: { definition }, raw: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  result.durationMs = performance.now() - start;
  result.status = response.status; result.contentType = response.headers.get('content-type');
  result.abandoned = response.headers.get('x-dezfil-export-abandoned');
  if (result.contentType?.includes('image/png')) {
    await writeFile(`${directory}/export.png`, bytes);
    const png = decodePng(bytes);
    result.png = { width: png.width, height: png.height, colored: countColored(png),
      cyan: countPixels(png, ([r, g, b]) => r < 30 && g > 160 && b > 180),
      magenta: countPixels(png, ([r, g, b]) => r > 200 && g < 80 && b > 200) };
  } else {
    result.body = JSON.parse(bytes.toString('utf8'));
  }
  // The render route returns before its asynchronous browser close finishes.
  let closedBrowser = false;
  for (let i = 0; i < 160; i++) {
    if (readRows(await readFile(`${directory}/browser.ndjson`, 'utf8')).some(row => row.event === 'closed')) { closedBrowser = true; break; }
    await delay(50);
  }
  assert.ok(closedBrowser, 'browser close observation missing');
} catch (error) {
  result.failure = error.stack; process.exitCode = 1;
} finally {
  await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
