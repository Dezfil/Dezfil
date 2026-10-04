import { describe, expect, it } from 'vitest';
import { assessArm, browserLookups, readRows } from '../../../scripts/render-egress-assert.mjs';

// Synthetic records test the observer, never connection behavior.
const arm = { id: 'style-rebind', author: 'style-rebind.render.test', mode: 'rebind' };
function records() {
  return {
    dns: [{ event: 'ready' },
      { arm: arm.id, phase: 'render', name: arm.author, type: 1, answers: ['203.0.113.10'] },
      { arm: arm.id, phase: 'render', name: arm.author, type: 28, answers: [] },
      { arm: arm.id, phase: 'render', name: arm.author, type: 1, answers: ['192.168.99.10'] }],
    listener: [{ event: 'ready' },
      { arm: arm.id, phase: 'live', event: 'connection', socket: 1, at: 1 },
      { arm: arm.id, phase: 'live', event: 'request', socket: 1, path: '/live', at: 2 },
      { arm: arm.id, phase: 'live', event: 'close', socket: 1, at: 3 }],
    host: [{ event: 'ready' }],
    browser: [{ event: 'ready' }, { event: 'launch' }, { event: 'closed' }],
    netlog: { constants: { logEventTypes: { HOST_RESOLVER_MANAGER_JOB: 1, HOST_RESOLVER_MANAGER_REQUEST: 2, DNS_TRANSACTION: 3 } },
      events: [{ type: 2, source: { id: 1 }, params: { host: arm.author } }] },
    result: { arm: arm.id, saved: true, armedAt: 4, liveBody: 'listener-alive', emptyBeforeExport: true,
      status: 502, png: null, body: { error: { code: 'render_failed', message: "The map reaches an address this instance's egress policy denies (private and internal ranges). The image was not produced." } } },
  };
}
const failed = (data: ReturnType<typeof records>) => assessArm(arm, data).filter(row => !row.ok).map(row => row.name);

describe('render evidence observer', () => {
  it('accepts the complete guarded sequence and resolver bookkeeping alone', () => {
    expect(failed(records())).toEqual([]);
  });
  it('rejects actual browser lookup work and follows events on that source', () => {
    const data = records();
    data.netlog.events.push({ type: 1, source: { id: 1 }, params: { host: '' } });
    expect(browserLookups(data.netlog, arm.author)).toHaveLength(1);
    expect(failed(data)).toEqual(['browser-dns-absent']);
  });
  it('rejects a private first answer, an absent second lookup, and an extra public answer', () => {
    for (const mutation of ['private-first', 'missing-second', 'public-again']) {
      const data = records();
      if (mutation === 'private-first') data.dns[1].answers = ['192.168.99.10'];
      if (mutation === 'missing-second') data.dns.pop();
      if (mutation === 'public-again') data.dns.push({ ...data.dns[1] });
      expect(failed(data)).toContain('dns-answer-sequence');
    }
  });
  it('rejects mixed A answers and nonempty or missing AAAA evidence', () => {
    for (const mutation of ['mixed', 'ipv6', 'missing']) {
      const data = records();
      if (mutation === 'mixed') data.dns[1].answers?.push('192.168.99.10');
      if (mutation === 'ipv6') data.dns[2].answers = ['::1'];
      if (mutation === 'missing') data.dns.splice(2, 1);
      expect(failed(data)).toContain('dns-answer-sequence');
    }
  });
  it('does not mistake save-time traffic or another arm for the measured answers', () => {
    const data = records(); data.dns[1].phase = 'save';
    data.dns.push({ phase: 'render', arm: 'another-arm', name: arm.author, type: 1, answers: ['203.0.113.10'] });
    expect(failed(data)).toContain('dns-answer-sequence');
  });
  it('fails for missing, unclosed, late or mismatched listener liveness', () => {
    for (const mutation of ['missing', 'unclosed', 'late', 'mismatch']) {
      const data = records();
      if (mutation === 'missing') data.listener = [{ event: 'ready' }];
      if (mutation === 'unclosed') data.listener.pop();
      if (mutation === 'late') data.listener[3].at = 5;
      if (mutation === 'mismatch') data.listener[2].socket = 2;
      expect(failed(data)).toContain('listener-live-before-measurement');
    }
  });
  it('reports every baseline defect independently instead of stopping at the first red', () => {
    const data = records();
    data.netlog.events.push({ type: 3, source: { id: 2 }, params: { host: arm.author } });
    data.listener.push({ arm: arm.id, phase: 'render', event: 'connection', socket: 2, at: 5 },
      { arm: arm.id, phase: 'render', event: 'request', socket: 2, path: '/style.json', at: 6 });
    data.result.status = 200;
    expect(failed(data)).toEqual(['browser-dns-absent', 'private-connections-zero', 'private-requests-zero', 'exact-policy-answer']);
  });
  it('fails closed on missing logs, invalid netlogs and missing browser closure', () => {
    for (const name of ['dns', 'listener', 'host', 'browser'] as const) {
      const data = records(); data[name] = [];
      expect(failed(data)).toContain('evidence-complete');
    }
    expect(() => readRows('')).toThrow('missing event log');
    expect(() => readRows('{broken')).toThrow();
    expect(() => browserLookups({}, arm.author)).toThrow();
    const data = records(); data.browser.pop();
    expect(failed(data)).toContain('evidence-complete');
  });
  it('requires the exact shipped refusal code, sentence and no PNG', () => {
    for (const mutation of ['code', 'message', 'png']) {
      const data = records();
      if (mutation === 'code') data.result.body.error.code = 'another_code';
      if (mutation === 'message') data.result.body.error.message += ' Changed.';
      if (mutation === 'png') Object.assign(data.result, { png: { width: 640 } });
      expect(failed(data)).toContain('exact-policy-answer');
    }
  });
  it('holds the public and private controls to their own outcomes', () => {
    const privateData = records(); privateData.dns[1].answers = ['192.168.99.10'];
    expect(assessArm({ ...arm, mode: 'private' }, privateData).every(row => row.ok)).toBe(true);
    const publicData = records(); publicData.dns[3].answers = ['203.0.113.10'];
    Object.assign(publicData.result, { status: 200, png: { width: 640, height: 360, cyan: 210_000 }, abandoned: null });
    Object.assign(publicData.host, [{ event: 'ready' }, { arm: arm.id, phase: 'render', event: 'request', path: '/style.json' }]);
    expect(assessArm({ ...arm, mode: 'public' }, publicData).every(row => row.ok)).toBe(true);
    Object.assign(publicData.result, { png: { width: 640, height: 360, cyan: 0 } });
    expect(assessArm({ ...arm, mode: 'public' }, publicData).filter(row => !row.ok).map(row => row.name)).toEqual(['public-png-and-pixels']);
  });
});
