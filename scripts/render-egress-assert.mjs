// Offline evidence checks. Nothing here substitutes for a real connection.
import assert from 'node:assert/strict';

export const refusal = "The map reaches an address this instance's egress policy denies (private and internal ranges). The image was not produced.";
export const publicAddress = '203.0.113.10';
export const privateAddress = '192.168.99.10';

export function readRows(text) {
  assert.ok(text.trim(), 'missing event log');
  return text.trim().split('\n').map(line => JSON.parse(line));
}

export function browserLookups(netlog, host) {
  assert.ok(netlog?.constants?.logEventTypes && Array.isArray(netlog.events) && netlog.events.length, 'missing browser netlog events/constants');
  const types = Object.fromEntries(Object.entries(netlog.constants.logEventTypes).map(([name, id]) => [id, name]));
  assert.ok(Object.keys(netlog.constants.logEventTypes).some(name => /HOST_RESOLVER.*JOB|DNS_TRANSACTION/.test(name)), 'missing browser resolver vocabulary');
  // A REQUEST is bookkeeping, including when SOCKS owns resolution. JOB,
  // DNS/PROC_TASK and DNS_TRANSACTION are actual browser resolver work.
  const resolver = /DNS_TRANSACTION|HOST_RESOLVER.*(?:JOB|DNS_TASK|PROC_TASK)/;
  const mentions = value => JSON.stringify(value ?? {}).toLowerCase().includes(host.toLowerCase());
  const sources = new Set(netlog.events.filter(event => mentions(event.params)).map(event => event.source?.id).filter(id => id !== undefined));
  return netlog.events.filter(event => resolver.test(types[event.type] ?? '') &&
    (mentions(event.params) || sources.has(event.source?.id))).map(event => ({ type: types[event.type], ...event }));
}

export function assessArm(arm, evidence) {
  const checks = [];
  const check = (name, fn) => {
    try { fn(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, message: error.message }); }
  };
  const { dns, listener, host, browser, netlog, result } = evidence;
  const measured = rows => rows.filter(row => row.arm === arm.id && row.phase === 'render');
  check('evidence-complete', () => {
    for (const [name, rows] of Object.entries({ dns, listener, host, browser })) {
      assert.ok(Array.isArray(rows) && rows.some(row => row.event === 'ready'), `${name}: missing readiness record`);
    }
    assert.equal(result.arm, arm.id);
    assert.equal(result.saved, true, 'save did not complete');
    assert.ok(browser.some(row => row.event === 'launch'), 'browser never launched');
    assert.ok(browser.some(row => row.event === 'closed'), 'browser/netlog did not close');
    assert.ok(netlog.events.length, 'empty netlog');
  });
  check('listener-live-before-measurement', () => {
    const live = listener.filter(row => row.arm === arm.id && row.phase === 'live');
    const request = live.find(row => row.event === 'request' && row.path === '/live');
    assert.ok(request, 'missing liveness GET');
    assert.ok(live.some(row => row.event === 'connection' && row.socket === request.socket), 'missing liveness connection');
    assert.ok(live.some(row => row.event === 'close' && row.socket === request.socket), 'liveness socket was not closed before measurement');
    assert.ok(live.every(row => row.at <= result.armedAt), 'liveness overlaps measurement');
    assert.equal(result.liveBody, 'listener-alive');
    assert.equal(result.emptyBeforeExport, true, 'measurement did not start empty');
  });
  check('dns-answer-sequence', () => {
    const queries = measured(dns).filter(row => row.name === arm.author);
    const answers = queries.filter(row => row.type === 1);
    assert.ok(answers.length, 'author has no A queries');
    assert.ok(queries.some(row => row.type === 28), 'author has no observed AAAA query');
    assert.ok(queries.filter(row => row.type === 28).every(row => row.answers.length === 0), 'AAAA must be empty');
    if (arm.mode === 'rebind') {
      assert.ok(answers.length >= 2, 'missing connection-time resolution');
      assert.deepEqual(answers[0].answers, [publicAddress], 'first admission answer must be public');
      assert.ok(answers.slice(1).every(row => JSON.stringify(row.answers) === JSON.stringify([privateAddress])), 'exactly one public answer, then private');
    } else {
      const expected = arm.mode === 'private' ? privateAddress : publicAddress;
      assert.ok(answers.every(row => JSON.stringify(row.answers) === JSON.stringify([expected])), `answers must stay ${expected}`);
    }
  });
  check('browser-dns-absent', () => assert.deepEqual(browserLookups(netlog, arm.author), [], `browser resolved ${arm.author}`));
  check('private-connections-zero', () => assert.equal(measured(listener).filter(row => row.event === 'connection').length, 0));
  check('private-requests-zero', () => assert.equal(measured(listener).filter(row => row.event === 'request').length, 0));
  if (arm.mode === 'public') {
    check('public-png-and-pixels', () => {
      assert.equal(result.status, 200);
      assert.equal(result.png?.width, 640); assert.equal(result.png?.height, 360);
      assert.ok(result.png.cyan > 200_000, 'public fixture pixels absent');
      assert.ok(measured(host).some(row => row.event === 'request' && row.path === '/style.json'), 'public style never fetched');
      assert.equal(result.abandoned, null);
    });
  } else {
    check('exact-policy-answer', () => {
      assert.equal(result.status, 502);
      assert.equal(result.body?.error?.code, 'render_failed');
      assert.equal(result.body?.error?.message, refusal);
      assert.equal(result.png, null, 'refusal must not produce a PNG');
    });
  }
  return checks;
}
