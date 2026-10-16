import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
export const MCP_CHECK_DEADLINE_MS = 10_000;
export const MCP_CHECK_TIMEOUT = 'The connection check did not finish within 10 seconds.';
export const MCP_CHECK_FAILED = 'This browser could not connect to the MCP endpoint. You can try again.';
/** Read-only protocol operation usable independently of the MCP card in Settings.
 * A whole-check deadline owns initialization, pagination and held responses.
 */
export async function checkMcpConnection(endpoint: string, fetcher: typeof fetch = fetch): Promise<number> {
  const controller = new AbortController();
  const client = new Client({ name: 'dezfil-connection-check', version: '1' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(MCP_CHECK_TIMEOUT)); controller.abort(); }, MCP_CHECK_DEADLINE_MS);
  });
  const connectAndCount = async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        return fetcher(new Request(request, { signal: AbortSignal.any([controller.signal, request.signal]) }));
      },
    }));
    const names = new Set<string>();
    let cursor: string | undefined;
    do {
      const listed = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of listed.tools) names.add(tool.name);
      cursor = listed.nextCursor;
    } while (cursor);
    return names.size;
  };
  try { return await Promise.race([connectAndCount(), deadline]); }
  catch (error) { throw new Error(error instanceof Error && error.message === MCP_CHECK_TIMEOUT ? MCP_CHECK_TIMEOUT : MCP_CHECK_FAILED); }
  finally { clearTimeout(timer); controller.abort(); void client.close().catch(() => {}); }
}
