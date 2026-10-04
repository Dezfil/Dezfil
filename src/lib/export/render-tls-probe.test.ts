import { describe, expect, it } from 'vitest';
import { assessTlsArm, tlsArms, tlsReport, supplementaryReport } from '../../../scripts/render-tls-assert.mjs';

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
  it('includes the fixture browser error in the trusted pixel failure', () => {
    const e = { ...evidence(), result: { status: 200, abandoned: null, png: { cyan: 0 } } };
    expect(assessTlsArm(tlsArms()[0], e).find(row => row.name === 'trusted-style-tiles-identity-pixels'))
      .toMatchObject({ ok: false, message: expect.stringContaining('net::ERR_CERT_AUTHORITY_INVALID') });
  });
  it('does not infer intermediate or transport coverage from configuration', () => {
    expect(tlsReport(tlsArms()[3], evidence())).toMatchObject({ label: 'configured, not observed', route: 'not observed' });
    expect(supplementaryReport(evidence()).map(row => [row.claim, row.label, row.tipLabel])).toEqual([
      ['service workers', 'configured, not observed', 'configured, not observed'],
      ['WebSocket', 'observed in the spike', 'configured, not observed'],
      ['non-proxied UDP/QUIC', 'configured, not observed', 'configured, not observed'],
      ['browser-owned requests', 'observed in the spike', 'configured, not observed'],
    ]);
  });
});

function chainEvidence(blocked: boolean) {
  const arm = tlsArms()[blocked ? 4 : 3];
  return {
    ...evidence(),
    browser: [{ event: 'ready' }, { event: 'launch', flags: [] }, { event: 'closed' }],
    dns: [{ event: 'ready' }], netlog: { events: [{}] },
    listener: [{ event: 'ready' }, ...['connection', 'request', 'close'].map(event =>
      ({ event, arm: arm.id, phase: 'live', socket: 1, path: '/live', at: 1 }))],
    host: [{ event: 'ready' },
      { event: 'request', arm: arm.id, phase: 'render', socket: 2, path: '/intermediate.der', host: 'aia.render.test:8080' },
      { event: 'response', arm: arm.id, phase: 'render', socket: 2, path: '/intermediate.der', status: blocked ? 503 : 200 }],
    road: [{ event: 'road-response', host: 'aia.render.test', port: 8080, path: '/intermediate.der', status: blocked ? 503 : 200 }],
    result: { arm: arm.id, saved: true, armedAt: 2, liveBody: 'listener-alive',
      status: 200, abandoned: null as string | null, failure: undefined as string | undefined, png: { cyan: blocked ? 0 : 229_118 } },
  };
}

describe.each([false, true])('incomplete chain, blocked=%s', blocked => {
  const arm = tlsArms()[blocked ? 4 : 3];
  const assertion = blocked ? 'incomplete-blocked-fetch-no-pixels' : 'incomplete-fetch-pixels';
  it('observes only the completed fetch and its matching pixel outcome', () => {
    const e = chainEvidence(blocked);
    expect(assessTlsArm(arm, e).find(row => row.name === assertion)?.ok).toBe(true);
    expect(tlsReport(arm, e, [trustedReport()])).toMatchObject({ label: 'observed on the tip', route: 'SOCKS loopback stream' });
    e.result.png.cyan = blocked ? 1 : 0;
    expect(assessTlsArm(arm, e).find(row => row.name === assertion)?.ok).toBe(false);
    expect(tlsReport(arm, e, [trustedReport()]).label).toBe('not established');
  });
  it.each(['request', 'response'])('does not claim observation without the fetch %s', event => {
    const e = chainEvidence(blocked); e.host = e.host.filter(row => row.event !== event);
    expect(assessTlsArm(arm, e).find(row => row.name === assertion)?.ok).toBe(false);
    expect(tlsReport(arm, e, [trustedReport()]).label).not.toBe('observed on the tip');
  });
  it.each(['status', 'socket', 'phase', 'arm'])('refuses a mismatched fetch response %s', field => {
    const e = chainEvidence(blocked);
    Object.assign(e.host[2], { [field]: field === 'status' ? (blocked ? 200 : 503) : field === 'socket' ? 99 : 'other' });
    expect(assessTlsArm(arm, e).find(row => row.name === assertion)?.ok).toBe(false);
    expect(tlsReport(arm, e, [trustedReport()]).label).toBe('not established');
  });
  it('does not claim a SOCKS response with the wrong status', () => {
    const e = chainEvidence(blocked); e.road[0].status = blocked ? 200 : 503;
    expect(tlsReport(arm, e, [trustedReport()])).toMatchObject({ route: 'fixture reached; route unconfirmed' });
  });
  it('leaves the route unconfirmed without a SOCKS response', () => {
    const e = chainEvidence(blocked); e.road = [];
    expect(tlsReport(arm, e, [trustedReport()])).toMatchObject({ label: 'observed on the tip', route: 'fixture reached; route unconfirmed' });
  });
  it.each(['failed-export', 'abandoned-export', 'missing-png', 'missing-netlog', 'certificate-bypass'])('cannot report observed with %s', defect => {
    const e = chainEvidence(blocked);
    if (defect === 'failed-export') e.result.failure = 'probe failed';
    if (defect === 'abandoned-export') e.result.abandoned = '1';
    if (defect === 'missing-png') Reflect.deleteProperty(e.result, 'png');
    if (defect === 'missing-netlog') e.netlog.events = [];
    if (defect === 'certificate-bypass') e.browser.push({ event: 'certificate-bypass-seed' });
    expect(tlsReport(arm, e, [trustedReport()]).label).toBe('not established');
  });
});

function trustedReport() {
  return { arm: { id: 'tls-trusted' }, checks: [
    { name: 'trusted-style-tiles-identity-pixels', ok: true },
    { name: 'no-certificate-bypass', ok: true },
  ] };
}
function negativeEvidence(blocked: boolean) {
  const e = chainEvidence(true);
  if (blocked) return e;
  const arm = tlsArms()[1];
  e.result.arm = arm.id;
  e.listener = e.listener.map(row => ({ ...row, arm: arm.id }));
  e.browser.push(...evidence().browser.slice(1));
  return e;
}
describe.each([false, true])('negative TLS report, blocked chain=%s', blocked => {
  const arm = tlsArms()[blocked ? 4 : 1];
  it.each(['absent', 'failed', 'other-arm', 'missing-check', 'certificate-bypass'])('does not report a passing negative as observed when the trusted positive is %s', prerequisite => {
    const e = negativeEvidence(blocked), positive = trustedReport();
    if (prerequisite === 'failed') positive.checks[0].ok = false;
    if (prerequisite === 'other-arm') positive.arm.id = 'another-arm';
    if (prerequisite === 'missing-check') positive.checks.shift();
    if (prerequisite === 'certificate-bypass') positive.checks[1].ok = false;
    expect(assessTlsArm(arm, e).every(row => row.ok)).toBe(true);
    expect(tlsReport(arm, e, prerequisite === 'absent' ? [] : [positive])).toMatchObject({
      label: 'not established', trustedPositive: { arm: 'tls-trusted', passed: false },
    });
  });
  it('reports a passing negative beside the passing trusted positive from this invocation', () => {
    const e = negativeEvidence(blocked), positive = trustedReport();
    expect(tlsReport(arm, e, [positive])).toMatchObject({
      label: 'observed on the tip', trustedPositive: { arm: 'tls-trusted', passed: true, checks: positive.checks },
    });
    e.result.png.cyan = 1;
    expect(tlsReport(arm, e, [positive]).label).toBe('not established');
  });
});
