// Test-only process preload. Counts real browser launch attempts and does not
// answer, stub or replace a render. Shared file is readable by the probe client.
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(path.join(process.cwd(), 'server.js'));
const file = process.env.DEZFIL_PLUGIN_RENDER_LOG;
if (!file) throw new Error('A render observation file is required');
appendFileSync(file, JSON.stringify({ phase: 'boot', pid: process.pid }) + '\n');
// Next's standalone can trace a renamed external package alongside the ordinary
// package. Observe each distinct instance; no namespace object is mutable.
// A local standalone may resolve its traced alias from .next/node_modules.
// Stay inside this isolated build rather than following ancestor/global paths.
const cwd = process.cwd();
const root = path.basename(cwd) === 'standalone' && path.basename(path.dirname(cwd)) === '.next' ? path.resolve(cwd, '../..') : cwd;
const directories = require.resolve.paths('puppeteer-core').filter(directory => directory.startsWith(root + path.sep) && existsSync(directory));
const packages = directories.flatMap(directory => readdirSync(directory).filter(name => /^puppeteer-core(?:-[a-z0-9]+)?$/.test(name)).map(name => path.join(directory, name)));
const owners = new Set(packages.map(filename => require(filename).default));
if (owners.size === 0) throw new Error('Puppeteer launch observer cannot attach');
for (const owner of owners) {
  if (typeof owner?.launch !== 'function') throw new Error('Puppeteer launch observer cannot attach');
  const original = owner.launch;
  owner.launch = function (...args) {
    appendFileSync(file, JSON.stringify({ phase: 'launch', pid: process.pid }) + '\n');
    return original.apply(this, args);
  };
}
