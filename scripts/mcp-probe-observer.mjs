/* Test-only preload for the standalone/container process probes. It observes
 * actual marked DuckDB statements, never answers product requests. No SQL or
 * exception detail is recorded. The driver owns and removes the event file. */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
const runtimeRequire = createRequire(path.join(process.cwd(), 'server.js'));
const { DuckDBConnection } = runtimeRequire('@duckdb/node-api');
const file = process.env.DEZFIL_MCP_PROBE_LOG;
if (!file) throw new Error('The MCP probe requires an observation file.');
const instance = randomUUID();
let sequence = 0;
const record = event => appendFileSync(file, JSON.stringify({ ...event, instance, pid: process.pid, at: Date.now() }) + '\n');
record({ phase: 'boot' });
for (const method of ['run']) {
  const original = DuckDBConnection.prototype[method];
  DuckDBConnection.prototype[method] = async function(sql, ...args) {
    const tag = typeof sql === 'string' && sql.match(/mcpprobe_(standalone|member|departure|notification|timeout)/)?.[1];
    const executing = tag && /^\s*(SELECT|COPY)\b/i.test(sql);
    if (!executing) return original.call(this, sql, ...args);
    const id = ++sequence;
    record({ phase: 'start', tag, id });
    try { return await original.call(this, sql, ...args); }
    finally { record({ phase: 'settle', tag, id }); }
  };
}
