// Mounted test-only preload: observe the shipped renderer without answering
// requests. Only explicitly selected negative seeds change proxy/TLS behavior;
// the unseeded road leaves admission, proxy, DNS, TLS and timeouts unchanged.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { observeRoad } from './render-road-observer.mjs';
import { stimulate } from './render-supplementary.mjs';
import { active, fixtureLog } from './render-egress-log.mjs';

const directory = process.env.PROBE_EVIDENCE;
const log = fixtureLog(`${directory}/browser.ndjson`);
const registerRoad = process.env.PROBE_ROAD === '1' ? observeRoad(fixtureLog(`${directory}/road.ndjson`)) : () => {};
const require = createRequire(path.join(process.cwd(), 'server.js'));
const directories = require.resolve.paths('puppeteer-core').filter(directory => directory.startsWith(process.cwd() + path.sep) && existsSync(directory));
const packages = directories.flatMap(directory => readdirSync(directory).filter(name => /^puppeteer-core(?:-[a-z0-9]+)?$/.test(name)).map(name => path.join(directory, name)));
const owners = new Set(packages.map(filename => require(filename).default));
if (!owners.size) throw new Error('Browser observer cannot attach');
log({ event: 'ready' });
let targetSerial = 0;
for (const owner of owners) {
  const launch = owner.launch;
  owner.launch = async function (options) {
    const arm = active();
    let flags = options.args;
    if (['direct-bypass', 'supplementary-direct'].includes(arm.seed)) flags = [...flags.filter(flag => !flag.startsWith('--proxy-')), '--no-proxy-server'];
    if (arm.seed === 'broken-tunnel') flags = flags.map(flag => flag.startsWith('--proxy-server=') ? '--proxy-server=socks5://127.0.0.1:1' : flag);
    registerRoad(flags);
    log({ event: 'launch', flags, seed: arm.seed });
    const browser = await launch.call(this, { ...options, args: [...flags,
      `--log-net-log=${directory}/netlog.json`] });
    log({ event: 'version', version: await browser.version() });
    const observe = async target => {
      const targetId = ++targetSerial;
      const session = await target.createCDPSession();
      const { targetInfo } = await session.send('Target.getTargetInfo');
      await session.send('Network.enable');
      for (const event of ['requestWillBeSent', 'responseReceived', 'loadingFinished', 'loadingFailed', 'webSocketCreated', 'webSocketHandshakeResponseReceived']) {
        session.on(`Network.${event}`, data => {
          // Omit headers: the app's bearer credential belongs only in transit.
          log({ event, target: targetInfo.type, targetId, requestId: data.requestId,
            url: data.url ?? data.request?.url ?? data.response?.url, status: data.response?.status, security: data.response?.securityDetails,
            initiator: data.initiator?.type, error: data.errorText, encodedDataLength: data.encodedDataLength });
        });
      }
    };
    browser.on('targetcreated', target => {
      if (target.type() === 'other' || target.type() === 'worker' || target.type() === 'service_worker') {
        void observe(target).catch(error => log({ event: 'observer-error', message: error.message }));
      }
    });
    const newPage = browser.newPage;
    browser.newPage = async function (...args) {
      const page = await newPage.apply(this, args);
      await observe(page.target()); await page.setCacheEnabled(false);
      if (arm.seed === `certificate-bypass-${arm.certificate}` && ['untrusted', 'wrong-host'].includes(arm.certificate)) {
        const session = await page.createCDPSession();
        await session.send('Security.setIgnoreCertificateErrors', { ignore: true });
        log({ event: 'certificate-bypass-seed', certificate: arm.certificate });
      }
      const screenshot = page.screenshot;
      page.screenshot = async function (...args) {
        if (arm.seed === 'delay') await delay(arm.delayMs);
        log({ event: 'capture', text: await page.evaluate(() => document.body.innerText) });
        return screenshot.apply(this, args);
      };
      return page;
    };
    if (arm.kind === 'supplementary') await stimulate(browser, log);
    const close = browser.close;
    browser.close = async function (...args) {
      const result = await close.apply(this, args); log({ event: 'closed' }); return result;
    };
    return browser;
  };
}
