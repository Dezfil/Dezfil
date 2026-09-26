import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { resolvePackage } from './dezfil-package.mjs';
import { checkNamedOperations, checkPackageCopy } from './dezfil-package-checks.mjs';
import { coreJourney, journeyClient } from './mcp-journey-core.mjs';

/** Each format resolves its own copied native chain. Identical downstream
 * configuration runs once. There is no endpoint parameter or fallback. */
export async function installedJourney(root, { render = false, renderLog = undefined } = {}) {
  const started = Date.now();
  const report = { arm: render ? 'installed-real-look' : 'installed-http', setup: 0, connections: 0, productCalls: 0, formats: [], runs: [] };
  try {
    const configurations = new Map();
    for (const format of ['claude', 'codex']) {
      const resolved = await resolvePackage(root, format);
      const skill = await readFile(path.join(resolved.skills, 'dezfil/SKILL.md'), 'utf8');
      const analysis = await readFile(path.join(resolved.skills, 'dezfil/analysis.md'), 'utf8');
      for (const name of [ 'references/cartography.md', 'references/duckdb-spatial.md']) assert.ok((await readFile(path.join(resolved.skills, 'dezfil', name))).length);
      await checkPackageCopy(resolved.plugin);
      report.formats.push({ format, version: resolved.version, url: resolved.url, manifest: resolved.manifestFile, connection: resolved.mcpFile });
      report.setup++;
      configurations.set(JSON.stringify([resolved.name, resolved.type, resolved.url]), { ...resolved, skill, analysis });
    }
    for (const config of configurations.values()) {
      const client = new Client({ name: 'dezfil-installed-journey', version: '1' });
      const trace = [];
      const originalCall = client.callTool.bind(client);
      client.callTool = async (...args) => {
        report.productCalls++;
        const wire = await originalCall(...args);
        trace.push({ name: args[0].name, args: args[0].arguments, wire });
        return wire;
      };
      const runStarted = Date.now();
      try {
        // The SDK bounds requests; the actual installed URL is the only source.
        await client.connect(new StreamableHTTPClientTransport(new URL(config.url)));
        report.connections++;
        const base = new URL(config.url).origin;
        const journey = await journeyClient(client, async subject => {
          const response = await fetch(base + subject, { signal: AbortSignal.timeout(5000) });
          assert.ok(response.ok, `Documented REST confirmation subject ${response.status}`);
          return response.json();
        });
        checkNamedOperations(config.skill, journey.tools, config.analysis);
        if (render) {
          const { installedLook } = await import('./dezfil-installed-look.mjs');
          const look = await installedLook(client, journey, renderLog);
          report.look = look;
        } else {
          await coreJourney(journey, { packageChecks: true });
          assert.equal(trace.filter(event => event.name === 'publish_map').length, 1, 'decline dispatches zero and approval dispatches one publish');
          assert.equal(trace.filter(event => event.name === 'undo_change').length, 1);
          assert.equal(trace.filter(event => event.name === 'redo_change').length, 1);
          assert.ok(trace.some(event => event.name === 'run_sql' && event.wire.isError && event.wire.structuredContent.result.error.code === 'sql_rejected'));
        }
        report.runs.push({ url: config.url, sharedFormats: report.formats.filter(f => f.url === config.url).map(f => f.format), elapsedMs: Date.now() - runStarted, calls: trace.map(event => event.name), result: 'passed' });
      } catch (error) {
        report.runs.push({ url: config.url, elapsedMs: Date.now() - runStarted, calls: trace.map(event => event.name), result: 'failed', error: error.message });
        throw error;
      } finally { await client.close(); }
    }
    return { ...report, elapsedMs: Date.now() - started };
  } catch (error) {
    error.journeyReport = { ...report, elapsedMs: Date.now() - started, result: 'failed', error: error.message };
    throw error;
  }
}
