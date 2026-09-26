# The MCP server

Dezfil serves its own API to AI agents over the Model Context Protocol. The
agent brings its own model; the instance supplies the tools, their schemas,
and the work.

## How it is started

It is not started. There is no separate process, no extra port, and nothing
to install on the server: the MCP server is one route in the application.

- **Endpoint:** `POST /api/mcp`
- **Transport:** Streamable HTTP
- **State:** none. Every request builds a fresh server instance, so there
  are no sessions to open, resume, or tear down, and no `GET` or `DELETE`
  on the endpoint (`src/app/api/mcp/route.ts`,
  `src/lib/mcp/handler.ts`).

The server identifies itself as `dezfil`.

## Environment

None of its own. The endpoint needs no key and no token, because the client
brings the model. The settings that matter to a tool call are the ordinary
instance settings: the query timeout and memory budget, the upload and
import caps, and `DEZFIL_TOOL_ATTACHMENT_MAX_MB`, which bounds a download
answered into a tool result. See [configuration.md](configuration.md).

One platform variable matters indirectly. A tool call reaches the API over
loopback, and the address is built from `PORT` when it is set, otherwise
from the incoming request's port (`src/lib/self-url.ts`). The container
image sets `PORT`.

## Where the tools come from

Tools are derived from the OpenAPI document, not written by hand
(`src/lib/tools/tools.ts`). For each documented operation:

- the tool's name is the operation's `x-tool` extension, so names are
  chosen in the API description and cannot drift;
- the input schema is the operation's path parameters, query parameters and
  request body, reference-resolved and flattened into one object, which is
  friendlier for a model than a nested envelope;
- the output schema comes from the operation's success response;
- confirmation policy, effects and consequence facts come from the
  operation's own extensions and are published as tool metadata.

An operation that declares `x-tool: false` is deliberately excluded, and the
exclusion is visible in the document rather than hidden in the derivation.
The excluded ones are the assistant's own endpoints, the MCP endpoint
itself, raw tile and thumbnail reads, and a handful of calls that only make
sense to a browser.

Derivation is pure over a static document, so the tool set is built once per
process and reused.

## Counts, measured from the code

| | |
|---|---|
| Documented operations | 138 |
| Operations that become tools | 116 |
| Deliberately excluded | 22 |

Measured by building the OpenAPI document and the tool set from
`src/lib/api/openapi.ts` and `src/lib/tools/tools.ts` and counting the
HTTP methods across `paths`, the operations whose `x-tool` is not `false`,
and the entries `buildTools()` returns.

## The parity check

The counts agree because a test makes them agree. `src/lib/tools/tools.test.ts`
compares the derived tool set against the documented operations and fails on
any difference in either direction. It extends the chain that
`src/lib/api/parity.test.ts` already enforces: route files match the OpenAPI
document, the OpenAPI document matches the interface's own calls, and the
tool set matches the OpenAPI document. Adding a route without documenting it,
or documenting an operation without giving it a tool or an explicit
exclusion, turns the suite red.

## What a tool call does

A call is validated against the tool's input schema, then executed as an
ordinary HTTP request to the instance's own API over loopback
(`src/lib/mcp/execute.ts`). Nothing bypasses the API, so an agent is held to
exactly the same parity, read-only SQL policy, limits and error shapes as
any other client.

The result carries both representations: a text content block with the
response body, and structured content of the shape
`{ "result": ..., "history": ... }`. A coded failure sets `isError` and puts
the error code in the body. Binary answers, an exported image for example,
travel as a native image content block or as an attachment, and the
structured result points at where the bytes are rather than repeating them
(`src/lib/mcp/result.ts`).

Tool metadata is advisory and the client owns the decision: each tool
publishes a read-only hint, a destructive hint, an open-world hint, an
idempotency hint where it applies, and Dezfil's own confirmation policy,
target and consequence facts.

Edits that belong together take a `change_group` argument, which becomes the
`X-Change-Group` header, so a multi-call edit folds into one entry in the
map's undo timeline.

Failures keep the API's own error codes and messages, filtered so that only
documented fields travel (`src/lib/mcp/errors.ts`). Transport and protocol
problems get their own codes rather than a generic error:
`mcp_read_failed`, `mcp_transport_failed`, `mcp_response_invalid`, plus
`invalid_request` for an argument that does not match the schema
(`src/lib/mcp/call.ts`).

## Connecting a client

The `/developer` page on a running instance generates the configuration for
the instance you are looking at. The same text is produced by
`src/lib/mcp/client-guide.ts`, which covers four clients:

**Claude Code**

```sh
claude mcp add --transport http dezfil http://localhost:3000/api/mcp
```

**Codex CLI**

```sh
codex mcp add dezfil --url http://localhost:3000/api/mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.dezfil]
url = "http://localhost:3000/api/mcp"
```

**Cursor**, in `.cursor/mcp.json` for one project or `~/.cursor/mcp.json`
for all of them:

```json
{ "mcpServers": { "dezfil": { "url": "http://localhost:3000/api/mcp" } } }
```

**Claude Desktop** takes a remote MCP URL as a custom connector. Its
connectors connect from a cloud, so they cannot reach a private instance
over plain HTTP.

Substitute your own instance address in each case.

## The plugin package

`plugins/dezfil/` is a self-contained package that bundles the connection
with instructions, so an agent knows how to use the tools rather than only
that they exist. It carries:

- `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, one manifest
  per client, sharing one `.mcp.json` that names the endpoint;
- `skills/dezfil/SKILL.md`, a skill that routes a task to the right
  operations and explains how to read a result;
- `skills/dezfil/analysis.md`, shared analytical guidance;
- `skills/dezfil/references/cartography.md` and
  `references/duckdb-spatial.md`, two compact references with runnable
  examples;
- `NOTICE`, `sources.json`, `LICENSE` and `LICENSE-GeoSQL`, the source and
  license inventory for the bundled material.

`analysis.md` is generated from the application's own guidance module rather
than maintained by hand. `npm run lint:plugin` regenerates it in check mode
and fails if the package has drifted from the source
(`scripts/generate-dezfil-guidance.mjs`).

## Preparing a local copy

A package has to name one instance, so you prepare a copy with the address
baked in:

```sh
node scripts/prepare-dezfil-plugin.mjs \
  --output "$HOME/dezfil-local" \
  --base-url http://localhost:3000
```

The address is validated before anything is written: HTTP and HTTPS origins,
non-default ports, IPv6 hosts, a trailing slash and a full `/api/mcp`
endpoint are accepted; credentials, queries, fragments and other paths are
refused. An occupied destination is refused. The prepared directory is a
complete copy plus the local catalog entries both clients need, and it can
live anywhere. Install and removal commands for each client are in
[the package's own README](../plugins/dezfil/README.md).

## Exercising it

`node scripts/mcp-journey.mjs <base-url>` drives a full journey through the
MCP endpoint by hand; `--render` selects the arm that renders for real. The
same journey runs inside the unit suite against an in-process client, so the
path from a stock MCP client through the endpoint to a real route is covered
without a browser. Point the script at an instance on its own data
directory, so its writes stay out of working data.
