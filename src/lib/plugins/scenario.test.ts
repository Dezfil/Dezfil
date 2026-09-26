import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as packages from '../../../scripts/dezfil-package.mjs';
import * as journeys from '../../../scripts/dezfil-installed-journey.mjs';
import { packageScenario } from '../../../scripts/dezfil-package-scenario.mjs';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

for (const seed of ['preparer drops base URL', 'Codex chain resolves another instance']) {
  it(`4a isolation: rejects ${seed} before the good journey connects`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-scenario-')); directories.push(dir);
    const prepare = packages.preparePackage;
    const resolve = packages.resolvePackage;
    vi.spyOn(packages, 'preparePackage').mockImplementation(options => prepare({ ...options,
      ...(seed === 'preparer drops base URL' && options.destination.endsWith('/installed') ? { baseUrl: undefined } : {}),
    }));
    vi.spyOn(packages, 'resolvePackage').mockImplementation(async (root, client) => {
      const result = await resolve(root, client);
      return seed.startsWith('Codex') && client === 'codex' ? { ...result, url: 'http://localhost:3000/api/mcp' } : result;
    });
    // Only the deliberate loopback trap may receive traffic. The good journey
    // is stubbed so the regression seed cannot contact the administrator's instance.
    const drive = vi.spyOn(journeys, 'installedJourney').mockImplementation(async root => {
      if (root.endsWith('/bad-url')) {
        const config = JSON.parse(await readFile(path.join(root, 'plugins/dezfil/.mcp.json'), 'utf8'));
        await fetch(config.mcpServers.dezfil.url);
        throw Object.assign(new Error('wrong endpoint fixture'), { journeyReport: { setup: 2, connections: 0, productCalls: 0 } });
      }
      return { setup: 2, connections: 1, productCalls: 39 } as Awaited<ReturnType<typeof journeys.installedJourney>>;
    });
    await expect(packageScenario(dir, 'http://127.0.0.1:3399')).rejects.toThrow(
      seed.startsWith('Codex') ? /codex.*selected isolated instance/ : /claude.*selected isolated instance/,
    );
    expect(drive.mock.calls.map(([root]) => path.basename(root))).toEqual(['bad-url']);
  });
}
