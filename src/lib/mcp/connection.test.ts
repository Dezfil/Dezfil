import { afterEach, expect, it, vi } from 'vitest';
import { buildMcpFetchHandler } from './handler';
import { buildOpenApiDocument } from '@/lib/api/openapi';
import { documentedTools } from './contract-oracle';
import { checkMcpConnection, MCP_CHECK_FAILED, MCP_CHECK_TIMEOUT } from './connection';
import { clientGuide } from './client-guide';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture() {
  const handler = buildMcpFetchHandler();
  const methods: string[] = []; let productCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname !== '/api/mcp') { productCalls++; throw new Error('A connection check dispatched a product call'); }
    if (request.method === 'POST') methods.push((await request.clone().json()).method);
    return handler.fetch(request);
  };
  return { fetcher, methods, productCalls: () => productCalls };
}
it('initializes the real handler and counts the received tools with zero product/provider calls', async () => {
  const server = fixture();
  const count = await checkMcpConnection('http://localhost:3307/api/mcp', server.fetcher);
  expect(count).toBe(documentedTools(buildOpenApiDocument()).length);
  expect(server.methods).toContain('initialize'); expect(server.methods).toContain('tools/list');
  expect(server.methods).not.toContain('tools/call'); expect(server.productCalls()).toBe(0);
});
it('a held initialization remains pending until 10 seconds, settles by its bound and permits a real retry', async () => {
  vi.useFakeTimers(); const server = fixture(); let hold = true, aborted = 0, settled = false;
  const fetcher: typeof fetch = (input, init) => hold ? new Promise((_, reject) => {
    const request = new Request(input, init);
    request.signal.addEventListener('abort', () => { aborted++; reject(new DOMException('fixture', 'AbortError')); }, { once: true });
  }) : server.fetcher(input, init);
  const pending = checkMcpConnection('http://localhost:3307/api/mcp', fetcher).then(() => 'unexpected success', error => error.message).finally(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(9999); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(await pending).toBe(MCP_CHECK_TIMEOUT); expect(aborted).toBe(1);
  hold = false; vi.useRealTimers();
  expect(await checkMcpConnection('http://localhost:3307/api/mcp', fetcher)).toBe(documentedTools(buildOpenApiDocument()).length);
  expect(server.productCalls()).toBe(0); expect(server.methods).not.toContain('tools/call');
});
it('a transport exception is replaced with the guide failure copy', async () => {
  await expect(checkMcpConnection('http://localhost:3307/api/mcp', async () => { throw new Error('/private/fixture-stack'); })).rejects.toThrow(MCP_CHECK_FAILED);
});
it('configurations retain the displayed origin and port, including IPv6', () => {
  for (const endpoint of ['http://localhost:3377/api/mcp', 'https://maps.example.test:8443/api/mcp', 'http://[::1]:3388/api/mcp']) {
    expect(clientGuide('Claude Code', endpoint).code).toBe(`claude mcp add --transport http dezfil '${endpoint}'`);
    expect(clientGuide('Codex', endpoint).code).toBe(`codex mcp add dezfil --url '${endpoint}'`);
    const codex = clientGuide('Codex', endpoint).alternate!;
    expect(codex.split('\n')[0]).toBe('[mcp_servers.dezfil]');
    expect(JSON.parse(codex.split('url = ')[1])).toBe(endpoint);
    expect(JSON.parse(clientGuide('Cursor', endpoint).code)).toEqual({ mcpServers: { dezfil: { url: endpoint } } });
    expect(clientGuide('Claude Desktop', endpoint).code).toBe(endpoint);
  }
});
