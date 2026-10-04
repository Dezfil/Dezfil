// Test-only preload: observes real native starts/settlements and route state.
// It neither holds work nor introduces an HTTP endpoint.
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Server } from 'node:http';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { requireIngress } = await import(pathToFileURL(path.resolve('src/lib/auth/ingress.mjs')));
const file = process.env.DEZFIL_TEST_DERIVATION_LOG;
if (!file) throw new Error('DEZFIL_TEST_DERIVATION_LOG is required');
const context = new AsyncLocalStorage(), key = Symbol.for('dezfil.password-derivations');
let nativeActive = 0;
const write = row => {
  const state = process[key], current = context.getStore();
  let source; try { source = requireIngress(new Headers(current?.request.headers)).source; } catch { /* fails evidence checks */ }
  appendFileSync(file, JSON.stringify({ ...row, tag: current?.tag, path: current?.request.url, source, nativeActive,
    admission: state ? { active: state.active, activeProtected: state.activeProtected, ordinary: state.ordinary.length, protected: state.protected.length } : null }) + '\n');
};
write({ phase: 'boot' });
const emit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  const [request, response] = args;
  if (event !== 'request' || !request.headers['x-dezfil-test-derivation']) return emit.call(this, event, ...args);
  return context.run({ request, tag: request.headers['x-dezfil-test-derivation'] }, () => {
    response.once('finish', () => write({ phase: 'response', status: response.statusCode }));
    return emit.call(this, event, ...args);
  });
};
// Queued submission is invoked by the preceding job's completion. Preserve
// the enqueueing request's observation context without delaying or holding it.
const push = Array.prototype.push;
Array.prototype.push = function (...items) {
  const state = process[key];
  if (state && (this === state.ordinary || this === state.protected)) {
    const queuedContext = context.getStore();
    for (const item of items) {
      const start = item.start;
      item.start = () => context.run(queuedContext, start);
    }
  }
  return push.apply(this, items);
};
const scrypt = crypto.scrypt;
crypto.scrypt = function (...args) {
  const started = performance.now(), callback = args.pop(); nativeActive++;
  write({ phase: 'start', cost: args[3]?.N });
  args.push((...result) => {
    nativeActive--; write({ phase: 'end', elapsedMs: performance.now() - started });
    callback(...result);
  });
  try { return scrypt.apply(this, args); }
  catch (error) { nativeActive--; write({ phase: 'end', elapsedMs: performance.now() - started, submissionFailed: true }); throw error; }
};
syncBuiltinESMExports();
