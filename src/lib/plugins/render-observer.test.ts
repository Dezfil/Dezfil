import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

it('observes the standalone and parent-traced Puppeteer instances without replacing their results', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-observer-'));
  const cwd = path.join(root, '.next/standalone');
  const log = path.join(root, 'attempts.ndjson');
  const observer = path.join(process.cwd(), 'scripts/dezfil-render-observer.mjs');
  try {
    for (const [directory, name, result] of [
      [path.join(cwd, 'node_modules'), 'puppeteer-core', 'ordinary'],
      [path.join(root, '.next/node_modules'), 'puppeteer-core-traced', 'traced'],
    ]) {
      const target = path.join(directory, name);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'index.js'), `exports.default = { launch: async value => ${JSON.stringify(result)} + value };`);
    }
    const output = execFileSync(process.execPath, ['--import', observer, '-e',
      'Promise.all([require("puppeteer-core").default.launch(1), require("puppeteer-core-traced").default.launch(2)]).then(value => console.log(JSON.stringify(value)))',
    ], { cwd, env: { ...process.env, DEZFIL_PLUGIN_RENDER_LOG: log }, encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual(['ordinary1', 'traced2']);
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.phase === 'boot')).toHaveLength(1);
    expect(events.filter(event => event.phase === 'launch')).toHaveLength(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
