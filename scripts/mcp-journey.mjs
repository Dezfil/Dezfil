// Shared no-model MCP journey. Run in the instance's network namespace with
// loopback egress enabled. The optional --render arm requires its Chromium.
import { createServer } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { coreJourney, newerJourney, journeyClient } from './mcp-journey-core.mjs';
const base = process.argv.find(arg => /^https?:/.test(arg)) ?? 'http://127.0.0.1:3377';
const started = Date.now();
const client = new Client({ name: 'dezfil-mcp-journey', version: '1' });
const source = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/csv' }); res.end('name,lon,lat\nremote_fixture,0,0\n'); });
try {
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`)));
  const journey = await journeyClient(client, async path => { const response = await fetch(base + path); if (!response.ok) throw new Error(`Subject read ${response.status}`); return response.json(); });
  await coreJourney(journey);
  await newerJourney(journey, `http://127.0.0.1:${source.address().port}/fixture.csv`);
  console.log(JSON.stringify({ arm: 'core-and-newer', elapsedMs: Date.now() - started, tools: [...journey.exercised].sort() }));
  if (process.argv.includes('--render')) {
    const { renderJourney } = await import('./mcp-journey-render.mjs');
    await renderJourney(journey);
  }
} finally {
  await client.close(); source.closeAllConnections(); await new Promise(resolve => source.close(resolve));
}
