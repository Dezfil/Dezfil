import { vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildMcpFetchHandler } from './handler';

export async function testClient(api: (request: Request) => Response | Promise<Response>) {
  const handler = buildMcpFetchHandler();
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return new URL(request.url).pathname === '/api/mcp' ? handler.fetch(request) : api(request);
  }) as typeof fetch);
  const client = new Client({ name: 'dezfil-contract-client', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3307/api/mcp')));
  return client;
}
