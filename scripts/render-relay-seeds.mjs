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
const driver = 'src/lib/export/render-driver.ts';
const proxy = 'src/lib/export/render-proxy.ts';
const lifetime = 'src/lib/export/render-lifetime.test.ts';
const driverUnit = 'src/lib/export/render-driver-relay.test.ts';
const startupError = `throw new ApiError("render_failed", "The image could not be rendered. Retry; if it persists, the " +
          "instance's renderer needs attention.", 502);`;
const omitClose = { file: driver, from: 'async close() {\n          relay.close();', to: 'async close() {' };
const omitKill = { file: driver, from: 'kill() {\n          relay.close();', to: 'kill() {' };
const extendRelay = { file: driver, from: 'startRenderRelay(context)', to: 'startRenderRelay({ ...context, signal: undefined, deadline: Date.now() + 10_000 })' };
const seeds = [
  { name: 'parser', file: 'src/lib/export/render-socks.ts', from: 'b[1] !== 1)', to: 'b[1] !== 1 && b[1] !== 3)', test: 'src/lib/export/render-socks.test.ts', pattern: 'malformed/unsupported', unit: true },
  { name: 'second-lookup', file: relay, from: 'for (let index = 0;', to: 'admission.addresses = await options.resolve!(host);\n      for (let index = 0;', test: sockets, pattern: 'pins the actual connection' },
  { name: 'unchecked-literal', file: address, from: 'isAddressAllowed(host, address)', to: '(isIP(host) || isAddressAllowed(host, address))', test: unit, pattern: 'checks literals', unit: true, socketPattern: 'checks a local client' },
  { name: 'mixed-answer', file: address, from: 'addresses.every(', to: 'addresses.some(', test: unit, pattern: 'whole mixed set', unit: true, socketPattern: 'mixed answer' },
  ...['hostname', 'IP', 'CIDR'].map(kind => ({ name: `omitted-${kind.toLowerCase()}-exception`, file: address,
    from: 'isAddressAllowed(host, address)', to: 'isAddressAllowed("unlisted.invalid", address) && !address.startsWith("127.")',
    test: unit, pattern: `preserves the ${kind} exception`, unit: true, socketPattern: `retains the ${kind} exception` })),
  { name: 'first-address-only', file: relay, from: 'index < admission.addresses.length', to: 'index < Math.min(1, admission.addresses.length)', test: sockets, pattern: 'falls back' },
  { name: 'startup-classification', file: driver, from: startupError, to: 'throw Error("Relay unavailable");', test: driverUnit, pattern: 'startup failure', unit: true,
    outsideTest: lifetime, socketPattern: 'forced bind failure' },
  { name: 'direct-fallback', edits: [
    { file: driver, from: startupError, to: 'relay = { port: 0, refused: false, close() {}, settleAdmissions: async () => {} };' },
    { file: proxy, from: '  const app = new URL(appOrigin);', to: '  if (!relayPort) return [];\n  const app = new URL(appOrigin);' },
  ], test: driverUnit, pattern: 'startup failure', unit: true, outsideTest: lifetime, socketPattern: 'forced bind failure' },
  { name: 'connection-report', file: relay, from: 'if (admission.verdict === "deny") refused = true;', to: 'if (admission.verdict === "deny") refused = false;',
    test: lifetime, pattern: 'real refusal during capture' },
  { name: 'capture-refusal', file: driver, from: '            if (refused.length || relay.refused) return { failed: EGRESS_REFUSAL };', to: '', count: 2,
    test: driverUnit, pattern: 'refusal during capture', unit: true, outsideTest: lifetime, socketPattern: 'real refusal during capture' },
  { name: 'transport-as-policy', file: relay, from: 'if (admission.verdict === "deny") refused = true;', to: 'refused = true;',
    test: sockets, pattern: 'a dns failure' },
  { name: 'broadened-scheme', file: proxy, from: '${app.protocol}//${app.hostname}:${port}', to: '${app.hostname}:${port}',
    test: 'src/lib/export/render-proxy.test.ts', pattern: 'exception is exact', unit: true,
    outsideTest: 'src/lib/export/render-proxy.browser.test.ts', socketPattern: 'shipped browser', browser: true },
  { name: 'broadened-port', file: proxy, from: '${app.hostname}:${port}', to: '${app.hostname}',
    test: 'src/lib/export/render-proxy.test.ts', pattern: 'exception is exact', unit: true,
    outsideTest: 'src/lib/export/render-proxy.browser.test.ts', socketPattern: 'shipped browser', browser: true },
  { name: 'implicit-loopback', file: proxy, from: '<-loopback>;', to: '',
    test: 'src/lib/export/render-proxy.test.ts', pattern: 'exception is exact', unit: true,
    outsideTest: 'src/lib/export/render-proxy.browser.test.ts', socketPattern: 'shipped browser', browser: true },
  ...['success', 'refusal', 'launch-failure', 'crash', 'timeout', 'cancellation'].map(ending => ({
    name: `cleanup-${ending}`, test: lifetime, pattern: `ending ${ending} leaves`,
    edits: ending === 'launch-failure' ? [{ file: driver, from: '} catch (error) {\n        relay.close();', to: '} catch (error) {' }]
      : ending === 'timeout' || ending === 'cancellation' ? [omitClose, omitKill, extendRelay] : [omitClose],
  })),
  { name: 'late-dns', edits: [
    { file: relay, from: 'if (closed) return;\n      if (admission.verdict', to: 'if (admission.verdict' },
    { file: relay, from: 'if (closed || client.destroyed || Date.now() >= connectDeadline) return;', to: 'if (Date.now() >= connectDeadline) return;' },
  ], test: sockets, pattern: 'revokes late DNS', assertion: 'late DNS must not dial or reach the target after relay close' },
  { name: 'abandoned-refusal', file: relay, from: 'if (closed) return;\n      if (admission.verdict',
    to: 'if (closed || client.destroyed) return;\n      if (admission.verdict', test: lifetime, pattern: 'abandoned connection verdict' },
  { name: 'pending-admission', file: driver, from: 'await relay.settleAdmissions();', to: '', count: 2,
    test: driverUnit, pattern: 'verdict that outlives capture', unit: true, outsideTest: lifetime, socketPattern: 'abandoned connection verdict' },
  { name: 'shared-state', file: relay,
    from: 'export async function startRenderRelay(options: RenderRelayOptions): Promise<RenderRelay> {\n  const sockets = new Set<Socket>();',
    to: 'const sockets = new Set<Socket>();\nexport async function startRenderRelay(options: RenderRelayOptions): Promise<RenderRelay> {',
    test: sockets, pattern: 'two relays own independent' },
  { name: 'credential-redirect', file: 'src/lib/export/render-credentials.ts', from: 'if (url.origin === appOrigin)', to: 'if (true)',
    test: 'src/lib/export/render-driver-auth.test.ts', pattern: 'identity only into exact-origin', unit: true },
];
if (process.argv.includes('--list')) { console.log(seeds.map(seed => seed.name).join('\n')); process.exit(0); }
const unitOnly = process.argv.includes('--unit');
const browserProof = process.argv.includes('--browser');
if (browserProof && process.env.DEZFIL_RELAY_BROWSER !== '1') throw Error('Set DEZFIL_RELAY_BROWSER=1 for the explicitly requested browser proof');
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
  const proofs = [{ test: seed.test, pattern: seed.pattern }, ...(!unitOnly && seed.socketPattern && (!seed.browser || browserProof) ? [{ test: seed.outsideTest ?? sockets, pattern: seed.socketPattern }] : [])];
  for (const [index, proof] of proofs.entries()) {
    const edits = seed.edits ?? [seed];
    const originals = new Map();
    for (const edit of edits) {
      const original = await readFile(edit.file, 'utf8');
      originals.set(edit.file, original);
      if (original.split(edit.from).length !== (edit.count ?? 1) + 1) throw Error(`Seed anchor count changed: ${seed.name}`);
    }
    const scratch = await mkdtemp('/tmp/dezfil-test-');
    const green = run({ ...seed, ...proof, scratch }, 'RESTORED');
    await writeFile(`${logdir}/${seed.name}-${index}-green.log`, green.output);
    if (green.result.status !== 0) throw Error(`Unmodified proof failed: ${seed.name}; see ${logdir}`);
    try {
      const mutations = new Map(originals);
      for (const edit of edits) mutations.set(edit.file, mutations.get(edit.file).replaceAll(edit.from, edit.to));
      for (const [file, mutated] of mutations) await writeFile(file, mutated);
      const red = run({ ...seed, ...proof, scratch: await mkdtemp('/tmp/dezfil-test-') }, 'SEEDED');
      await writeFile(`${logdir}/${seed.name}-${index}-red.log`, red.output);
      if (red.result.status !== 1 || !/AssertionError|expected .* to|observation missing/.test(red.output) || /EPERM|Failed Suites|Unhandled Error/.test(red.output)
        || (seed.assertion && !red.output.includes(`AssertionError: ${seed.assertion}:`))) {
        throw Error(`Seed did not fail its assertion: ${seed.name}; see ${logdir}`);
      }
      console.log(`PASS ${seed.name}: restored green, seeded assertion red (${proof.test})`);
    } finally { for (const [file, original] of originals) await writeFile(file, original); }
  }
}
