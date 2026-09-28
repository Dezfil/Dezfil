import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { clientGuide } from '@/lib/mcp/client-guide';
import { preparePackage, resolvePackage } from '../../../scripts/dezfil-package.mjs';

const dirs: string[] = [];
async function scratch() { const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-package-')); dirs.push(dir); return dir; }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

// Independent literal expectations, deliberately not derived from the generator.
const fixtures = [
  { input: undefined, endpoint: 'http://localhost:3000/api/mcp', claude: "claude mcp add --transport http dezfil 'http://localhost:3000/api/mcp'", codex: "codex mcp add dezfil --url 'http://localhost:3000/api/mcp'", toml: '[mcp_servers.dezfil]\nurl = "http://localhost:3000/api/mcp"' },
  { input: 'https://maps.example:8443', endpoint: 'https://maps.example:8443/api/mcp', claude: "claude mcp add --transport http dezfil 'https://maps.example:8443/api/mcp'", codex: "codex mcp add dezfil --url 'https://maps.example:8443/api/mcp'", toml: '[mcp_servers.dezfil]\nurl = "https://maps.example:8443/api/mcp"' },
  { input: 'http://[::1]:3389/', endpoint: 'http://[::1]:3389/api/mcp', claude: "claude mcp add --transport http dezfil 'http://[::1]:3389/api/mcp'", codex: "codex mcp add dezfil --url 'http://[::1]:3389/api/mcp'", toml: '[mcp_servers.dezfil]\nurl = "http://[::1]:3389/api/mcp"' },
  { input: 'http://localhost:3391/api/mcp', endpoint: 'http://localhost:3391/api/mcp', claude: "claude mcp add --transport http dezfil 'http://localhost:3391/api/mcp'", codex: "codex mcp add dezfil --url 'http://localhost:3391/api/mcp'", toml: '[mcp_servers.dezfil]\nurl = "http://localhost:3391/api/mcp"' },
].map(fixture => ({ ...fixture,
  claude: fixture.claude + " --header 'Authorization: Bearer ${DEZFIL_API_TOKEN}'",
  codex: fixture.codex + ' --bearer-token-env-var DEZFIL_API_TOKEN',
  toml: fixture.toml + '\nbearer_token_env_var = "DEZFIL_API_TOKEN"',
}));

function assertConnection(connection: Awaited<ReturnType<typeof resolvePackage>>, fixture: typeof fixtures[number]) {
  expect(connection.name).toBe('dezfil');
  expect(connection.type).toBe('http');
  expect(connection.url, 'installed endpoint').toBe(fixture.endpoint);
  // Projections are test-only; no duplicated connection guide ships.
  const claude = `claude mcp add --transport ${connection.type} ${connection.name} '${connection.url}'` + " --header 'Authorization: Bearer ${DEZFIL_API_TOKEN}'";
  const codex = `codex mcp add ${connection.name} --url '${connection.url}' --bearer-token-env-var DEZFIL_API_TOKEN`;
  const toml = `[mcp_servers.${connection.name}]\nurl = ${JSON.stringify(connection.url)}\nbearer_token_env_var = "DEZFIL_API_TOKEN"`;
  expect(claude).toBe(fixture.claude); expect(codex).toBe(fixture.codex); expect(toml).toBe(fixture.toml);
  expect(claude).toBe(clientGuide('Claude Code', fixture.endpoint).code);
  expect(codex).toBe(clientGuide('Codex', fixture.endpoint).code);
  expect(toml).toBe(clientGuide('Codex', fixture.endpoint).alternate);
}

for (const fixture of fixtures) it(`1b/1c: both native chains and guide projections for ${fixture.input ?? 'default'}`, async () => {
  const root = path.join(await scratch(), 'catalog');
  await preparePackage({ destination: root, baseUrl: fixture.input });
  for (const client of ['claude', 'codex'] as const) assertConnection(await resolvePackage(root, client), fixture);
});

it('prepared Claude catalog describes its local package', async () => {
  const root = path.join(await scratch(), 'catalog'); await preparePackage({ destination: root });
  const catalog = JSON.parse(await readFile(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  expect(catalog.description).toBe('Dezfil spatial SQL, map styling and publishing for a selected instance.');
});

it('the endpoint oracle rejects a wrong installed package URL', async () => {
  const root = path.join(await scratch(), 'catalog'); await preparePackage({ destination: root });
  for (const client of ['claude', 'codex'] as const) {
    const file = (await resolvePackage(root, client)).mcpFile;
    const config = JSON.parse(await readFile(file, 'utf8'));
    config.mcpServers.dezfil.url = 'http://127.0.0.1:1/api/mcp';
    await writeFile(file, JSON.stringify(config));
    const connection = await resolvePackage(root, client);
    expect(() => assertConnection(connection, fixtures[0])).toThrow(/installed endpoint/);
  }
});

for (const input of ['', 'not a URL', 'ftp://localhost', 'http://user:pass@localhost', 'http://@localhost', 'http://:@localhost', 'http://localhost/a', 'http://localhost/API/MCP', 'http://localhost/api/MCP', 'http://localhost/api/mcp/', 'http://localhost/?x=1', 'http://localhost/#x', 'http://localhost?', 'http://localhost#', 'http://localhost/a/../', ' http://localhost', 'http://localhost\\evil']) {
  it(`invalid origin ${JSON.stringify(input)} leaves configuration unchanged`, async () => {
    const dir = await scratch(); const destination = path.join(dir, 'new');
    const existing = path.join(dir, 'existing'); await preparePackage({ destination: existing });
    const config = path.join(existing, 'plugins/dezfil/.mcp.json'); const before = await readFile(config, 'utf8');
    await expect(preparePackage({ destination, baseUrl: input })).rejects.toThrow(/URL/);
    await expect(preparePackage({ destination: existing, baseUrl: input })).rejects.toThrow(/URL/);
    expect(await readdir(dir)).toEqual(['existing']); expect(await readFile(config, 'utf8')).toBe(before);
  });
}

it('occupied output is refused before any change, including unrelated sentinels', async () => {
  const dir = await scratch(); const destination = path.join(dir, 'occupied'); await mkdir(destination);
  await writeFile(path.join(destination, 'settings.json'), '{"unrelated":true}\n');
  await expect(preparePackage({ destination })).rejects.toThrow(/occupied/);
  expect(await readdir(destination)).toEqual(['settings.json']);
  expect(await readFile(path.join(destination, 'settings.json'), 'utf8')).toBe('{"unrelated":true}\n');
});
