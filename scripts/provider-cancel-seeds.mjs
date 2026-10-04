import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Deliberate, reversible defects. Run only in a disposable checkout, with no
// concurrent edits. Each command must fail its assertions; restoration is in finally.
const seeds = {
  'search-signal': { file: 'src/lib/search/provider.ts', from: /\n\s+signal,/g, to: '', tests: ['src/lib/search/provider-signal.test.ts'], socket: true },
  'inspect-signal': { file: 'src/lib/net/inspect-style.ts', from: '\n      signal,', to: '', tests: ['src/lib/net/inspect-style.test.ts'], socket: true },
  'search-route-signal': { file: 'src/app/api/maps/[id]/search/route.ts', from: 'searchPlaces(q, request.signal)', to: 'searchPlaces(q)', tests: ['src/app/api/maps/[id]/search/route.test.ts'] },
  'inspect-route-signal': { file: 'src/app/api/basemap/inspect/route.ts', from: 'inspectStyle(url, undefined, request.signal)', to: 'inspectStyle(url)', tests: ['src/app/api/basemap/inspect/route.test.ts'] },
  'sequence-only': { file: 'src/components/builder/CustomBasemapSection.tsx', from: '    checkAbort.current?.abort();', to: '', tests: ['src/components/builder/CustomBasemapSection.test.tsx'] },
  'search-caller-no-abort': { file: 'src/components/builder/search/use-search.ts', from: /abortRef.current\?\.abort\(\);/g, to: '', tests: ['src/components/builder/search/use-search.test.tsx'] },
  'search-sequence': { file: 'src/components/builder/search/use-search.ts', from: /if \(seqRef.current !== seq\) return;/g, to: '', tests: ['src/components/builder/search/use-search.test.tsx'] },
  'style-sequence': { file: 'src/components/builder/CustomBasemapSection.tsx', from: '    checkSeq.current++;', to: '', tests: ['src/components/builder/CustomBasemapSection.test.tsx'] },
  'search-byte-cap': { file: 'src/lib/search/provider.ts', from: 'const MAX_BYTES = 1_000_000;', to: 'const MAX_BYTES = 2_000_000;', tests: ['src/lib/search/provider-signal.test.ts'] },
  'style-byte-cap': { file: 'src/lib/net/inspect-style.ts', from: 'export const STYLE_BYTE_CAP = 2 * 1024 * 1024;', to: 'export const STYLE_BYTE_CAP = 4 * 1024 * 1024;', tests: ['src/lib/net/inspect-style.test.ts'] },
  'search-timeout': { file: 'src/lib/search/provider.ts', from: 'timeoutMs: limits.geocodeRequestTimeoutMs,', to: 'timeoutMs: 1_000,', tests: ['src/lib/search/provider-signal.test.ts'] },
  'style-timeout': { file: 'src/lib/net/inspect-style.ts', from: 'export const STYLE_TIMEOUT_MS = 8_000;', to: 'export const STYLE_TIMEOUT_MS = 1_000;', tests: ['src/lib/net/inspect-style.test.ts'] },
  'search-attribution': { file: 'src/lib/search/provider.ts', from: 'attribution: licence, results', to: 'attribution: null, results', tests: ['src/lib/search/provider-signal.test.ts'] },
  'style-verdict': { file: 'src/lib/net/inspect-style.ts', from: 'name: style.name,', to: 'name: null,', tests: ['src/lib/net/inspect-style.test.ts'] },
  'capacity-release': { file: 'src/lib/search/provider.ts', from: '    release();', to: '', tests: ['src/lib/search/provider-signal.test.ts'] },
  'redirect-limit': { file: 'src/lib/net/remote-fetch.ts', from: 'const MAX_REDIRECTS = 5;', to: 'const MAX_REDIRECTS = 6;', tests: ['src/lib/net/remote-fetch-lifetime.test.ts'], socketOnly: true },
  'search-pacing': { file: 'src/lib/search/provider.ts', from: /await takeSlot\([\s\S]*?\n  \);/, to: '() => {};', tests: ['src/lib/search/provider.test.ts'], socketOnly: true },
  'force-save': { file: 'src/lib/basemap-custom.ts', from: 'if (!force)', to: 'if (false)', tests: ['src/lib/basemap-custom.test.ts'] },
  'save-attribution': { file: 'src/lib/basemap-custom.ts', from: 'inspection.attribution', to: '[]', tests: ['src/lib/basemap-custom.test.ts'] },
};
const [name, mode] = process.argv.slice(2);
if (name === '--list') console.log(Object.keys(seeds).join('\n'));
else {
  assert.ok(process.env.DEZFIL_DATA_DIR, 'Set DEZFIL_DATA_DIR to a fresh scratch directory');
  const seed = seeds[name];
  assert.ok(seed, 'Select a seed from --list');
  assert.ok(!mode || ['--socket', '--prepare'].includes(mode), 'Use --socket or --prepare');
  assert.ok(!seed.socketOnly || mode, 'This seed needs real listeners: pass --socket outside the sandbox');
  await mkdir('.claude/scratch', { recursive: true });
  const scratch = await mkdtemp(`${process.cwd()}/.claude/scratch/provider-seed-`);
  const original = await readFile(seed.file, 'utf8');
  const changed = original.replace(seed.from, seed.to);
  assert.notEqual(original, changed, 'Seed no longer matches the implementation');
  if (mode === '--prepare') {
    // Allows an outside observer to rebuild and run a browser/route probe. The
    // explicit restore command is printed; this mode never claims a test ran.
    await writeFile(`${scratch}/original`, original);
    await writeFile(seed.file, changed);
    console.log(`Seed applied. After the outside run restore with: cp '${scratch}/original' '${seed.file}'`);
  } else {
    try {
      await writeFile(seed.file, changed);
      const tests = mode === '--socket' && seed.socket ? ['src/lib/net/provider-cancel.test.ts'] : seed.tests;
      const report = `${scratch}/result.json`;
      const data = await mkdtemp('/tmp/dezfil-test-');
      const result = spawnSync('npm', ['test', '--', ...tests, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`], { stdio: 'inherit', env: { ...process.env, DEZFIL_DATA_DIR: data } });
      assert.equal(result.signal, null, 'A killed test is not an observed red');
      assert.equal(result.status, 1, 'Seed must make the selected assertions fail');
      const results = JSON.parse(await readFile(report, 'utf8'));
      assert.ok(results.testResults.some(file => file.assertionResults.some(test =>
        test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError')),
      )), 'A setup, import or listener failure is not an assertion red');
    } finally { await writeFile(seed.file, original); }
    console.log(`Observed red and restored: ${name}`);
  }
}
