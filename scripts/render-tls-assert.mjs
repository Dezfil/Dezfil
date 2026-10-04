import assert from 'node:assert/strict';
import { assessCommon } from './render-egress-assert.mjs';

export function tlsArms() {
  return ['trusted', 'untrusted', 'wrong-host', 'incomplete', 'incomplete-blocked'].map(certificate => ({
    id: `tls-${certificate}`, kind: 'tls', mode: 'public', phase: 'save', variant: 'style',
    author: 'tls.render.test', url: 'https://tls.render.test:8443/style.json',
    certificate: certificate.replace('-blocked', ''), blockAia: certificate.endsWith('-blocked'),
  }));
}
export function assessTlsArm(arm, evidence) {
  const { checks, check, measured } = assessCommon(arm, evidence);
  check('tls-observer-ready', () => assert.ok(evidence.tls.some(row => row.event === 'ready')));
  check('no-certificate-bypass', () => {
    assert.ok(!evidence.browser.some(row => row.event === 'certificate-bypass-seed'));
    const flags = evidence.browser.find(row => row.event === 'launch').flags;
    assert.ok(!flags.some(flag => /ignore-certificate|allow-insecure|ignore-urlfetcher-cert/.test(flag)));
  });
  const requests = evidence.tls.filter(row => row.phase === 'render' && row.event === 'request');
  if (arm.certificate === 'trusted') check('trusted-style-tiles-identity-pixels', () => {
    assert.equal(evidence.result.status, 200); assert.equal(evidence.result.abandoned, null);
    assert.ok(evidence.result.png?.cyan > 200_000, 'trusted fixture pixels absent');
    assert.ok(requests.some(row => row.path === '/style.json' && row.sni === 'tls.render.test'));
    assert.ok(requests.some(row => row.path.startsWith('/tiles/') && row.sni === 'tls.render.test'));
    const finished = new Set(evidence.browser.filter(row => row.event === 'loadingFinished').map(row => `${row.targetId}:${row.requestId}`));
    for (const path of ['/style.json', '/tiles/']) assert.ok(evidence.browser.some(row => row.event === 'responseReceived' && row.status === 200 &&
      row.url?.startsWith(`https://tls.render.test:8443${path}`) && row.security?.sanList?.includes('tls.render.test') &&
      finished.has(`${row.targetId}:${row.requestId}`)), `missing completed trusted browser response/security details: ${path}`);
  });
  if (['untrusted', 'wrong-host'].includes(arm.certificate)) check(`${arm.certificate}-validation-no-pixels`, () => {
    const error = arm.certificate === 'untrusted' ? 'net::ERR_CERT_AUTHORITY_INVALID' : 'net::ERR_CERT_COMMON_NAME_INVALID';
    const requested = new Set(evidence.browser.filter(row => row.event === 'requestWillBeSent' && row.url?.startsWith('https://tls.render.test:8443/')).map(row => `${row.targetId}:${row.requestId}`));
    assert.ok(evidence.browser.some(row => row.event === 'loadingFailed' && row.error === error && requested.has(`${row.targetId}:${row.requestId}`)), `missing ${error}`);
    assert.equal(requests.length, 0, 'browser sent HTTP over invalid TLS');
    assert.equal(evidence.result.png?.cyan ?? 0, 0, 'invalid TLS contributed fixture pixels');
    assert.ok(!evidence.result.failure, 'export probe failed before observing TLS');
  });
  check('tls-private-listener-silent', () => assert.equal(measured(evidence.listener).filter(row => ['connection', 'request'].includes(row.event)).length, 0));
  return checks;
}
export function chainReport(arm, evidence) {
  const requests = evidence.host.filter(row => row.phase === 'render' && row.event === 'request' && row.path === '/intermediate.der');
  const road = evidence.road.filter(row => row.event === 'road-response' && row.host === 'aia.render.test' && row.path === '/intermediate.der');
  return { claim: 'cold-profile intermediate fetch', label: requests.length ? 'observed on the tip' : 'configured, not observed',
    blocked: !!arm.blockAia, requests, road, route: road.length ? 'SOCKS loopback stream' : requests.length ? 'fixture reached; route unconfirmed' : 'not observed',
    destination: 'http://aia.render.test:8080/intermediate.der', source: 'fresh image browser; no scripted fetch',
    status: evidence.result.status, fixturePixels: evidence.result.png?.cyan ?? 0 };
}
export function supplementaryReport(evidence) {
  const tunnel = evidence.road.some(row => row.event === 'socks-connect' && row.host === 'tls.render.test' && row.port === 8443);
  const stimulus = evidence.browser.find(row => row.event === 'scripted-stimulus');
  const request = path => evidence.tls.some(row => row.phase === 'render' && row.event === 'request' && row.path === path);
  const row = (claim, observed, detail) => ({ claim, label: observed ? 'observed on the tip' : detail.prior ?? 'configured, not observed', tipLabel: 'configured, not observed', detail });
  // A successful tunnel and listener event do not identify the connection
  // serving a particular browser-owned request. Keep coverage unconfirmed.
  return [
    row('service workers', false, { scriptedPage: true, stimulus, fetchAtListener: request('/sw-fetch'), tunnel, route: 'individual request attribution not established' }),
    row('WebSocket', false, { scriptedPage: true, stimulus, upgradeAtListener: evidence.tls.some(r => r.event === 'websocket'), tunnel, prior: 'observed in the spike', route: 'individual connection attribution not established' }),
    row('non-proxied UDP/QUIC', false, { scriptedPage: true, stimulus, flags: evidence.browser.find(r => r.event === 'launch')?.flags, reason: 'no live UDP/QUIC bypass control; suppression is configuration only' }),
    row('browser-owned requests', false, { scriptedPage: true, faviconAtListener: request('/favicon.ico'), tunnel, prior: 'observed in the spike', reason: 'background traffic opportunistic; individual road unconfirmed' }),
  ];
}
