import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile, mkdtemp, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testClient } from '@/lib/mcp/test-client';
import { checkNamedOperations, checkPackageCopy } from '../../../scripts/dezfil-package-checks.mjs';

const root = 'plugins/dezfil';
const skillPath = `${root}/skills/dezfil/SKILL.md`;
afterEach(() => vi.unstubAllGlobals());
it('every wrapper family names an operation in the received live listing', async () => {
  const client = await testClient(() => { throw new Error('Listing needs no API call'); });
  try {
    const { tools } = await client.listTools(); const skill = await readFile(skillPath, 'utf8');
    const analysis = await readFile(`${root}/skills/dezfil/analysis.md`, 'utf8');
    expect(checkNamedOperations(skill, tools, analysis).length).toBeGreaterThan(15);
    expect(() => checkNamedOperations(skill, tools, analysis.replace('list_tables', 'invented_grounding_operation'))).toThrow(/absent from listing: invented_grounding_operation/);
    expect(() => checkNamedOperations(skill.replace('`run_sql`', '`invented_operation`'), tools, analysis)).toThrow(/absent from listing/);
  } finally { await client.close(); }
});
it('package Markdown and manifest copy, including a failable em-dash control', async () => {
  await checkPackageCopy(root);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-copy-'));
  try {
    await cp(root, dir, { recursive: true });
    const file = path.join(dir, 'skills/dezfil/SKILL.md');
    await writeFile(file, `${await readFile(file, 'utf8')}\nSeed — fails.\n`);
    await expect(checkPackageCopy(dir)).rejects.toThrow(/em dash/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
