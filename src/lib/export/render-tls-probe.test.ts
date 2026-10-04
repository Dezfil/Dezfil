import { describe, expect, it } from 'vitest';
import { assessTlsArm, tlsArms, chainReport, supplementaryReport } from '../../../scripts/render-tls-assert.mjs';

function evidence() {
  return { browser: [{ event: 'launch', flags: [] },
    { event: 'requestWillBeSent', targetId: 1, requestId: 'style', url: 'https://tls.render.test:8443/style.json' },
    { event: 'loadingFailed', targetId: 1, requestId: 'style', error: 'net::ERR_CERT_AUTHORITY_INVALID' }],
    tls: [{ event: 'ready' }], host: [], dns: [], listener: [], road: [], netlog: { events: [] }, result: { png: { cyan: 0 } } };
}
describe('TLS report assertions', () => {
  it('pins separate trusted, untrusted, wrong-name and cold incomplete-chain arms', () => {
    expect(tlsArms().map(row => row.id)).toEqual(['tls-trusted', 'tls-untrusted', 'tls-wrong-host', 'tls-incomplete', 'tls-incomplete-blocked']);
  });
  it('needs the specific certificate error on the fixture request and zero HTTP/pixels', () => {
    const arm = tlsArms()[1], e = evidence();
    const check = () => assessTlsArm(arm, e).find(row => row.name === 'untrusted-validation-no-pixels');
    expect(check()?.ok).toBe(true);
    e.result.png.cyan = 1; expect(check()?.ok).toBe(false); e.result.png.cyan = 0;
    e.browser[2].requestId = 'unrelated'; expect(check()?.ok).toBe(false); e.browser[2].requestId = 'style';
    e.browser[2].error = 'net::ERR_CONNECTION_REFUSED'; expect(check()?.ok).toBe(false);
  });
  it('cannot substitute an untrusted-chain failure for a wrong host name', () => {
    const arm = tlsArms()[2], e = evidence();
    const check = () => assessTlsArm(arm, e).find(row => row.name === 'wrong-host-validation-no-pixels');
    expect(check()?.ok).toBe(false);
    e.browser[2].error = 'net::ERR_CERT_COMMON_NAME_INVALID'; expect(check()?.ok).toBe(true);
  });
  it('does not infer intermediate or transport coverage from configuration', () => {
    expect(chainReport(tlsArms()[3], evidence())).toMatchObject({ label: 'configured, not observed', route: 'not observed' });
    expect(supplementaryReport(evidence()).map(row => [row.claim, row.label, row.tipLabel])).toEqual([
      ['service workers', 'configured, not observed', 'configured, not observed'],
      ['WebSocket', 'observed in the spike', 'configured, not observed'],
      ['non-proxied UDP/QUIC', 'configured, not observed', 'configured, not observed'],
      ['browser-owned requests', 'observed in the spike', 'configured, not observed'],
    ]);
  });
});
