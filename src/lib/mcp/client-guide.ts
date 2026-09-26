/** Dated source forms are verification. Endpoint is supplied
 * by the visible instance, never a hard-coded host or configured model. */
export const MCP_CLIENTS = ['Claude Code', 'Codex', 'Cursor', 'Claude Desktop'] as const;
export type McpClientName = typeof MCP_CLIENTS[number];
export function clientGuide(client: McpClientName, endpoint: string) {
  const quoted = "'" + endpoint.replaceAll("'", "'\\''") + "'";
  if (client === 'Claude Code') return {
    code: `claude mcp add --transport http dezfil ${quoted}`,
    setup: 'Run this command in your terminal. In Claude Code, open /mcp to see the connection status.',
    source: 'https://code.claude.com/docs/en/mcp',
  };
  if (client === 'Codex') return {
    code: `codex mcp add dezfil --url ${quoted}`,
    alternate: `[mcp_servers.dezfil]\nurl = ${JSON.stringify(endpoint)}`,
    setup: 'Run this command in your terminal, or add the configuration below to ~/.codex/config.toml. In Codex, open /mcp to see active servers.',
    source: 'https://developers.openai.com/codex/mcp',
  };
  if (client === 'Cursor') return {
    code: JSON.stringify({ mcpServers: { dezfil: { url: endpoint } } }, null, 2),
    setup: 'Add this entry to .cursor/mcp.json in your project, or ~/.cursor/mcp.json for all projects. Open Customize, then MCP, to see the server and its tools.',
    source: 'https://cursor.com/docs/mcp',
  };
  return {
    code: endpoint,
    setup: 'Custom connectors take a remote MCP URL in Customize > Connectors > Add custom connector. Organization owners manage these in Organization settings > Connectors.',
    limitation: 'Claude Desktop’s remote connectors connect from Anthropic’s cloud. They cannot reach this private instance over plain HTTP.',
    source: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
  };
}
