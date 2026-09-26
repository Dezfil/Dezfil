import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';

// This one canonical TypeScript file is an ES module. Scope the declaration to
// this CLI import instead of changing the repository's package module semantics.
const guidanceUrl = new URL('../src/lib/assistant/guidance.ts', import.meta.url).href;
const moduleType = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === guidanceUrl ? { ...resolved, format: 'module-typescript' } : resolved;
  },
});
const { checkGuidance, readGuidanceLicense, renderGuidance } = await import('./dezfil-guidance.mjs');
moduleType.deregister();

const dir = new URL('../plugins/dezfil/skills/dezfil/', import.meta.url);
const file = new URL('analysis.md', dir);
if (process.argv.includes('--check')) {
  checkGuidance(await readFile(file, 'utf8'));
  if (await readFile(new URL('../../LICENSE-GeoSQL', dir), 'utf8') !== await readGuidanceLicense()) throw new Error('GeoSQL license drift');
  console.log('Dezfil guidance and license are current');
} else {
  await mkdir(dir, { recursive: true });
  await writeFile(file, renderGuidance());
  await writeFile(new URL('../../LICENSE-GeoSQL', dir), await readGuidanceLicense());
}
