/** Client-native token references. The visible instance supplies the endpoint. */
export const MCP_CLIENTS = ['Claude Code', 'Codex', 'Cursor', 'Claude Desktop'] as const;
export type McpClientName = typeof MCP_CLIENTS[number];
export function clientGuide(client: McpClientName, endpoint: string) {
  const quoted = "'" + endpoint.replaceAll("'", "'\\''") + "'";
  if (client === 'Claude Code') return {
    code: `claude mcp add --transport http dezfil ${quoted}` + " --header 'Authorization: Bearer ${DEZFIL_API_TOKEN}'",
    supported: true,
    setup: 'Run this command in your terminal. In Claude Code, open /mcp to see the connection status.',
    source: 'https://code.claude.com/docs/en/mcp',
  };
  if (client === 'Codex') return {
    code: `codex mcp add dezfil --url ${quoted} --bearer-token-env-var DEZFIL_API_TOKEN`,
    supported: true,
    alternate: `[mcp_servers.dezfil]\nurl = ${JSON.stringify(endpoint)}\nbearer_token_env_var = "DEZFIL_API_TOKEN"`,
    setup: 'Run this command in your terminal, or add the configuration below to ~/.codex/config.toml. In Codex, open /mcp to see active servers.',
    source: 'https://developers.openai.com/codex/mcp',
  };
  if (client === 'Cursor') return {
    code: JSON.stringify({ mcpServers: { dezfil: { url: endpoint, headers: { Authorization: "Bearer ${env:DEZFIL_API_TOKEN}" } } } }, null, 2),
    supported: true,
    setup: 'Add this entry to .cursor/mcp.json in your project, or ~/.cursor/mcp.json for all projects. Open Customize, then MCP, to see the server and its tools.',
    source: 'https://cursor.com/docs/mcp',
  };
  return {
    code: "",
    supported: false,
    setup: 'Use a client that can send an account API token in the Authorization header.',
    limitation: 'Unsupported: remote custom connectors do not provide this account-token configuration. They also connect from the cloud and cannot reach a private local instance.',
    source: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
  };
}
