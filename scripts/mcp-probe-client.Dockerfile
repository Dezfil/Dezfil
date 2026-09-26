# Test client only. The shipped Dezfil image keeps its runtime inventory.
FROM node:24-bookworm-slim
WORKDIR /probe
ARG MCP_CLIENT_VERSION
RUN test -n "$MCP_CLIENT_VERSION" && npm install --omit=dev --ignore-scripts --no-audit --no-fund "@modelcontextprotocol/client@$MCP_CLIENT_VERSION"
CMD ["node", "/probe/scripts/mcp-process-probe.mjs"]
