// Starts only an owned built candidate, provisions synthetic credentials, and removes its store.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { provisionJourney } from './journey-auth.mjs';
import { contractSource } from './contract-source.mjs';
import { checkServedContract, servedCounts } from './served-contract-checks.mjs';
import { readContractDocs } from './check-contract-docs.mjs';
const { values } = parseArgs({ options: { standalone: { type: 'string', default: '.next/standalone' }, container: { type: 'string' }, port: { type: 'string', default: '3407' } } });
const root = process.cwd(), scratch = process.env.DEZFIL_DATA_DIR, port = Number(values.port);
assert.ok(scratch && path.isAbsolute(scratch)); mkdirSync(scratch, { recursive: true }); assert.deepEqual(readdirSync(scratch), []);
assert.ok(port >= 3300 && port <= 65535);
const directory = path.join(scratch, 'store'), base = `http://127.0.0.1:${port}`, name = `dezfil-contract-${process.pid}-${Date.now()}`, volume = `${name}-data`;
const started = Date.now(), source = await contractSource();
const guidanceUrl = new URL('../src/lib/assistant/guidance.ts', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); return result.url === guidanceUrl ? { ...result, format: 'module-typescript' } : result; } });
const { renderGuidance } = await import('./dezfil-guidance.mjs'); hook.deregister();
const expectedGuidance = renderGuidance();
let server, ended, log = '', client;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill(); const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); process.exitCode = 1; });
try {
  if (values.container) {
    docker('volume', 'create', volume);
    docker('run', '--pull=never', '-d', '--rm', '--name', name, '-v', `${volume}:/data`, '-p', `127.0.0.1:${port}:3000`, values.container);
  } else {
    server = spawn(process.execPath, [`--import=${root}/scripts/ingress-preload.mjs`, 'server.js'], { cwd: path.resolve(values.standalone), env: { ...process.env, DEZFIL_DATA_DIR: directory, PORT: String(port), HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1', DEZFIL_TRUSTED_PROXIES: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    ended = once(server, 'exit'); server.stdout.on('data', b => { log += b; }); server.stderr.on('data', b => { log += b; });
  }
  for (let i = 0;; i++) {
    assert.ok(i < 160 && (!server || (server.exitCode === null && server.signalCode === null)), 'served contract readiness');
    try { const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }); await r.body?.cancel(); if (r.ok) break; } catch {}
    await pause(250);
  }
  const account = await provisionJourney(base), response = await account.fetch(base + '/api/openapi.json');
  assert.equal(response.status, 200, 'authenticated served OpenAPI'); const document = await response.json();
  client = new Client({ name: 'dezfil-served-contract-proof', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/api/mcp'), { fetch: account.fetch }));
  const tools = []; let cursor;
  do { const page = await client.listTools(cursor ? { cursor } : {}); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
  const docs = readContractDocs();
  const baseline = JSON.parse(readFileSync('test-support/assistant-baselines/mcp-tools-list.json', 'utf8'));
  const guidance = readFileSync('plugins/dezfil/skills/dezfil/analysis.md', 'utf8');
  const problems = checkServedContract({ document, sourceDocument: source.document, tools, derivedTools: source.tools, docs, baseline, guidance, expectedGuidance });
  assert.deepEqual(problems, [], 'served reader contract');
  console.log('PASS: confirmed served counts, errors, actor variants, every MCP definition and installed guidance ' + JSON.stringify(servedCounts(document, tools)));
  console.log(`Elapsed ${(Date.now() - started) / 1000} seconds`);
} finally {
  try { await client?.close(); } finally {
    if (values.container) {
      try { log += docker('logs', name); } catch {}
      try { docker('rm', '-f', '-v', name); } catch {}
      let present = true;
      for (let i = 0; i < 50; i++) { try { docker('container', 'inspect', name); } catch { present = false; break; } await pause(200); }
      assert.equal(present, false, 'owned contract container removed');
      // Removal is checked separately so a cleanup failure never reports green.
      let exists = false; try { docker('volume', 'inspect', volume); exists = true; } catch {}
      if (exists) docker('volume', 'rm', volume);
    } else await stop();
    writeFileSync(path.join(scratch, 'server.log'), log); rmSync(directory, { recursive: true, force: true });
  }
}
