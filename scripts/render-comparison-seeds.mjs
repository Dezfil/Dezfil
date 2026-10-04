// Image seeds affect only the mounted observer, never source or the image.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const scripts = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const image = option('--image'), baseline = option('--baseline'), directory = process.env.DEZFIL_DATA_DIR;
const seeds = [
  { name: 'broken-tunnel', suite: 'tls', index: 0, assertion: 'trusted-style-tiles-identity-pixels' },
  { name: 'certificate-bypass-untrusted', suite: 'tls', index: 1, assertion: 'untrusted-validation-no-pixels' },
  { name: 'certificate-bypass-wrong-host', suite: 'tls', index: 2, assertion: 'wrong-host-validation-no-pixels' },
  { name: 'direct-bypass', suite: 'timing', index: 2, assertion: 'guarded-tile-responses' },
  { name: 'delay', suite: 'paired' },
];
let child, interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; child?.kill(signal); });
try {
  assert.ok(image && directory && path.isAbsolute(directory), 'image and fresh scratch required');
  assert.deepEqual(await readdir(directory), []);
  const selected = seeds.filter(seed => !option('--seed') || seed.name === option('--seed')); assert.ok(selected.length, 'unknown seed');
  for (const seed of selected) {
    if (seed.suite === 'paired') assert.ok(baseline, '--baseline required for delay seed');
    for (const mutated of [false, true]) {
      assert.ok(!interrupted, 'interrupted');
      const output = path.join(directory, `${seed.name}-${mutated ? 'red' : 'green'}`); await mkdir(output);
      const command = seed.suite === 'paired' ? ['render-paired-driver.mjs', '--baseline', baseline] : ['render-egress-driver.mjs', '--suite', seed.suite, '--index', String(seed.index), ...(seed.suite === 'timing' ? ['--candidate'] : [])];
      const exitCode = await new Promise((resolve, reject) => {
        child = spawn(process.execPath, [path.join(scripts, command[0]), ...command.slice(1), '--image', image, ...(mutated ? ['--seed', seed.name] : [])], { env: { ...process.env, DEZFIL_DATA_DIR: output }, stdio: 'inherit' });
        child.once('error', reject); child.once('exit', resolve);
      }); child = undefined;
      assert.ok(!interrupted, 'interrupted');
      if (!mutated) assert.equal(exitCode, 0, `${seed.name}: unseeded control failed`);
      else {
        assert.equal(exitCode, 1, `${seed.name}: seed did not fail`);
        if (seed.suite === 'paired') {
          const report = JSON.parse(await readFile(path.join(output, 'paired-report.json'), 'utf8'));
          assert.ok(report.attempts.some(run => run.summary.valid && !run.summary.withinBound), 'delay must fail the ratio on a complete paired run, not setup or timeout');
        } else {
          const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'));
          assert.ok(report.report.some(row => row.checks?.some(check => check.name === seed.assertion && !check.ok)), `missing intended assertion red: ${seed.assertion}`);
          assert.ok(report.report.every(row => !row.failure && !row.result?.failure), 'infrastructure failure is not a seed red');
          if (seed.name === 'direct-bypass') assert.ok(report.report.every(row => row.checks.find(check => check.name === 'at-least-64-completed-tiles')?.ok), 'direct seed must still complete 64 browser/fixture tiles');
        }
      }
    }
    console.log(`PASS seed ${seed.name}: unseeded green, intended assertion red`);
    await writeFile(path.join(directory, `${seed.name}.json`), JSON.stringify({ seed: seed.name, control: 'pass', mutant: 'intended assertion failed' }));
  }
} catch (error) { console.error(`FAIL seeds ${error.message}`); process.exitCode = 1; }
