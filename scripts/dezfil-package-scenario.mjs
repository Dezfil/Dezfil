import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { preparePackage, resolvePackage } from './dezfil-package.mjs';
import { installedJourney } from './dezfil-installed-journey.mjs';

// Used by both the local standalone driver and the isolated container client.
export async function packageScenario(directory, origin, { render = false, renderLog } = {}) {
  const bad = path.join(directory, 'bad-url');
  await preparePackage({ destination: bad, baseUrl: origin });
  let misdirectedRequests = 0;
  const trap = createServer((_request, response) => { misdirectedRequests++; response.writeHead(503); response.end('Wrong instance fixture'); });
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
  const wrongEndpoint = `http://127.0.0.1:${trap.address().port}/api/mcp`;
  let failure;
  try {
    await writeFile(path.join(bad, 'plugins/dezfil/.mcp.json'), JSON.stringify({ mcpServers: { dezfil: { type: 'http', url: wrongEndpoint } } }));
    try { await installedJourney(bad); } catch (error) { failure = error.journeyReport; }
    assert.ok(failure, 'wrong installed URL must fail with no harness fallback');
    assert.equal(failure.setup, 2); assert.equal(failure.connections, 0); assert.equal(failure.productCalls, 0);
    assert.ok(misdirectedRequests > 0, 'the wrong HTTP endpoint actually received initialization');
    failure.misdirectedRequests = misdirectedRequests;
  } finally { trap.closeAllConnections(); await new Promise(resolve => trap.close(resolve)); }
  const good = path.join(directory, 'installed'); await preparePackage({ destination: good, baseUrl: origin });
  for (const format of ['claude', 'codex']) {
    const resolved = await resolvePackage(good, format);
    assert.equal(resolved.url, `${origin}/api/mcp`, `${format} package must target the selected isolated instance before connecting`);
  }
  const report = { wrongUrl: failure };
  const arm = render ? 'render' : 'http';
  try { report[arm] = await installedJourney(good, { render, renderLog }); }
  catch (error) { error.scenarioReport = { ...report, [arm]: error.journeyReport }; throw error; }
  return report;
}
