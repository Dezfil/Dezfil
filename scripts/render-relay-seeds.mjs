#!/usr/bin/env node
// Applies one defect at a time, runs its named proof, and restores exact bytes.
// Never run this alongside an editor or another test/build process in this tree.
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const address = 'src/lib/export/render-address.ts';
const relay = 'src/lib/export/render-relay.ts';
const unit = 'src/lib/export/render-address.test.ts';
const sockets = 'src/lib/export/render-relay.test.ts';
const seeds = [
  { name: 'parser', file: 'src/lib/export/render-socks.ts', from: 'b[1] !== 1)', to: 'b[1] !== 1 && b[1] !== 3)', test: 'src/lib/export/render-socks.test.ts', pattern: 'malformed/unsupported', unit: true },
  { name: 'second-lookup', file: relay, from: 'for (let index = 0;', to: 'admission.addresses = await options.resolve!(host);\n      for (let index = 0;', test: sockets, pattern: 'pins the actual connection' },
  { name: 'unchecked-literal', file: address, from: 'isAddressAllowed(host, address)', to: '(isIP(host) || isAddressAllowed(host, address))', test: unit, pattern: 'checks literals', unit: true, socketPattern: 'checks a local client' },
  { name: 'mixed-answer', file: address, from: 'addresses.every(', to: 'addresses.some(', test: unit, pattern: 'whole mixed set', unit: true, socketPattern: 'mixed answer' },
  ...['hostname', 'IP', 'CIDR'].map(kind => ({ name: `omitted-${kind.toLowerCase()}-exception`, file: address,
    from: 'isAddressAllowed(host, address)', to: 'isAddressAllowed("unlisted.invalid", address) && !address.startsWith("127.")',
    test: unit, pattern: `preserves the ${kind} exception`, unit: true, socketPattern: `retains the ${kind} exception` })),
  { name: 'first-address-only', file: relay, from: 'index < admission.addresses.length', to: 'index < Math.min(1, admission.addresses.length)', test: sockets, pattern: 'falls back' },
];
if (process.argv.includes('--list')) { console.log(seeds.map(seed => seed.name).join('\n')); process.exit(0); }
const unitOnly = process.argv.includes('--unit');
const requested = process.argv.find(arg => arg.startsWith('--seed='))?.slice(7);
if (requested && !seeds.some(seed => seed.name === requested)) throw Error('Unknown seed');
const logdir = resolve(process.env.RELAY_SEED_LOG_DIR ?? '.claude/logs/render-relay-seeds');
await mkdir(logdir, { recursive: true });
function run(seed, suffix) {
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', seed.test, '-t', seed.pattern], {
    encoding: 'utf8', env: { ...process.env, DEZFIL_DATA_DIR: seed.scratch }, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  return { result, output: `${suffix}\n${result.stdout ?? ''}${result.stderr ?? ''}` };
}
for (const seed of seeds.filter(seed => (!unitOnly || seed.unit) && (!requested || requested === seed.name))) {
  const proofs = [{ test: seed.test, pattern: seed.pattern }, ...(!unitOnly && seed.socketPattern ? [{ test: sockets, pattern: seed.socketPattern }] : [])];
  for (const [index, proof] of proofs.entries()) {
    const original = await readFile(seed.file, 'utf8');
    if (original.split(seed.from).length !== 2) throw Error(`Seed anchor is not unique: ${seed.name}`);
    const scratch = await mkdtemp('/tmp/dezfil-test-');
    const green = run({ ...seed, ...proof, scratch }, 'RESTORED');
    await writeFile(`${logdir}/${seed.name}-${index}-green.log`, green.output);
    if (green.result.status !== 0) throw Error(`Unmodified proof failed: ${seed.name}; see ${logdir}`);
    try {
      await writeFile(seed.file, original.replace(seed.from, seed.to));
      const red = run({ ...seed, ...proof, scratch: await mkdtemp('/tmp/dezfil-test-') }, 'SEEDED');
      await writeFile(`${logdir}/${seed.name}-${index}-red.log`, red.output);
      if (red.result.status !== 1 || !/AssertionError|expected .* to|observation missing/.test(red.output) || /EPERM|Failed Suites|Unhandled Error/.test(red.output)) {
        throw Error(`Seed did not fail its assertion: ${seed.name}; see ${logdir}`);
      }
      console.log(`PASS ${seed.name}: restored green, seeded assertion red (${proof.test})`);
    } finally { await writeFile(seed.file, original); }
  }
}
