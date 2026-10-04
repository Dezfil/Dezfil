import { appendFileSync, chmodSync, readFileSync } from 'node:fs';

export function fixtureLog(file) {
  appendFileSync(file, ''); chmodSync(file, 0o666);
  return row => appendFileSync(file, JSON.stringify({ at: Date.now(), ...row }) + '\n');
}

export function active() {
  return JSON.parse(readFileSync(`${process.env.PROBE_EVIDENCE}/active.json`, 'utf8'));
}
