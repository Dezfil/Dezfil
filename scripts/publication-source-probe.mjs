import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { provisionJourney } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';
import { assertPublishedStatus, assertPublicationState, publicationRequest } from './publication-probe-support.mjs';

export async function provisionPublications(api) {
  const tokens = [];
  for (let i = 0; i < 2; i++) {
    const map = await api('POST', '/api/maps', { body: { name: `Source control ${i}` } }); assert.equal(map.status, 201);
    const layer = await api('POST', `/api/maps/${map.json.id}/layers`, { body: { name: 'Point', sql: 'SELECT ST_Point(1, 2) AS geometry' }, basis: { editRevision: map.json.editRevision } }); assert.equal(layer.status, 201);
    const current = await api('GET', `/api/maps/${map.json.id}`);
    const published = await api('POST', `/api/maps/${map.json.id}/publish`, { basis: { editRevision: current.json.editRevision } }); assert.equal(published.status, 201);
    tokens.push(published.json.token);
  }
  return tokens;
}

export async function publicationSourceProbe(base, mode, stateLog) {
  assert.ok(process.env.DEZFIL_DATA_DIR, 'Use an isolated DEZFIL_DATA_DIR');
  assert.ok(['direct', 'trusted', 'untrusted', 'missing'].includes(mode), 'Unknown publication probe mode');
  const started = Date.now(), evidence = [];
  const paths = ['', '/widget-values', '/render/layer', '/extent/layer', '/tiles/layer/0/0/0'];
  const send = async (suffix, { token = 'missing', source = '192.0.2.1', second = false, forged = false } = {}) => {
    const method = suffix && !suffix.startsWith('/tiles/') ? 'POST' : 'GET';
    const headers = { 'content-type': 'application/json', ...(forged ? { 'x-dezfil-ingress': 'forged' } : {}) };
    if (mode === 'trusted' || mode === 'untrusted' || forged) headers['x-forwarded-for'] = `203.0.113.99, ${source}`;
    const result = await publicationRequest(base, `/api/published/${token}${suffix}`, {
      method, headers, localAddress: second ? '127.0.0.2' : '127.0.0.1', ...(method === 'POST' ? { body: '{}' } : {}),
    });
    evidence.push({ suffix, status: result.status }); return result;
  };
  if (mode === 'missing') {
    for (const suffix of paths) for (const forged of [false, true]) assertPublishedStatus(await send(suffix, { forged }), 503);
  } else {
    assert.ok(stateLog, '--state-log is required'); await readFile(stateLog);
    const credentials = await provisionJourney(base), api = journeyApi(base, { token: credentials.token });
    const tokens = await provisionPublications(api);
    // Four view requests across two valid tokens and two unknown-token routes.
    for (const token of tokens) assertPublishedStatus(await send('', { token }), 200);
    for (const suffix of paths.slice(1, 3)) assertPublishedStatus(await send(suffix), 404);
    for (const suffix of paths.slice(0, 4)) assertPublishedStatus(await send(suffix, { forged: true }), 429);
    // The tile bucket is independent, including for an unknown publication.
    for (let i = 0; i < 2; i++) assertPublishedStatus(await send(paths[4]), 404);
    assertPublishedStatus(await send(paths[4]), 429);
    if (mode === 'direct') {
      // Two real source sockets; the image listens on IPv4, never ::1.
      assertPublishedStatus(await send('/extent/layer', { second: true, forged: true }), 404);
    } else if (mode === 'trusted') {
      // The leftmost hop is forged; the nearest untrusted hop is the budget.
      assertPublishedStatus(await send('/extent/layer', { source: '192.0.2.2' }), 404);
      assertPublishedStatus(await send('', { source: '::ffff:192.0.2.1' }), 429);
      const malformed = await publicationRequest(base, '/api/published/missing', { headers: { 'x-forwarded-for': 'invalid' } });
      assertPublishedStatus(malformed, 400);
    } else {
      // Both proxy readers and forged chains collapse to the untrusted peer.
      assertPublishedStatus(await send('', { source: '192.0.2.2', forged: true }), 429);
    }
    await delay(10_050);
    assertPublishedStatus(await send('', { token: tokens[0] }), 200);
    const afterExpiry = (await readFile(stateLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.phase === 'publication').at(-1);
    assert.equal(afterExpiry?.size, 1, 'ordinary read expires both buckets');
    if (mode === 'trusted') {
      let next = 0;
      await Promise.all(Array.from({ length: 24 }, async () => {
        while (next < 10_050) {
          const i = next++, source = `10.${i >>> 16}.${(i >>> 8) & 255}.${i & 255}`;
          assertPublishedStatus(await send(i % 2 ? paths[4] : '', { source }), 404);
        }
      }));
      assertPublicationState((await readFile(stateLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), 10_050);
    }
    const rows = (await readFile(stateLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const peak = assertPublicationState(rows, 1);
    evidence.push({ statePeak: peak, cap: 10_000 });
  }
  const result = { label: 'confirmed', mode, checks: evidence.length, elapsedSeconds: (Date.now() - started) / 1000, evidence };
  console.log(JSON.stringify(result)); return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [base, mode, ...args] = process.argv.slice(2), index = args.indexOf('--state-log');
    assert.ok(base?.startsWith('http://'), 'Usage: publication-source-probe.mjs ORIGIN direct|trusted|untrusted|missing [--state-log PATH]');
    await publicationSourceProbe(base, mode, index < 0 ? undefined : args[index + 1]);
  } catch (error) { console.error(JSON.stringify({ label: 'failed', message: error.message })); process.exitCode = 1; }
}
