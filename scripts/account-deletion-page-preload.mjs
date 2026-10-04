// Proof-only stale bundle-state seed. Resolve the standalone server's own
// dependency, not the checkout's second copy of the native module.
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/server.js`);
const Database = require('better-sqlite3');
const prepare = Database.prototype.prepare;
const cached = new Map();
let replay = false;
Database.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql);
  if (!/^\s*SELECT\b/i.test(sql) || !/\b(accounts|maps|projects|project_people)\b/i.test(sql)) return statement;
  for (const method of ['get', 'all']) {
    const original = statement[method].bind(statement);
    statement[method] = (...args) => {
      const key = JSON.stringify([this.name, sql, method, args]);
      if (replay && cached.has(key)) return structuredClone(cached.get(key));
      const value = original(...args);
      cached.set(key, structuredClone(value)); return value;
    };
  }
  return statement;
};
export function replayCachedAdmission() { replay = true; }
process.on('message', message => { if (message === 'replay-cached-admission') { replayCachedAdmission(); process.send?.('cache-replay-ready'); } });
