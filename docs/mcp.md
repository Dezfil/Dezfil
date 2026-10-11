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

The client brings the model, so the endpoint needs no model API key of its
own. It does require an account API token in `Authorization: Bearer` on every
request, including initialization and tool listing. Create one in Settings
under API / MCP tokens. Calls have that account's current privileges; admin
operations remain admin-only. Missing, invalid and revoked credentials fail
before work. Responses are private and are not cached.

Internal reads and executions retain the same identity. Browser callers use
a short-lived delegation tied to their session, without creating a durable
API token. Revoking the parent or deactivating the account stops downstream
access. Internal credentials are confined to the instance origin and API
redirects are refused.

The settings that matter to a tool call are the ordinary
instance settings: the query timeout and memory budget, the upload and
import caps, and `DEZFIL_TOOL_ATTACHMENT_MAX_MB`, which bounds a download
answered into a tool result. See [configuration.md](configuration.md).

One platform variable matters indirectly. A tool call reaches the API over
loopback, and the address is built from `PORT` when it is set, otherwise
from the incoming request's port (`src/lib/self-url.ts`). The container
image sets `PORT`.

## SQL result refusals

The four bounded REST readers are `run_sql`, `inspect_table`,
`preview_table_geometry` and `preview_postgis_relation`. Each complete REST
answer has a fixed 33,554,432-byte (32 MiB) ceiling and each non-geometry cell
a 2,097,152-byte (2 MiB) ceiling, after conversions and excerpts. Equality is
admitted. Native geometry provenance exempts only the cell ceiling; coordinate
text/JSON remains non-geometry. See [the API guide](api.md).

HTTP 422 `query_result_too_large` is relayed with `isError: true`, the same
code and sentence in text and `structuredContent.result`, and no partial rows:

> The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.

MCP's text and structured copies do not consume the REST allowance again; a
fitting result can have a duplicated MCP representation above 32 MiB. The
embedded assistant receives the same error outcome. Attachment ceilings and
all assistant context, grounding and recovery limits stay unchanged. File
exports and the other readers keep their existing limits.

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
sense to a browser. Automatic HEAD and OPTIONS are also excluded: they describe
HTTP transport behavior and create no extra tools.

The settings read and update are generated as `get_settings` and
`update_settings`. They address the authenticated account's display name
and view preferences, the source list's grouping and the look among them.
The look's input is closed: an unknown pick or a value outside a pick's
choices is refused before any call. Updating the
instance name requires current admin authority; a forbidden or invalid field
refuses the entire patch.

`get_instance_settings` reads the admin-only instance configuration through
`GET /api/instance/settings`. It is a local, read-only operation that asks
for no confirmation, so the SQL and workflow assistants' read-only policies
admit it; they admit no operation that asks first. Its
input is closed and takes no arguments; unknown arguments are refused before
HTTP dispatch. The result contains every instance and platform definition,
effective and stored values, source, lock and invalid-override state, derived
admission capacities, the fixed image maximum, version and process start time,
`services`: each service cache's size, answer count and budget, and the
Overture release list this process keeps, and `parts`: each part of the server
as System's Status shows it, read without starting the engine, launching a
browser or running a program. Credentials are presence or
key-location states; addresses contain only scheme and host (the satellite
tile template also says when it carries a user name or password, never what),
or set-and-unreadable state, and a stored address never comes back as stored. The same current-admin checks and
private, no-store responses apply to direct API calls and tool calls.

`update_instance_settings` calls `PATCH /api/instance/settings` with the closed
editable-key input, sixty-nine keys: the fourteen Limits numbers, the services'
eight numbers (the address finder's and travel time's gap, answer time limit and
freshness, OpenStreetMap's time budget and freshness), the four service
addresses (`geocoderUrl`, `isochroneUrl`, `overpassUrl`, `s3Endpoint`), the
satellite imagery's tile address and credit (`satelliteUrl`,
`satelliteAttribution`), the five basemap switches (which built-in styles are
offered, and `basemaps.singleMapStyles`), the template catalogue's switch and
address (`templates.catalogue`, `templatesCatalogueUrl`), the four General values, the eighteen instance defaults and the twelve sign-in and
publishing settings (session and link lifetimes, the two failed sign-in counts,
the shortest password, who may create tokens and their expiry, who may publish,
embedding and its listed sites, who may add database connections and who may
import from links), each with its kind, bounds or choices, so a value outside
them is refused before any call. The listed sites go in as a list of origins.
An address goes in whole, as text, and is refused when the egress policy would
refuse it now, its key named with the policy's sentence; the satellite tile
address is also refused when it carries a user name or password, the refusal
saying a browser cannot load tiles from such an address and the key belongs in
the path or the query. The result, the
assistant's confirmation, its events and its record give it as scheme and host
alone, while the call itself carries the address as given.
A per-address count below the per-account one, or embedding limited to listed
sites with none listed, refuses the whole call. Values are validated together and null clears
a stored value; the result is the configuration read, including timeout
relationship warnings. A lock refuses the whole body with `setting_locked`,
before other validation refusals. All calls recheck current admin authority. The embedded
assistant parks the update for confirmation on pages admitting writes, and
refuses it under SQL and workflow policies. MCP advertises this policy and
the local settings-write consequences; it adds no approval gate. An active
admin's bearer token calls directly, without a new token scope. Unknown tool
arguments are refused before HTTP dispatch. Successes and errors never disclose
credentials or address paths, queries or user information.

`test_service` calls `POST /api/instance/services/{service}/test` and
`clear_service_caches` calls `DELETE /api/instance/caches`, both admin-only and
rechecked on every call. A Test sends one fixed request to the service at its
address in effect (the satellite imagery: one fixed low-zoom tile at its tile
template; the template catalogue: its index) and answers passed with the time
taken (Overture: how many releases and the newest; the template catalogue: how
many templates it lists) or failed with one reason from a closed list, never a
body, an address or a key; it is read-only but reaches outside this server, so
MCP marks it open-world. While an admin has turned the template catalogue off,
its Test is refused with `templates_catalogue_off` and sends nothing. Clear removes the cached answers of one service or all
three and nothing else. The embedded assistant asks before calling either; the
SQL and workflow assistants are never offered them.

`test_part` calls `POST /api/instance/parts/{part}/test` and `read_storage`
calls `GET /api/instance/storage`, both admin-only and rechecked on every
call. A part's Test runs one small fixed check on the data folder, the query
engine, the tile builder, the image renderer or the metadata database as
configured now, and answers passed with the time taken or failed with one
reason (`not_found`, `busy`, `timed_out`, `failed`), never a path, a program's
output or an error's words; the engine's installs nothing, and the renderer's
answers busy rather than wait for an image slot. The storage read gives each
kind of file in the data folder its bytes and count, the total and the free
space, never a name or a path (templates among the kinds: the downloaded
ones and the copies of an installed template's data, a file with two names
counted once), at least what it counted for a kind its
10-second walk did not finish; a cache's Clear ends a walk already under way,
and a read just after it joins a fresh one, its 10 seconds still counted from
its own asking.
Both are local and read-only and keep nothing,
so MCP marks them local reads, not open-world; they ask for confirmation, so the
embedded assistant asks before calling either and the SQL and workflow
assistants are never offered them.

`list_templates` calls `GET /api/templates`, `get_template` calls
`GET /api/templates/{id}` and `refresh_templates` calls
`POST /api/templates/refresh`, for every signed-in account. The list and the
read answer from what this server holds (the shipped templates, the downloaded
ones and the catalogue list it last read, with the catalogue's state; the list
also says how many versions are downloaded and the bytes they take) and send
nothing, so MCP marks them local reads. The refresh reads the template
catalogue's index and pictures through the egress check at most once in ten
minutes, answering the kept list inside that window; it is read-only but
reaches outside this server, so MCP marks it open-world, and the SQL and
workflow assistants are offered the list and the read but never the refresh.
While an admin has turned the catalogue off the refresh is refused with
`templates_catalogue_off`. A template card's picture is not a tool.
`fetch_template` calls `POST /api/templates/{id}/fetch`: it downloads the
version named, else the one the card takes now, checks it whole and installs
it, answering at once and sending nothing when that version is installed
already. It writes this server's templates and reaches outside it, so MCP
marks it open-world, not idempotent; it asks for confirmation, its words
naming the version and its size, and the embedded assistant completes a call
naming no version with the version its words name before it waits for the
answer. The SQL and workflow assistants are never offered it.
`copy_template` calls `POST /api/templates/{id}/copy`: it makes a copy of the
installed version named, else the installed one, into a new project of the
caller's, with the template's map, a workflow example's workflow (its
bundled results recorded as the caller's outputs by no run) and its datasets
under the caller's names, and answers the project with its members. It is local and sends nothing; a
listed version not installed yet is refused with `template_not_installed`
(fetch it first). It writes projects, maps, layers, workflows and datasets, so MCP marks
it a local addition, not idempotent; it asks for confirmation, its words
naming the version and its size, and the embedded assistant completes a call
naming no version with the installed version before it waits. The SQL and
workflow assistants are never offered it.
`remove_template_downloads` calls `DELETE /api/templates/downloads`, admin-only
and rechecked on every call: it removes every template version downloaded to
this server, with the copies of their data no installed version needs, once
the readers already under way have finished, and answers how many versions
went and the bytes they took. Shipped templates and copies are untouched. It
is local, so MCP marks it a local removal, destructive and idempotent; it asks
for confirmation, its words naming the size the downloads take, and the SQL
and workflow assistants are never offered it.

`add_basemap_style` calls `POST /api/instance/basemaps`,
`set_basemap_style_offered` calls `PATCH /api/instance/basemaps/{id}` and
`remove_basemap_style` calls `DELETE /api/instance/basemaps/{id}`, each
admin-only and rechecked inside its write. The add reads the style's address
once, through the egress check, and keeps the style with its credit or its
host; it refuses an address in blocked space, a style it cannot read now, an
answer that is not a style, an address the library holds and a 51st style,
repeating no part of the address. It reaches outside this server, so MCP
marks it open-world. `update_map` takes an offered style with
`customBasemap: { libraryStyle }`, copying it onto the map and fetching
nothing. While `basemaps.singleMapStyles` is off (`get_config` reports it as
`singleMapStyles`), `update_map`, `undo_change` and `redo_change` refuse a
pasted style address the library does not offer with `basemap_not_offered`
when they would newly put it on a map; an address a map already holds is
kept. Hiding and removing change no map: a map keeps its own copy of a
style it took. The embedded assistant asks before calling any of
them; the SQL and workflow assistants are never offered them.

`get_config` reads `GET /api/config`, which every signed-in account and agent
may call. Besides the basemaps and palettes on offer and the client limits, it
carries `defaults`: what a new map, a new layer, the workflow canvas, the SQL
console and a fresh image export card start with, keyed and valued as
`update_instance_settings` takes them, every key present with its effective
value. `create_map`, `create_layer` and `create_sketch` take those defaults: a
new map its basemap, starting view and legend corner, a layer created without
a style its cycle color, opacity, line width and point radius, and a sketch's
layer its cycle color alone. A default applies to new things only; an existing
map and its layers never change with one. The keys and their values are in
[configuration.md](configuration.md#instance-defaults). It also carries `rules`,
the rules the caller follows (`tokens.create`, `tokens.expiry`,
`publishing.publish`, `publishing.embedding`, `connections.create` and
`imports.links`, valued as `update_instance_settings` takes them), and
`passwordMin`, the shortest password. A tool call a rule refuses, such as
`create_api_token` while only admins may create tokens, or `publish_map` while
publishing is closed to the caller, answers `rule_refused` with `error.rule`
naming the rule and changes nothing; the rules are in
[configuration.md](configuration.md#security-and-rules).

Own-account operations generate `get_account`, `update_account`,
`change_password`, `list_api_tokens`, `create_api_token` and `revoke_api_token`.
They always address the authenticated caller. Password changes, token creation
and revocation declare confirmation and their access consequences in the
contract. Token secrets appear only in the creation response.

Administration generates `list_users`, `invite_user`, `update_user_access` and
`issue_user_sign_in_link`. Every request requires current admin authority;
mutations declare confirmation and their consequences. Invitation and reset
links are disclosed once, expire after the instance's link lifetime (seven days
by default, `security.linkDays`) and are shared by the admin.
`preview_user_deletion`, `delete_user`, `get_user_deletion` and
`finish_user_deletion` use the same admin routes and schemas as Users and the
assistant. Preview shows only totals and a distinct affected-people count.
Deletion requires the preview confirmation, `confirm: true` and the exact email
for an ever-active account after separate deactivation; invitations need no
email. The destructive confirmation states permanent erasure, sharing loss
and broken published links. The description also states provider-cache purging,
permanent identifying SQL-name reservation and backup/copy limits. A `pending`
or `needs-retry` result is unfinished, and the record says requested or
continued deletion rather than claiming completion. Use the same deletion id
with Finish deleting. Completed ids return `not_found`. `list_users` includes
a separate `deletions` array for unfinished work, including after profile erasure.

Finishing deletion rewrites the metadata store and pauses all responses. The
[host guide](self-hosting.md#leaving-and-deleting-accounts) gives measured pauses
and the required data-volume and temporary-filesystem space; a failed compaction
remains unfinished and safe to retry. Completion waits for prepared-copy settlement
or expiry and cleanup. Recorded dataset inputs identify affected foreign derivatives;
existing unattributed card images owned by others remain. Runs whose workflows were
already deleted have no remaining workflow owner and stay with Deleted account as
starter. Copies outside the instance, including downloads and databases written
through connections, are not reached. Backup restoration can revive credentials.

A project's people generate `list_project_people`, `set_project_person` and
`remove_project_person`. Anyone who reaches the project reads them; the two
changes are the project owner's and declare confirmation, since each changes
who reaches the project. `leave_project` ends the credential holder's own grant,
including in a frozen project, after confirmation of reach loss. It takes only
`id` and returns `{"left":true}`, never a roster. Owners receive
`project_owner_cannot_leave`; missing and non-member projects receive `not_found`.
Owned work stays filed and shared, other grants remain, and membership changes
no edit revisions. The assistant uses the same operation and confirmation.
Transfer generates `transfer_project`,
`transfer_map` and `transfer_workflow`, each the owner's and each behind
confirmation, since only the new owner can give it back. `find_accounts`
is the directory search any signed-in account may call to find someone to
share with; it answers display names and SQL names only.

Derivation is pure over a static document, so the tool set is built once per
process and reused.

## Request and upload bounds

MCP admits at most **16,777,216 wire bytes for the entire JSON envelope**,
including base64. A raw upload must be **below 12 MiB**, reduced by envelope
and metadata overhead and by the instance's configured upload cap. For
canonical base64, subtract the serialized empty-content envelope size from
16,777,216, round down to whole groups of four, and allow three file bytes
per group. Longer filenames, project arguments, request ids and client
metadata consume the same envelope budget. Excess returns HTTP 413
`request_body_too_large` before the SDK reads the request.

For a numeric id of 1, `upload_table`, filename `control.csv`, no project
and no extra metadata, the empty-content envelope is 138 bytes. Its maximum
file is 12,582,807 bytes; a 12,582,806-byte CSV uses 16,777,214 wire bytes.
Direct multipart upload uses the separately configured upload limit.

## Counts, measured from the code

| | |
|---|---|
| Documented operations | 401 |
| Operations that become tools | 156 |
| Deliberately excluded | 245 |

Measured by building the OpenAPI document and the tool set from
`src/lib/api/openapi.ts` and `src/lib/tools/tools.ts` and counting the
HTTP methods across `paths`, the operations whose `x-tool` is not `false`,
and the entries `buildTools()` returns.

## The parity check

`npm run lint:contract-docs` compares this page’s numbers with the contract and
derived tools, and the API guide’s catalogue with the source error catalogue.
It fails on drift in the reader-facing text. `src/lib/tools/tools.test.ts`
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
`src/lib/mcp/client-guide.ts`. Create an API / MCP token in Settings and set
`DEZFIL_API_TOKEN` in the environment that launches your client. The copied
configuration stores only a reference to this variable. Restart the client
after setting it. No account password or token belongs in a prompt or tool
argument. A token lasts as long as the instance's rule for new tokens said when
it was created, never expiring by default; once its expiry passes, every call
answers `401 token_expired` and a new token is needed. While an admin keeps
token creation to admins, members cannot create one, and the tokens they
already have keep working.

**Claude Code**

```sh
claude mcp add --transport http dezfil 'http://localhost:3000/api/mcp' --header 'Authorization: Bearer ${DEZFIL_API_TOKEN}'
```

**Codex CLI**

```sh
codex mcp add dezfil --url 'http://localhost:3000/api/mcp' --bearer-token-env-var DEZFIL_API_TOKEN
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.dezfil]
url = "http://localhost:3000/api/mcp"
bearer_token_env_var = "DEZFIL_API_TOKEN"
```

**Cursor**, in `.cursor/mcp.json` for one project or `~/.cursor/mcp.json`
for all of them:

```json
{ "mcpServers": { "dezfil": { "url": "http://localhost:3000/api/mcp", "headers": { "Authorization": "Bearer ${env:DEZFIL_API_TOKEN}" } } } }
```

**Claude Desktop** remote custom connectors are unsupported for this
account-token setup: they do not offer the header configuration above and
connect from the cloud, which cannot reach a private local instance.

Substitute your own instance address in each case. Native syntax is documented
by [Claude Code](https://code.claude.com/docs/en/mcp),
[Codex](https://developers.openai.com/codex/mcp) and
[Cursor](https://cursor.com/docs/mcp). The
[remote connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
describes the Desktop connection. The Developer page's connection check uses
your browser session; it does not test another client's environment or token.

## The plugin package

`plugins/dezfil/` is a self-contained package that bundles the connection
with instructions, so an agent knows how to use the tools rather than only
that they exist. It carries:

- `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, one manifest
  per client, with `.mcp.json` and `.codex-mcp.json` naming the same endpoint
  and their native `DEZFIL_API_TOKEN` reference;
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

## Editing with revisions

A token acts as its account, with the same owner, Viewer and Editor permissions as
REST. Admin status does not bypass private ownership. Sharing is through projects;
connections stay private. SQL in a map or workflow uses that document's SQL home.
Use the `qualifiedName` from dataset listings for another person's reachable data,
and retain captured SQL origins when moving SQL between contexts.

Read the map, layer, workflow or relevant listing and retain its `editRevision`.
Covered tools require `expected_revision`; map updates require it whenever the
body changes content, including unchanged values, but not for viewport-only saves.
Each accepted result preserves the API JSON and its resulting revision in
`structuredContent.result`, also represented in the text result. Chain successive
writes in order using that returned revision. A child edit advances its parent's
token. For compound filing, supply each selected map/workflow revision in the
schema's `members` or resource body rather than one header argument.

Missing revisions are rejected with `invalid_request`; stale ones return
`stale_revision` and change nothing. Read again explicitly, inspect the new state
and compose a new edit before trying again. Never silently replay a refused payload
with a fresh token. The server enforces this precondition for tools as it does for
REST. Complete deletion has no resulting revision, and a transfer may end your
reach. Run starts require the plan's revision; cancellation needs none. See
[the API guide](api.md#editing-with-revisions) for attribution, shared undo,
continuing-run behavior and the bounded exceptions.

The exclusions include automatic HEAD/OPTIONS, entry, transport, renderer and
browser operations. The measured counts above include all documented HTTP methods.

### Executable read and successive tool writes

In Node.js 24 or later, set `base` to the instance origin and `token` to your account
API token. This raw Streamable HTTP example leaves one private map. A connected
MCP client can make the same `tools/call` requests using its normal transport.

<!-- revision-example -->
```js
let requestId = 0;
async function call(name, args) {
  const response = await fetch(base + "/api/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call",
      params: { name, arguments: { ...args,
        ...(name === "update_map" ? { expected_revision: current.editRevision } : {}),
      } },
    }),
  });
  const text = await response.text();
  const payload = JSON.parse(text.startsWith("{") ? text : text.split("\n").find(line => line.startsWith("data: ")).slice(6));
  if (!response.ok || payload.error) throw new Error(JSON.stringify(payload.error));
  const result = payload.result.structuredContent.result;
  if (payload.result.isError) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}
const created = await call("create_map", { name: "Field notes" });
let current = await call("get_map", { id: created.id });
current = await call("update_map", { id: created.id, name: "Survey map" });
current = await call("update_map", { id: created.id, basemap: "light" });
```


Historical actors in reached document facts (`lastChangedBy`), Undo/Redo target
steps (`author`) and workflow runs (`runner`) now have three contract variants:
`{ name, sqlName }`, `{ deleted: true }`, and `null` for Unknown. The generated
output schemas and assistant results carry the same values as REST. Clients
must handle the new deleted variant, which includes no display name, SQL name,
email or other profile fields. Resolve SQL homes separately; changing an actor's
label does not change the stored authorship, timestamps or document revisions.
