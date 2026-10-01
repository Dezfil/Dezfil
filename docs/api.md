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

Measured from the current source: **118 paths, 156 operations, 147 named
component schemas.**

## Base path and access

Every endpoint lives under `/api`, without a versioned prefix. Each
operation's OpenAPI `security` declaration states its credential requirement.
Account sessions and personal settings accept a session cookie or an account's
bearer token. Setup, sign-in and link redemption are public entry operations;
cookie mutations and entry submissions require a matching request Origin.
Run the instance behind your own network controls.

Authenticated requests may carry `X-Dezfil-Account` with the expected account
ID. A mismatch returns `401 authentication_required` before dispatch. Like the
credential itself, this is a transport precondition, not an operation input;
it never selects an owner or grants access. The browser uses it to fence work
started before a cookie changes. The workspace checks `/api/auth/session`
before mounting, clears private drafts and retained results on account changes,
and reloads cached back-navigation pages through the existing access checks.

Maps, datasets, workflows, connections and projects are private to their
creator. Contained layers, widgets, histories and runs follow their parent;
standalone jobs and retained export/render results remain private even after
failure or output deletion. Admin status grants no private-content access.
Dataset and connection names are unique within one account. Hidden and missing
resources receive the same refusal, and SQL mounts only the caller's datasets.
There is no owner selector or ownership-transfer operation.

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

Built-in and configured basemaps, the palette catalogue, geometry projections,
the API reference, operation catalogue and offered assistant models are shared
instance resources. They require authentication but have no owner filter.
Any authenticated account can create or delete a saved custom palette,
including one created by another account. Deleting a palette keeps existing
layer colors. A map's own styles and custom basemap remain private to its owner,
including when another caller is an admin. Model and geocoder credentials are
server settings; catalogue responses never return their secret values.

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

Every account read (`/api/account`, `/api/auth/session` and an admin's
`/api/users`) carries `sqlName`, the account's SQL name: three to thirty-two
characters, a lower-case letter first, then lower-case letters, digits and
underscores, unique on the instance. It is derived from the display name (else
the email's local part, else `user`, with a number added on a collision or on a
name the query engine reserves) when the account is created or upgraded, and is
fixed thereafter: a name or email change leaves it as it was.

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

**Breaking SQL change:** direct file reads and path discovery are also refused
with `sql_rejected`, regardless of ownership or whether a path exists. The parsed
policy rejects file readers, file-relation shorthand, path-bearing settings and
engine definitions before user targets can bind or probe the filesystem. Nested
SQL and computed table names follow the same policy; admitted dynamic arguments
are frozen for that evaluation. Explicit safe catalogue name/schema projections
remain available, but definition/path columns, whole rows and stars over those
catalogues are refused. Query uploaded data by its dataset name.

Projection definitions supplied to `ST_Transform`, `ST_SetCRS` or a geometry
type cannot reference PROJ initialization files, grid files or model files. This
also covers computed and per-row CRS values, WKT file parameters and PROJJSON
file parameters, before the native projection library receives them. EPSG
identifiers and inline definitions without files remain supported.

SQL referring to a table outside the caller's space returns the same
`sql_error` for a hidden or nonexistent table. It includes no name suggestions.
Engine failures omit internal statements, artifact paths and native-library
internals. Input diagnostics and a source position remain when available.

Stored SQL is not rewritten. A saved file query or affected published layer
returns its normal error treatment until its owner changes the query to use a
named dataset. Rendering, widgets, search, exports, materialization, REST, MCP
and assistant calls all use this policy; search omits a failing layer as before.

Second, the instance itself is locked down at creation
(`src/lib/duckdb.ts`): extensions are loaded first and then further loading
is disabled, external access is switched off, the filesystem is fenced to
the dataset directory and the tile scratch directory, spilling to disk is
disabled, the memory budget is applied, and the configuration is locked so
none of that can be changed afterwards. Every evaluation gets a fresh connection
and temporary views for its account's datasets only (`src/lib/query/views.ts`).
One hardened engine serves all accounts under the same shared memory budget.
The views disappear when the connection closes. Artifact projection metadata
may be cached by owner, dataset identity, artifact and geometry metadata; the
views and binding evidence are recreated on each connection.

Unqualified names, `main.table`, `memory.table`, `memory.main.table`, and
computed `query_table()` / nested `query()` references resolve inside that local
catalogue. The compiler preserves stored SQL. Publication evaluations use the
publication owner's dataset scope, including inactive owners and pending
adoption. Refresh, deletion and name reuse affect later evaluations; an admitted
materialization keeps its captured identities and artifacts until it completes.

Geocode and isochrone preparation pass opaque, account-bound staging inputs
only to the evaluation that publishes that job. Their SQL names temporary
relations; it contains no file reader. Ordinary evaluations, including another
query by the same account, cannot name those relations. JSON request fields
cannot authorize a staging mount. Completion, failure, cancellation and timeout
release the inputs; removal waits for any admitted reader to close.

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

Projects, member counts and membership operations are account-scoped. Every
member in a compound change must have the same owner as the project; a hidden
or missing member returns the generic `404 not_found` and the whole change
rolls back. Initial filing follows the same rule. Deleting a project unfiles
its contents without deleting or transferring them. Export selections are
checked before archive assembly and account activity is checked again before
returning the completed file. A hidden or missing selected export member now
returns `404 not_found` rather than `400 invalid_request`; this is a breaking
error-contract change. An owned resource outside the project still returns
`400 invalid_request`.

Dependency checklists resolve dataset identities, project memberships and
workflow producers within the authenticated account. Workflow lineage retains
the original input identity and bound artifact after deletion; a new dataset
with the same name does not replace that history. Tile fingerprints include
owner-selected dataset identities and artifacts, so another account's imports,
refreshes or deletions do not change their freshness.

Operation jobs keep their initiating owner independently of any output. Their
parameters, errors, results, subject histories and cancellation are private,
including after output deletion. Identical subject names and history limits are
separate per account; output-name conflicts are checked in that account's space.
Workers check current account activity before preparation and at publication.
An unfinished job whose owner becomes inactive fails with
`authentication_required` and keeps no new dataset or staging artifact. Restart
reconciliation settles interrupted jobs without re-executing them, and prunes
each recorded owner's history independently. Workflow cancellation carries the
same account scope to each contained job.

Workflow plans, run histories, member attempts and retained outputs follow the
workflow owner's private scope. Every supplied step or run must belong to the
addressed workflow. Hidden, missing and mixed-parent references return the same
`404 not_found`, before planning or admission. A changed confirmation containing
only current owned members still returns `409 plan_changed`.

Workflow execution rechecks activity after planning, at worker entry and before
publication. Deactivation drains admitted work, prevents further admission and
publication, and preserves outputs already committed. The workflow keeps terminal
attempts even when job history prunes them or a step or output is deleted. Startup
reconciliation marks unfinished runs interrupted, including inactive owners' runs,
and never re-executes them or attaches another owner's job attempt.

Private layer renders, tile status and tile bytes follow the map owner, including
for administrators. Builds retain their initiating account authority across the
queue, export and atomic archive swap. Deactivation before publication prevents a
new authoritative archive, and an in-flight private read rechecks activity before
returning bytes. Deleting an owned layer fences its outstanding build; reactivation
permits a fresh build. Visible published layers use their current publication token
independently of owner activity. Revocation prevents that token's outstanding build
from publishing an archive.

Assistant receipts and parked confirmations are private to their initiating
account, including for administrators. Ownership survives failure and deletion
of an output. Deactivation interrupts unfinished execution, discards late
provider content and prevents further tool admission; committed work remains.
Reactivation restores access to the same receipts. A hidden confirmation cannot
be resolved or consumed. Superseding an unknown or hidden confirmation is a
harmless no-op for that confirmation.

Retained map checks and prepared layer, query and project downloads also bind
to the initiating account independently of their source. Only that account can
retrieve, observe or release them, including after source deletion. Copied ids
receive the same refusal as unknown ids without consuming the owner's result.
Render and export execution rechecks activity before returning or retaining
bytes; a deactivated caller cannot redeem a retained result. Existing eviction,
expiry, stream cleanup and process-restart behavior remains unchanged.

`DELETE /api/publications/{token}` lets a current admin revoke a known link
only while its owner is deactivated. The authority and owner-status checks
share the revocation transaction. An active owner's link, an unknown token,
and an already revoked token receive the same `not_found`; success is `204`
with no content. The operation provides no map discovery or private read
access. Its generated tool is `revoke_inactive_publication`, with destructive
consequence metadata and confirmation using only the submitted token.

Anonymous publication queries retain the publisher's dataset scope rather
than a signed-in visitor's. Deactivation does not revoke existing links.
Before first-account setup, legacy links carry a publication-only
pending-adoption scope; setup atomically replaces it with the original
account's scope. Token revocation is rechecked after asynchronous widget,
render and extent work, and retires cached or in-flight assembled views.
