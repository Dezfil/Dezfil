import { expect, it } from 'vitest';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preparePackage, resolvePackage } from '../../../scripts/dezfil-package.mjs';

it('1d/3c: both copied formats carry precisely two readable references with full notices', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-resources-'));
  try {
    const root = path.join(dir, 'catalog'); await preparePackage({ destination: root });
    for (const client of ['claude', 'codex'] as const) {
      const installed = await resolvePackage(root, client);
      expect(await readdir(installed.skills)).toEqual(['dezfil']);
      const references = path.join(installed.skills, 'dezfil/references');
      expect((await readdir(references)).sort()).toEqual(['cartography.md', 'duckdb-spatial.md']);
      const license = await readFile(path.join(installed.plugin, 'LICENSE-GeoSQL'), 'utf8');
      expect(license).toBe(await readFile('src/lib/plugins/fixtures/geosql-license.txt', 'utf8'));
      expect(license).toContain('Copyright (c) 2026 dekart.xyz');
      expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
      for (const file of ['references/cartography.md', 'references/duckdb-spatial.md', 'analysis.md']) {
        const text = await readFile(path.join(installed.skills, 'dezfil', file), 'utf8');
        expect(text).toContain(license.trim());
        expect(text).toContain('d2809ff65ca05b68fa423b61ad6e9f98f6d62cc6');
      }
      for (const file of ['LICENSE', 'NOTICE', 'sources.json', 'skills/dezfil/analysis.md']) expect((await readFile(path.join(installed.plugin, file))).length).toBeGreaterThan(0);
      const skill = await readFile(path.join(installed.skills, 'dezfil/SKILL.md'), 'utf8');
      for (const [, link] of skill.matchAll(/\]\(([^)]+)\)/g)) expect((await readFile(path.resolve(installed.skills, 'dezfil', link))).length).toBeGreaterThan(0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
