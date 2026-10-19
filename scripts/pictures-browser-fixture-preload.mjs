// Test process only. Keep the application's real renderer, authentication,
// admission, style loading, projection and screenshots; answer just the three
// public style documents with deterministic grounds after normal admission.
// Capacity proofs redirect them to real loopback raster styles instead.
import puppeteer from 'puppeteer-core';
if (process.env.DEZFIL_PICTURE_STYLE_FIXTURE !== '1' || process.env.PORT === '3000' || !/pictures-/.test(process.env.DEZFIL_DATA_DIR ?? '')) {
  throw new Error('Picture style fixture requires an isolated pictures scratch instance on a separate port.');
}
const colours = { '/styles/dark': '#1a2a3a', '/styles/positron': '#f0e6c8', '/styles/liberty': '#c8e0f0' };
const launch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async (...args) => {
  const browser = await launch(...args), newPage = browser.newPage.bind(browser);
  browser.newPage = async (...pageArgs) => {
    const page = await newPage(...pageArgs);
    page.on('request', request => {
      const url = new URL(request.url());
      const colour = url.origin === 'https://tiles.openfreemap.org' ? colours[url.pathname] : undefined;
      const loopback = process.env.DEZFIL_PICTURE_BASEMAP_URL;
      if (colour && loopback) {
        const target = new URL(loopback);
        if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('Capacity basemap must be loopback');
        target.pathname = url.pathname === '/styles/dark' ? '/dark/style.json' : '/light/style.json';
        // The real gate sees the destination this synthetic redirect serves,
        // so its admission cannot resolve a public hostname first.
        request.url = () => target.href;
        request.continue = async () => request.respond({ status: 302, headers: { 'Access-Control-Allow-Origin': '*', Location: target.href }, body: '' });
        return;
      }
      if (colour) request.continue = async () => request.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ version: 8, sources: {}, layers: [{ id: 'fixture-ground', type: 'background', paint: { 'background-color': colour } }] }) });
    });
    return page;
  };
  return browser;
};
