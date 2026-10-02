import { vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildMcpFetchHandler } from './handler';
import { declaredToolArguments } from '../../../scripts/revision-fixtures.mjs';
import type { EditBasis } from '@/lib/edit-basis';

/** Opt-in fixture call. Ordinary client.callTool, including malformed and
 * missing argument probes, stays completely untouched. */
export function callFixtureTool(client: Client, tool: { name: string; inputSchema: unknown }, args: Record<string, unknown>, basis: EditBasis) {
  return client.callTool({ name: tool.name, arguments: declaredToolArguments(tool, args, basis) });
}

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
