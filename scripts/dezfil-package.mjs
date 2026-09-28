// Consumer-local staging only. Native registration is performed by the client.
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../plugins/dezfil/', import.meta.url));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');

export function endpointFor(baseUrl = 'http://localhost:3000') {
  if (typeof baseUrl !== 'string' || /[\s\\?#@]/.test(baseUrl)) throw new Error('Invalid base URL');
  // Check the supplied path before WHATWG URL normalization removes dot segments.
  if (!/^https?:\/\/[^/]+(?:\/|\/api\/mcp)?$/i.test(baseUrl)) throw new Error('Invalid base URL');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('Invalid base URL'); }
  if (url.username || url.password || !url.hostname || !['/', '/api/mcp'].includes(url.pathname)) throw new Error('Invalid base URL');
  return `${url.origin}/api/mcp`;
}

/** @param {{destination: string, baseUrl?: string}} options */
export async function preparePackage({ destination, baseUrl }) {
  const endpoint = endpointFor(baseUrl); // Validation precedes every filesystem change.
  const output = path.resolve(destination);
  try { await lstat(output); throw new Error('Package destination is occupied'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = path.dirname(output);
  await mkdir(parent, { recursive: true });
  // Reserve the destination atomically; no overwrite of a competing preparer.
  await mkdir(output);
  const temp = path.join(parent, `.dezfil-stage-${randomUUID()}`);
  try {
    const plugin = path.join(temp, 'plugins/dezfil');
    await mkdir(plugin, { recursive: true });
    await cp(source, plugin, { recursive: true, dereference: true });
    await save(path.join(plugin, '.mcp.json'), { mcpServers: { dezfil: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer ${DEZFIL_API_TOKEN}' } } } });
    await save(path.join(plugin, '.codex-mcp.json'), { mcpServers: { dezfil: { type: 'http', url: endpoint, bearer_token_env_var: 'DEZFIL_API_TOKEN' } } });
    await mkdir(path.join(temp, '.claude-plugin'));
    await save(path.join(temp, '.claude-plugin/marketplace.json'), {
      name: 'dezfil-local', owner: { name: 'Dezfil contributors' },
      description: 'Dezfil spatial SQL, map styling and publishing for a selected instance.',
      plugins: [{ name: 'dezfil', source: './plugins/dezfil' }],
    });
    await mkdir(path.join(temp, '.agents/plugins'), { recursive: true });
    await save(path.join(temp, '.agents/plugins/marketplace.json'), {
      name: 'dezfil-local', interface: { displayName: 'Dezfil local' },
      plugins: [{ name: 'dezfil', source: { source: 'local', path: './plugins/dezfil' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
    });
    await rename(temp, output);
    return output;
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    // Only remove the empty directory reserved by this invocation.
    const { rmdir } = await import('node:fs/promises');
    await rmdir(output).catch(() => {});
    throw error;
  }
}

async function contained(root, relative) {
  if (typeof relative !== 'string' || !relative.startsWith('./')) throw new Error('Package path must be relative');
  const full = await realpath(path.resolve(root, relative));
  const base = await realpath(root);
  if (!full.startsWith(base + path.sep)) throw new Error('Package path escapes its root');
  return full;
}

/** Resolve each client's real catalog and manifest, not a harness endpoint.
 * @param {string} root @param {'claude'|'codex'} client */
export async function resolvePackage(root, client) {
  if (!['claude', 'codex'].includes(client)) throw new Error('Unknown native format');
  const catalogFile = path.join(root, client === 'claude' ? '.claude-plugin/marketplace.json' : '.agents/plugins/marketplace.json');
  const catalog = await json(catalogFile);
  if (catalog.name !== 'dezfil-local') throw new Error('Unexpected catalog identity');
  const entry = catalog.plugins.find(p => p.name === 'dezfil');
  if (!entry) throw new Error('Missing Dezfil catalog entry');
  if (client === 'codex' && (entry.source.source !== 'local' || entry.policy.installation !== 'AVAILABLE' || entry.policy.authentication !== 'ON_INSTALL' || entry.category !== 'Productivity')) throw new Error('Invalid Codex local catalog');
  const plugin = await contained(root, client === 'claude' ? entry.source : entry.source.path);
  const manifestFile = path.join(plugin, client === 'claude' ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json');
  const manifest = await json(manifestFile);
  if (manifest.name !== 'dezfil' || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !manifest.description || !manifest.author?.name) throw new Error('Invalid native manifest');
  // Claude discovers .mcp.json and skills/ by default; Codex declares both.
  const mcpFile = await contained(plugin, client === 'claude' ? './.mcp.json' : manifest.mcpServers);
  const skills = await contained(plugin, client === 'claude' ? './skills' : manifest.skills);
  const config = await json(mcpFile);
  if (Object.keys(config.mcpServers).join() !== 'dezfil') throw new Error('Unexpected connection identity');
  const connection = config.mcpServers.dezfil;
  if (connection.type !== 'http' || endpointFor(connection.url) !== connection.url) throw new Error('Invalid HTTP connection');
  if (client === 'claude' ? connection.headers?.Authorization !== 'Bearer ${DEZFIL_API_TOKEN}' : connection.bearer_token_env_var !== 'DEZFIL_API_TOKEN') throw new Error('Invalid token environment reference');
  return { tokenEnv: 'DEZFIL_API_TOKEN', name: 'dezfil', type: connection.type, url: connection.url, version: manifest.version, plugin, skills, mcpFile, manifestFile, catalogFile };
}
