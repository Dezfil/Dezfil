// Native HTTP refusal/public matrix. Run only against an isolated scratch store.
// No browser or image export is launched by this probe.
import assert from 'node:assert/strict';
import { probeGateMethods } from './gate-methods-probe.mjs';
import { captureBasis } from './revision-fixtures.mjs';
import { provisionJourney, journeyAccount } from './journey-auth.mjs';
import { journeyApi } from './journey-http.mjs';

export async function gateJourney(base) {
  const anonymous = journeyApi(base), failures = [];
  let checks = 0;
  const check = (condition, label) => { checks++; if (!condition) { failures.push(label); console.error('REFUSAL CHECK FAILED: ' + label); } };
  const beforeSetup = await anonymous('GET', '/api/health');
  check(beforeSetup.status === 200 && beforeSetup.json.status === 'ready', 'anonymous readiness before setup');
  const entry = await anonymous('GET', '/api/auth/entry');
  check(entry.json.setupRequired === true, 'fresh store requires setup');
  for (const pathname of ['/', '/maps', '/settings', '/developer', '/render/fixture']) {
    const response = await anonymous('GET', pathname, { raw: true });
    check(response.status === 307 && new URL(response.headers.get('location'), base).pathname === '/setup', `before setup ${pathname}`);
    await response.body?.cancel();
  }
  const credentials = await provisionJourney(base);
  const api = journeyApi(base, { token: credentials.token });
  const signedOut = await provisionJourney(base);
  assert.equal((await journeyApi(base, { cookie: signedOut.cookie })('POST', '/api/auth/sign-out')).status, 200);
  const revoked = await api('POST', '/api/account/tokens', { body: { name: 'Refused probe' } }); assert.equal(revoked.status, 201);
  assert.equal((await api('DELETE', `/api/account/tokens/${revoked.json.id}`)).status, 200);
  const document = await api('GET', '/api/openapi.json'); assert.equal(document.status, 200);
  const publicKeys = new Set(['GET /api/health', 'GET /api/auth/entry', 'POST /api/auth/setup', 'POST /api/auth/sign-in', 'POST /api/auth/redeem',
    'GET /api/published/{token}', 'POST /api/published/{token}/extent/{layerId}', 'POST /api/published/{token}/widget-values',
    'POST /api/published/{token}/render/{layerId}', 'GET /api/published/{token}/tiles/{layerId}/{z}/{x}/{y}']);
  const routes = Object.entries(document.json.paths).flatMap(([path, methods]) => Object.keys(methods).map(method => ({ path, method: method.toUpperCase() })))
    .filter(route => !publicKeys.has(`${route.method === "HEAD" ? "GET" : route.method} ${route.path}`));
  assert.ok(routes.length > 100);
  const resourceState = async () => Promise.all(['/api/maps', '/api/tables', '/api/projects', '/api/recipes', '/api/users', '/api/settings'].map(path => api('GET', path)));
  const before = JSON.stringify(await resourceState());
  checks += await probeGateMethods(base, credentials.token, document.json);
  check(JSON.stringify(await resourceState()) === before, 'wrong methods do no resource work');
  for (const [kind, headers] of Object.entries({ anonymous: {}, invalid: { authorization: 'Bearer invalid' }, revokedToken: { authorization: `Bearer ${revoked.json.secret}` }, revokedCookie: { cookie: signedOut.cookie } })) {
    for (const { method, path } of routes) {
      const response = await fetch(base + path.replaceAll(/\{[^}]+\}/g, 'fixture'), { method, redirect: 'manual', headers: { ...headers, origin: base, 'content-type': 'application/json' }, ...(['GET', 'HEAD'].includes(method) ? {} : { body: '{}' }) });
      check(response.status === 401 && response.headers.get('cache-control') === 'private, no-store', `${kind} ${method} ${path}: ${response.status}`);
      await response.body?.cancel();
    }
  }
  check(JSON.stringify(await resourceState()) === before, 'refusal inventory leaves resources, settings and accounts unchanged');
  const map = await api('POST', '/api/maps', { body: { name: 'Protected matrix' } }); assert.equal(map.status, 201);
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const route = method === 'POST' ? '/api/maps' : `/api/maps/${map.json.id}`;
    for (const origin of [undefined, 'https://unrelated.test']) {
      const response = await fetch(base + route, { method, redirect: 'manual', headers: { cookie: credentials.cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ name: 'Cross-site change' }) });
      check(response.status === 403, `cookie ${method} ${origin ?? 'missing origin'}: ${response.status}`);
      await response.body?.cancel();
    }
  }
  const unchanged = await api('GET', `/api/maps/${map.json.id}`);
  check(unchanged.status === 200 && unchanged.json.name === 'Protected matrix', 'cross-site mutations preserve the target map');
  for (const pathname of ['/', '/maps', '/maps/fixture', '/data', '/tables/fixture', '/sql', '/projects', '/projects/fixture', '/workflows', '/workflows/fixture', '/connections', '/connections/new', '/connections/fixture', '/users', '/settings', '/developer', '/render/fixture', '/future-page', '/_next/data/build/maps.json', '/_next/image?url=/api/config', '/private.svg']) {
    const response = await anonymous('GET', pathname, { raw: true });
    // The start and standalone launchers encode data redirects differently.
    const redirect = response.headers.get(pathname.startsWith('/_next/data/') ? 'x-nextjs-redirect' : 'location');
    const destination = redirect && (pathname.startsWith('/_next/data/')
      ? ['/sign-in', '/_next/data/build/sign-in.json'].includes(new URL(redirect, base).pathname)
      : new URL(redirect, base).pathname === '/sign-in');
    check(response.status === 307 && destination && response.headers.get('cache-control') === 'private, no-store', `private page ${pathname}: ${response.status}`);
    await response.body?.cancel();
  }
  const signIn = await anonymous('GET', '/sign-in', { raw: true });
  check(signIn.status === 200, 'sign-in HTML');
  const html = await signIn.text();
  const assets = new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+)(?:\?[^\"]*)?"/g)].map(match => match[1]));
  check(assets.size > 0, 'real entry HTML names static assets');
  for (const pathname of [...assets, '/icon.svg', '/shell-sheet-light.svg', '/shell-sheet-dark.svg', '/maki/marker.svg', '/workers/maplibre-gl-6.11.2/maplibre-gl-worker.mjs', '/workers/maplibre-gl-6.11.2/maplibre-gl-shared.mjs', '/workers/loaders.gl-mvt-worker-4.4.5.js']) {
    const response = await anonymous('GET', pathname, { raw: true });
    check(response.status === 200 && !response.headers.has('set-cookie'), `anonymous asset ${pathname}: ${response.status}`);
    await response.body?.cancel();
  }
  const publicMap = await api('POST', '/api/maps', { body: { name: 'Anonymous projection fixture' } }); assert.equal(publicMap.status, 201);
  const form = new FormData(); form.append('file', new Blob(['name,lon,lat,value\na,10,20,1\nb,11,21,2\n']), 'gate_points.csv');
  const table = await api('POST', '/api/tables', { form }); assert.equal(table.status, 201);
  const layer = await api('POST', `/api/maps/${publicMap.json.id}/layers`, { basis: captureBasis(publicMap.json), body: { name: 'Public points', sql: `SELECT * FROM ${table.json.name}` } }); assert.equal(layer.status, 201);
  const widgets = await api('PATCH', `/api/maps/${publicMap.json.id}`, { basis: captureBasis(layer.json), body: { widgetsPublished: true } }); assert.equal(widgets.status, 200);
  const styled = await api('PATCH', `/api/layers/${layer.json.id}`, { basis: captureBasis(widgets.json), body: { viz: { type: 'cluster', radiusPx: 64, color: 'fixed', showCounts: true } } }); assert.equal(styled.status, 200);
  const publication = await api('POST', `/api/maps/${publicMap.json.id}/publish`, { basis: captureBasis(styled.json) }); assert.equal(publication.status, 201);
  const token = publication.json.token;
  const view = await anonymous('GET', `/api/published/${token}`);
  check(view.status === 200 && view.json.layers.length === 1 && !JSON.stringify(view.json).includes(journeyAccount.email), 'anonymous publication projection');
  for (const pathname of [`/v/${token}`, `/v/${token}?embed=1`]) {
    const response = await anonymous('GET', pathname, { raw: true });
    check(response.status === 200 && (await response.text()).includes('data-published-view') && !response.headers.has('set-cookie'), `anonymous viewer HTML ${pathname}`);
  }
  for (const suffix of [`extent/${layer.json.id}`, 'widget-values', `render/${layer.json.id}`]) {
    const response = await anonymous('POST', `/api/published/${token}/${suffix}`, { body: { selections: [] } });
    check(response.status === 200, `anonymous published POST ${suffix}: ${response.status}`);
  }
  for (const [method, pathname] of [['DELETE', `/api/published/${token}`], ['GET', `/api/published/${token}/authoring`], ['GET', '/api/config'], ['GET', '/api/future.svg'], ['GET', '/api/maps'], ['OPTIONS', '/api/maps']]) {
    const response = await anonymous(method, pathname, { raw: true }); check(response.status === 401, `no expanded exception ${method} ${pathname}: ${response.status}`); await response.body?.cancel();
  }
  assert.equal((await api('DELETE', `/api/maps/${publicMap.json.id}/publish`, { raw: true, basis: captureBasis(publication.json) })).status, 200);
  for (const suffix of ['', `/extent/${layer.json.id}`, '/widget-values', `/render/${layer.json.id}`]) {
    const response = await anonymous(suffix ? 'POST' : 'GET', `/api/published/${token}${suffix}`, suffix ? { body: {} } : {});
    check(response.status === 404, `revoked publication ${suffix}: ${response.status}`);
  }
  check((await anonymous('GET', '/api/published/unknown')).status === 404, 'unknown publication remains unavailable');
  check((await anonymous('GET', '/api/health')).status === 200, 'anonymous readiness after setup');
  console.log(JSON.stringify({ label: failures.length ? 'failed' : 'confirmed', checks, protectedOperations: routes.length, failures }, null, 2));
  assert.equal(failures.length, 0, 'native gate/public matrix');
  return { checks, protectedOperations: routes.length };
}
if (process.argv[1]?.endsWith('/gate-journey.mjs')) await gateJourney(process.argv[2]);
