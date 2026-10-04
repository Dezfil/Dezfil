// Test-only preload for a scratch standalone. Pause after the real engine has
// read a marked statement, before the application can return or commit it.
import { createRequire } from 'node:module';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
const runtimeRequire = createRequire(path.join(process.cwd(), 'server.js'));
const { DuckDBConnection } = runtimeRequire('@duckdb/node-api');
if (!process.env.DEZFIL_DATA_DIR) throw new Error('The Leave observer needs a scratch DEZFIL_DATA_DIR.');
const directory = path.join(process.env.DEZFIL_DATA_DIR, '.leave-probe');
await mkdir(directory, { recursive: true });
const seen = new Set();
for (const method of ['run', 'runAndReadAll']) {
  const original = DuckDBConnection.prototype[method];
  DuckDBConnection.prototype[method] = async function (sql, ...args) {
    const tag = typeof sql === 'string' && sql.match(/leaveprobe_(read|output)_[0-9a-f]{12}/)?.[0];
    const eligible = tag && !seen.has(tag) && (tag.includes('_output_')
      ? method === 'run' && /^COPY \(/.test(sql)
      : method === 'runAndReadAll' && /^SELECT \*/.test(sql));
    if (!eligible) return original.call(this, sql, ...args);
    seen.add(tag);
    const value = await original.call(this, sql, ...args);
    await writeFile(path.join(directory, `${tag}.ready`), JSON.stringify({ method, executions: 1, pid: process.pid }));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { await access(path.join(directory, `${tag}.release`)); break; } catch { /* The client has not released it yet. */ }
      if (Date.now() >= deadline) throw new Error('Leave probe hold was not released.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return value;
  };
}
