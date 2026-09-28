import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { clientGuide } from '@/lib/mcp/client-guide';
import { preparePackage, resolvePackage } from '../../../scripts/dezfil-package.mjs';
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
it.each(['Claude Code', 'Codex', 'Cursor'] as const)('%s configuration keeps a client-native token reference', client => {
  const guide = clientGuide(client, 'http://127.0.0.1:3398/api/mcp');
  expect(guide.code).toContain('DEZFIL_API_TOKEN');
  if (client === 'Claude Code') expect(guide.code).toContain('Bearer ${DEZFIL_API_TOKEN}');
  if (client === 'Codex') { expect(guide.code).toContain('--bearer-token-env-var DEZFIL_API_TOKEN'); expect(guide.alternate).toContain('bearer_token_env_var = "DEZFIL_API_TOKEN"'); }
  if (client === 'Cursor') expect(JSON.parse(guide.code).mcpServers.dezfil.headers.Authorization).toBe('Bearer ${env:DEZFIL_API_TOKEN}');
});
it('identifies the remote desktop connector as unsupported for account tokens', () => {
  expect(clientGuide('Claude Desktop', 'https://maps.example/api/mcp').limitation).toMatch(/unsupported.*token/i);
});
it.each(['claude', 'codex'] as const)('%s package resolves a token reference without embedding the environment secret', async client => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-token-')); directories.push(dir);
  const root = path.join(dir, 'catalog'); await preparePackage({ destination: root, baseUrl: 'http://127.0.0.1:3398' });
  const connection = await resolvePackage(root, client);
  const config = JSON.parse(await readFile(connection.mcpFile, 'utf8')).mcpServers.dezfil;
  if (client === 'claude') expect(config.headers).toEqual({ Authorization: 'Bearer ${DEZFIL_API_TOKEN}' });
  else expect(config.bearer_token_env_var).toBe('DEZFIL_API_TOKEN');
  expect(JSON.stringify(config)).not.toContain('dz_token_');
});

it('staging rejects literal credentials and missing token references', async () => {
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-token-refusal-')); directories.push(dir);
  const root = path.join(dir, 'catalog'); await preparePackage({ destination: root });
  for (const client of ['claude', 'codex'] as const) {
    const connection = await resolvePackage(root, client), text = await readFile(connection.mcpFile, 'utf8');
    const config = JSON.parse(text);
    if (client === 'claude') config.mcpServers.dezfil.headers.Authorization = 'Bearer dz_token_literal';
    else delete config.mcpServers.dezfil.bearer_token_env_var;
    await writeFile(connection.mcpFile, JSON.stringify(config));
    await expect(resolvePackage(root, client)).rejects.toThrow('token environment reference');
    await writeFile(connection.mcpFile, text);
  }
});
