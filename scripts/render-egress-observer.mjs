// Mounted test-only preload: observe the shipped renderer without answering
// requests or changing admission, proxy, DNS, TLS or timeout configuration.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fixtureLog } from './render-egress-log.mjs';

const directory = process.env.PROBE_EVIDENCE;
const log = fixtureLog(`${directory}/browser.ndjson`);
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
    log({ event: 'launch', flags: options.args });
    const browser = await launch.call(this, { ...options, args: [...options.args,
      `--log-net-log=${directory}/netlog.json`] });
    log({ event: 'version', version: await browser.version() });
    const observe = async target => {
      const targetId = ++targetSerial;
      const session = await target.createCDPSession();
      const { targetInfo } = await session.send('Target.getTargetInfo');
      await session.send('Network.enable');
      for (const event of ['requestWillBeSent', 'responseReceived', 'loadingFinished', 'loadingFailed']) {
        session.on(`Network.${event}`, data => {
          // Omit headers: the app's bearer credential belongs only in transit.
          log({ event, target: targetInfo.type, targetId, requestId: data.requestId,
            url: data.request?.url ?? data.response?.url, status: data.response?.status,
            initiator: data.initiator?.type, error: data.errorText, encodedDataLength: data.encodedDataLength });
        });
      }
    };
    browser.on('targetcreated', target => {
      if (target.type() === 'other' || target.type() === 'worker') {
        void observe(target).catch(error => log({ event: 'observer-error', message: error.message }));
      }
    });
    const newPage = browser.newPage;
    browser.newPage = async function (...args) {
      const page = await newPage.apply(this, args);
      await observe(page.target()); await page.setCacheEnabled(false);
      const screenshot = page.screenshot;
      page.screenshot = async function (...args) {
        log({ event: 'capture', text: await page.evaluate(() => document.body.innerText) });
        return screenshot.apply(this, args);
      };
      return page;
    };
    const close = browser.close;
    browser.close = async function (...args) {
      const result = await close.apply(this, args); log({ event: 'closed' }); return result;
    };
    return browser;
  };
}
