// Serial host-side owner. Every child removes its own exact Docker names.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { pairedSummary } from './render-comparison-assert.mjs';
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const directory = process.env.DEZFIL_DATA_DIR, baseline = option('--baseline'), candidate = option('--image'), seed = option('--seed');
const scripts = path.dirname(fileURLToPath(import.meta.url));
const attempts = [], maxRuns = Number(option('--max-runs') ?? 3);
let child, interrupted = false, owned = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; child?.kill(signal); });
async function save() {
  await writeFile(path.join(directory, 'paired-report.json'), JSON.stringify({ host: os.hostname(), platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    baseline, candidate, seed, resources: { cpus: 2, memory: '4g', cache: 'disabled', freshBrowser: true },
    attemptedRuns: attempts.length, voidedRuns: attempts.filter(run => !run.summary?.valid).length, attempts }, null, 2));
}
try {
  assert.ok(baseline && candidate, 'Usage: DEZFIL_DATA_DIR=<empty scratch> node scripts/render-paired-driver.mjs --baseline IMAGE --image IMAGE [--seed delay]');
  assert.ok(!seed || seed === 'delay', 'only the delay seed applies to a whole paired run');
  assert.ok(Number.isInteger(maxRuns) && maxRuns >= 1 && maxRuns <= 10, 'max-runs must be 1..10');
  assert.ok(directory && path.isAbsolute(directory)); assert.deepEqual(await readdir(directory), []); owned = true;
  if (option('--prior-report')) {
    const previous = JSON.parse(await readFile(option('--prior-report'), 'utf8'));
    // Retain prior outcomes, including interruption, rather than silently
    // turning a new invocation into the first attempted paired run.
    attempts.push(...previous.attempts.map(attempt => ({ ...attempt, retainedFrom: option('--prior-report') })));
  }
  let passed = false;
  for (let run = 0; run < maxRuns && !interrupted; run++) {
    const attempt = { number: attempts.length + 1, rows: [], startedAt: new Date().toISOString(), summary: null };
    attempts.push(attempt); await save();
    try {
      for (let index = 0; index < 12; index++) {
        const order = index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
        for (const version of order) {
          if (interrupted) throw Error('interrupted; entire paired run void');
          const output = path.join(directory, `run-${attempt.number}-${index}-${version}`); await mkdir(output);
          const driverArgs = [path.join(scripts, 'render-egress-driver.mjs'), '--image', version === 'baseline' ? baseline : candidate, '--suite', 'timing', '--index', String(index),
            ...(version === 'candidate' ? ['--candidate'] : []), ...(version === 'candidate' && seed ? ['--seed', seed, '--delay-ms', '10000'] : [])];
          const exitCode = await new Promise((resolve, reject) => {
            child = spawn(process.execPath, driverArgs, { env: { ...process.env, DEZFIL_DATA_DIR: output }, stdio: 'inherit' });
            child.once('error', reject); child.once('exit', code => resolve(code));
          });
          child = undefined;
          const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'));
          const row = report.report[0]; assert.ok(row, 'child evidence missing');
          attempt.rows.push({ ...row, version, evidence: output }); await save();
          assert.equal(exitCode, 0, `${version} export ${index} failed; entire paired run void`);
        }
      }
      attempt.summary = pairedSummary(attempt.rows);
    } catch (error) { attempt.summary = { ...pairedSummary(attempt.rows), valid: false, ratio: null, baselineMedianMs: null, candidateMedianMs: null, deltaMs: null, withinBound: false,
      reasons: [...pairedSummary(attempt.rows).reasons, error.message] }; }
    await save();
    console.log(JSON.stringify({ run: attempt.number, ...attempt.summary }));
    if (!attempt.summary.valid) { console.error(`VOID run ${attempt.number}; retained and counted. Repeating both warmups and all samples.`); continue; }
    if (attempt.summary.explanationNeeded) console.log('REPORT ratio above 1.2: outside profile/explanation required; this is not a second gate.');
    passed = attempt.summary.withinBound;
    // A valid slow run is a failed bound, not a void or a reason to select a
    // faster repeat. The outside operator decides how to investigate it.
    break;
  }
  assert.ok(passed && !interrupted, 'no valid paired run within 1.5x; retain evidence and escalate repeated failures');
} catch (error) { console.error(`FAIL paired ${error.message}`); process.exitCode = 1; }
finally { if (owned) await save(); }
