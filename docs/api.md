# The HTTP API

Everything Dezfil can do is an HTTP call. The user interface is a client of
this API and has no private path to the engine, so anything you can do by
clicking you can do by script.

This page is a reader's guide: what the families are, how the pieces fit,
and where the rules live. It does not restate field-level detail. That is in
the machine-readable description, which is generated from the same source the
server uses.

## Where the description is served

- `GET /api/openapi.json` on a running instance returns the OpenAPI 3.1
  document. It is the authoritative reference for every path, parameter,
  request body, response schema, and error code.
- `/developer` on a running instance is the human-facing page and links to
  the same document.

The document is hand-written in `src/lib/api/openapi.ts` and its sibling
modules, and a check in the test suite compares it against the implemented
route files in both directions: every route and method must be documented,
every documented operation must have a route, and every call the interface
makes must hit a documented path (`src/lib/api/parity.test.ts`). The
description cannot drift from the server.

Measured from the current source: **117 paths, 155 operations, 147 named
component schemas.**

## Base path and access

Every endpoint lives under `/api`, without a versioned prefix. Each
operation's OpenAPI `security` declaration states its credential requirement.
Account sessions and personal settings accept a session cookie or an account's
bearer token. Setup, sign-in and link redemption are public entry operations;
cookie mutations and entry submissions require a matching request Origin.
Run the instance behind your own network controls.

The published surface remains anonymous. `GET /api/published/{token}`
and its siblings are the read-only, anonymous face of a map someone chose to
publish. The token is 22 random characters (`src/lib/publish/token.ts`), it
is the entire credential, and revoking a publication invalidates it.

## Resource families

Operations carry a tag; these are the tags, with what each family is for.

**System.** `GET /api/health` is the readiness probe: `200` when storage is
usable, `503` with a reason when it is not. `GET /api/config` returns the
runtime settings a browser client legitimately needs (available basemaps,
palettes, the render cap, the preview row count, and whether a geocoder is
configured, but never a configured URL that might carry a key).
`GET /api/openapi.json` serves the description. `GET`/`PATCH /api/settings`
return the caller's account display name and per-screen view preferences,
plus the shared instance name. Only admins may change the instance name.
Every field in a patch is validated and authorized before any write.
`/api/palettes` manages saved color palettes.

**Settings compatibility change.** `/api/settings` now requires authentication
and returns `401` for missing or invalid credentials. `displayName` and
`viewPrefs` belong to the caller's account; first-account setup adopts legacy
preferences. A non-admin patch containing `instanceName` returns `403`, with
all personal and instance fields unchanged. Identity-bearing responses and
refusals use `Cache-Control: private, no-store`.

**Account.** `GET`/`PATCH /api/account` read and update only the caller's
profile. A name change needs no password; changing email requires
`currentPassword`, rejects normalized duplicates and changes the sign-in
identity. `POST /api/account/password` takes `currentPassword` and `password`,
preserves the calling browser session, ends other sessions and leaves tokens
valid. A bearer caller has no browser session to preserve.

`GET`/`POST /api/account/tokens` list or create the caller's named API/MCP
tokens. Creation returns the secret once; list responses never contain secrets
or hashes. `DELETE /api/account/tokens/{id}` revokes an own token; another
account's token ID returns `404` without changing it. Missing, invalid,
revoked or deactivated credentials return `401` on every account operation.
These operations use the same private response and cookie-origin rules as
settings. The Account and API / MCP tokens cards in Settings call these APIs.

**Users.** Admins use `GET`/`POST /api/users` to list or invite accounts,
`PATCH /api/users/{id}` to change another account's admin flag or active status,
and `POST /api/users/{id}/sign-in-link` to replace a sign-in link or reset a
password. Inviting defaults to a non-admin account; `isAdmin: true` explicitly
grants administration. The invitation and reset replies disclose a copyable
`signInUrl` once, with an `expiresAt` timestamp seven days later. The recipient
chooses a password; the instance sends no email. The link credential is carried
in the fragment and does not reach the server until redemption.

Normalized duplicate emails return `email_taken`. A deactivated duplicate also
returns `accountId` and `canReactivate: true`, so the same account can be restored.
An unaccepted invitation returns to invited status on reactivation. Self-demotion
and self-deactivation are refused even when another admin exists, and competing
changes cannot leave the instance without an active admin. Reset invalidates the
password and browser sessions while leaving tokens valid. Deactivation refuses
sessions and tokens; reactivation preserves the account without reviving ended
sessions. No user deletion operation exists.

**Tables.** The catalogue of datasets. `POST /api/tables` takes a
`multipart/form-data` upload; `POST /api/imports/url`,
`/api/imports/osm`, `/api/imports/overture`, and `/api/imports/postgis`
bring data in from elsewhere, several of them with a matching `preview` or
`count` call so the size of an import is known before it runs. Reads are
`GET /api/tables`, `GET /api/tables/{name}` and
`GET /api/tables/{name}/features`. `GET /api/catalogue/tables` is the
schema-only listing built for agents, and is the one paginated endpoint in
the API (below). Geometry recognition lives here too: `GET`, `PUT` and
`DELETE /api/tables/{name}/geometry` with a preview call beside them, and
`GET /api/geometry/projections` for the projection choice.

**Query.** `POST /api/query` runs one read-only SQL statement and returns
columns, an exact row count, a capped preview, and the runtime in
milliseconds. `POST /api/query/export` turns a result into a downloadable
file through a ticket that `GET /api/query/export` then redeems.

**Maps.** A map groups ordered, styled layers. Create, read, update, delete,
duplicate; plus the editing history (`GET /api/maps/{id}/history`,
`POST .../undo`, `POST .../redo`), the dependency read, card thumbnails,
search within a map, widget values, and server-side image export
(`POST /api/maps/{id}/export/image`). `POST /api/maps/look` renders a map
and retains the image briefly for an agent to read back through
`GET /api/maps/look/{renderId}`. These operations and `/render/{id}` require
an account credential and return private, no-store responses. The renderer
forwards the caller's bearer, or a short-lived delegation of their browser
session, on each request to this instance's exact origin. Every request,
including a redirect, rechecks the credential and egress policy. External
basemap and tile requests carry no account credential or cookie. Credentials
never enter the render URL, page initialization, image facts or retained state.

**Layers.** A layer is SQL plus a name plus style. Create it on a map
(`POST /api/maps/{id}/layers`), read and patch it, duplicate it, delete it.
`GET /api/layers/{id}/render` is what the canvas draws;
`GET /api/layers/{id}/tiles/{z}/{x}/{y}` serves a tiled layer.
`GET /api/layers/{id}/fields` and `.../fields/{field}` describe columns and
their statistics, and `POST /api/layers/{id}/fill` and `.../scale` compute a
classification or a size ramp. `GET /api/layers/{id}/export/{format}`
downloads the layer's rows.

**Publish.** `POST /api/maps/{id}/publish` mints a token,
`GET /api/maps/{id}/publish` reads the current publication, and `DELETE`
revokes it. The anonymous side is `GET /api/published/{token}` plus tiles,
render, extent and widget-value calls scoped to that token, which only ever
expose the fields the publication declared
(`GET /api/maps/{id}/published-fields`).

**Sketches.** Drawing on the map as data. A draw session becomes one
ordinary dataset plus one layer; features carry a stable id and a drawn
kind, and deleting the owning layer removes both.

**Operations.** Spatial and data verbs. `GET /api/operations` is the
catalogue of what this instance offers, `POST /api/operations/run` starts
one, and the run is followed through `GET /api/operations/runs` and
`GET /api/operations/runs/{id}`, with a cancel call. Each run produces a
durable dataset with recorded provenance.

**Recipes.** Workflows: a named, ordered list of steps whose dependencies
point only backwards, so the system can answer what is now out of date. The
family covers the workflow, its steps, their order, the canvas layout, and
the runs of both a single step and the whole workflow.

**Projects.** An optional named set over maps, workflows and datasets, with
a members call and an export.

**Connections.** PostGIS connections: create, test, list the remote tables,
preview a relation, snapshot it into a local dataset. Passwords are
encrypted at rest.

**Agents.** The assistant and the MCP endpoint. `POST /api/assistant/runs`
reserves a run, `POST /api/assistant/messages` sends a message under that
run id, and `GET /api/assistant/runs/{id}` re-reads it after a lost
response. `GET /api/assistant/pending` recovers open confirmations, and
`GET /api/assistant/policy` answers what a run on a given page admits.
`POST /api/mcp` is the MCP endpoint; see the MCP page.

## How errors are shaped

Every failure answers the same envelope:

```json
{ "error": { "code": "query_timeout", "message": "..." } }
```

The code is stable and machine-readable; the message is for a person. Some
codes carry documented extra fields beside the two, for example a SQL
error's position, and those fields are declared in the `Error` schema. An
unexpected server-side failure never puts its own message on the wire: it
answers the code `internal` with a fixed sentence and logs the detail
server-side, so filesystem paths and engine text stay out of responses
(`src/lib/api/errors.ts`).

The complete catalogue is published two ways in the same document: as the
enum of the `Error` schema, and as `x-error-codes` at the top level, which
maps every code to a sentence explaining what it means
(`src/lib/api/error-catalogue.ts`). There are **90** codes. Clients should
branch on codes, never on prose.

One status is unusual: a client that abandons an in-flight evaluation gets
`499` with no body, the de-facto convention for a client-closed request.

## Bounds, limits and pagination

There is no general pagination. Listings return their whole set, which is
sized for a single instance, and the bounds that matter are on the work
rather than on the page:

- `GET /api/catalogue/tables` is the exception. It pages with `limit`
  (1 to 32, default 32) and an exclusive `after` cursor over table names,
  and pages columns separately with `columns` (0 to 64, default 64) and
  `columnOffset`. It exists so an agent can walk a large catalogue without
  pulling everything.
- `GET /api/operations/runs` takes a `limit` and answers newest first.
- Query results carry a capped preview and a flag saying whether it was
  truncated, plus the exact total row count, so a caller always knows what
  it is not seeing.
- Timeouts, memory budgets, size caps, area budgets, render caps, queue
  depths and anonymous rate limits are all configuration; see
  [configuration.md](configuration.md). When one is hit the answer is a
  coded error naming the bound, not a truncated success.
- Request bodies for workflow layout documents have an explicit byte bound
  and are refused with `request_body_too_large` before parsing.

## Edits that belong together

Map and layer edits that a person would think of as one action accept an
`X-Change-Group` header. Calls sharing a value fold into one entry in that
map's undo timeline, so a multi-call edit undoes as a unit.

## The read-only SQL instance

User SQL never touches the instance that owns the data. It runs on a
separate, hardened, read-only engine instance, and it passes two gates
before it runs.

First, the statement must be a single read-only `SELECT`. The check uses the
engine's own parser rather than a keyword blocklist: the statement is
serialized, and only `SELECT` statements serialize
(`src/lib/query/guard.ts`). Anything that would change data or schema, alter
settings, load an extension, attach a database or write a file is refused
with `sql_rejected`. More than one statement in a request is refused too.

Second, the instance itself is locked down at creation
(`src/lib/duckdb.ts`): extensions are loaded first and then further loading
is disabled, external access is switched off, the filesystem is fenced to
the dataset directory and the tile scratch directory, spilling to disk is
disabled, the memory budget is applied, and the configuration is locked so
none of that can be changed afterwards. Datasets are exposed to it as views
over their files, so user SQL sees table names and never paths
(`src/lib/query/views.ts`).

Everything that evaluates user SQL goes through this path: the SQL
workspace, layer rendering, classification, published views, and every
agent tool that runs SQL. There is no browser-side query engine.

## Driving the whole thing headlessly

`node scripts/journey.mjs <base-url>` walks the entire flow, upload through
SQL, layer, style and publish, using nothing but these endpoints and no
browser. It is the working proof that the interface has no private path.

### Assistant identity

MCP and all assistant transport operations require the caller's session or
bearer token. Reservations, recovery receipts and pending confirmations belong
to the reserving account. Another account cannot read, cancel, release,
supersede or resolve them. Confirmation reauthenticates the same account and
checks current permissions during execution, including admin restrictions.
Internal grounding, subject reads and tool calls carry a bearer-equivalent
credential; the parked state retains the account binding and no credential.

**Private layer reference compatibility change.** Layer routes require an
active account and resolve each layer through its owning map. Administrators
have the same private boundary. Hidden and missing layers both answer
`not_found` (404), including fields, statistics, rendering, tiles and direct
exports. New widget, timeline, legend-order and layer-order references must
belong to the exact map being edited. A missing or mismatched reference now
answers `not_found` (404), replacing the former `invalid_request` (400).
Malformed input still answers `invalid_request`. An unchanged orphan widget
already stored in history remains readable and can be echoed unchanged.

History and thumbnails inherit the map's ownership. Undo and redo validate the
whole recorded gesture, including layer targets and saved map references,
before changing records or deleting artifacts. A foreign or mismatched replay
reference returns `not_found` and leaves the cursor and all records unchanged.
Restoring a deleted layer preserves its recorded identity and parent; it cannot
replace a live layer belonging to another map. Thumbnail reads, writes and
copies check the owning map, and staged writes recheck access before publishing.

Dataset names belong to the authenticated account. Different accounts can each
import `roads`; uploads and sketches choose suffixes using only the creator's
names. Dataset lists, catalogue totals and schema pages, inspection, features,
exports, sketch edits, geometry and refresh resolve that account's datasets.
Administrator status grants no access to another account's data. Project contexts
and sketch parents must belong to the same account and are checked before source
or artifact work. Refresh and geometry changes keep the durable identity and
owner, rechecking account activity before committing. Hidden and missing names
and references return the same `404 not_found` response. This replaces the
previous `map_not_found` response for a missing sketch parent.

Saved PostGIS connections are private to their creator. The list, edits, tests,
source catalogue, previews and snapshot lists use that account, including for
admins. Names are unique within the account. Hidden and missing connection IDs
both return `404 not_found` with the same generic message before credentials,
source access or health writes. Stored import and refresh references obey the
same rule; an imported dataset does not grant access to its source connection.
Private source work rechecks access before committing or recording health.
This is a breaking error-contract change for a snapshot whose saved connection
is missing: refresh now returns `404 not_found` instead of `409 not_refreshable`.
Connection absence messages no longer echo the submitted ID.

Workflow definitions, steps, layouts and layer captures resolve within the
caller's account. Hidden or missing workflow, step, captured-layer and project
references use the same generic `404 not_found`, including mixed parent/child
requests. Refused compound changes leave definitions and filing unchanged.
Output-name conflicts and duplication consider only that account's datasets
and declarations; same-workflow conflicts and the frozen name of an existing
output retain their previous rules. Deleting a workflow leaves its datasets.
