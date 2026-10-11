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

Measured from the current source: **142 paths, 401 operations, 185 named component schemas.** Operations include supported automatic HEAD and OPTIONS.
`npm run lint:contract-docs` measures these numbers and checks the catalogue below
against the contract; changing only the reader-facing text fails the gate.

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

Who can reach and change what (owners, project roles, SQL names and homes,
addressing another person's dataset, transfer, and what stays private) is
described under [Ownership and sharing](#ownership-and-sharing) below; the
boundary rules of each family are under
[Access rules in detail](#access-rules-in-detail).

The published surface remains anonymous. `GET /api/published/{token}`
and its siblings are the read-only, anonymous face of a map someone chose to
publish. The token is 22 random characters (`src/lib/publish/token.ts`), it
is the entire credential, and revoking a publication invalidates it.

The error catalogue includes `409 stale_revision` for a refused document
basis: “This item has changed. Reload it before trying again.” This refusal
changes nothing. A new attempt starts with a deliberate read and a new edit;
clients must not silently retry an old payload with a newer token. Revision
preconditions are declared on the operations that require them.

## Request bounds

Measured JSON reader operations: **69**. These counts include optional bodies,
helper readers and MCP's external parser handoff, and exclude multipart uploads
and binary thumbnails. The contract gate measures them; type-aware body-policy
coverage independently checks the implementation against the contract.

<!-- body-tiers:start -->
| JSON wire-byte tier | Operations |
|---|---|
| 65,536 | 17 |
| 131,072 | 1 |
| 16,777,216 | 51 |
<!-- body-tiers:end -->

Authentication entry, Account, Users, instance settings and the anonymous widget-values, render
and extent POSTs accept at most 65,536 wire bytes. This includes whitespace,
escaping and multi-byte UTF-8, regardless of Content-Type. Excess answers 413
before JSON parsing. Access and origin checks precede protected work; refusal
never becomes a parse error, an optional default or a write.

Outside the two workflow readers and the assistant reader, the exact envelopes
are `{"error":{"code":"request_body_too_large","message":"The request body exceeds the 65536-byte limit."}}`
and `{"error":{"code":"request_body_too_large","message":"The request body exceeds the 16777216-byte limit."}}`.
At the handler, declared excess refuses without reading, and a crossing chunk
is cancelled without retaining it or pulling again. On framework-matched paths
this is a handler guarantee: the framework may already have drained and copied
up to its 17 MiB limit before the gate, including anonymous callers. Canonical
spellings of the excluded public widget-values, render and extent POST paths
additionally refuse before a large wire body completes. Multipart uploads at the
canonical `/api/tables` path stream to disk without the framework copy, under
their file and archive limits. A reverse proxy's own request-size limit bounds the matched
paths' residual copy further; see [self-hosting](self-hosting.md).
`TRACE` returns an empty 400 at the native door before body work.

Map, layer, widget, sketch, export and project JSON readers accept at most
16,777,216 wire bytes. Optional bodies have the same outer bound: an oversized
body never selects a default. The published render selection reader stays at
65,536 bytes, including semantically valid filters whose strings exceed it.

The finite-field controls measure 400,076 bytes for a 10,000-vertex sketch,
262,201 for a maximal custom-icon patch, 1,500 for the fully populated
4096-square export request, 21,976 for twelve widget selections, and 22,055
for those selections with timeline bounds. Sixteen render filters with 200
16-byte values measure 61,712 bytes; 18-byte values measure 68,112 and refuse.
The viewer's twelve selections of fifty 30-character CJK values with distinct
three-digit suffixes measure 58,288 bytes and fit. Unbounded strings and JSON
escaping still count toward the outer limit.

All other JSON consumers, including query, import, connection, own-settings, table
and helper operations, use the 16,777,216-byte tier. Workflow readers retain
their existing 16 MiB bound, required or optional empty-body behavior and
`request_body_too_large` with the message "The workflow request body exceeds the
16777216-byte limit." Assistant messages retain 131,072 bytes and
`assistant_submission_too_large`. Multipart uploads and binary thumbnails
are separate body classes.

Body policy coverage uses the TypeScript receiver type and resolved calls,
including aliases and helper parameters. Raw Request body members are confined
to `src/lib/api/bounded-body.ts` (JSON bytes),
`src/lib/api/thumbnail-body.ts` (binary thumbnails), and
`src/lib/ingest/receive.ts` (streaming multipart).
`src/lib/api/bounded-handoff.ts` alone constructs the admitted Request for an
external JSON parser. Workflow and assistant readers use the shared byte
reader with their own refusal contracts. Response reads are a separate type.
The coverage check matches enforced limits, error codes, descriptions and
413 responses against OpenAPI in both directions.

## Anonymous published budgets

Anonymous published API reads use verified ingress sources. View, widget-values,
render and extent share 60 requests per ten seconds across tokens; tiles have
600 in their separate bucket, with the existing configuration overrides.
Unknown tokens are charged before resolution. Across both buckets, at most
10,000 source entries are retained. Traffic sweeps expired windows at most once
per second; between sweeps, a new source at capacity evicts the least recently
used entry. The bound holds either way. Eviction grants a fresh window.
Window expiry permits retry; a refusal remains 429 `rate_limited`, “Too many
requests. Please slow down.” No new retry-header guarantee applies.

Direct socket sources have independent budgets; equivalent IPv4 and mapped
IPv4 addresses share one. A trusted proxy chain uses the nearest untrusted hop.
Behind an untrusted proxy, readers share its socket budget by design; forwarded
headers cannot separate it. Missing or forged provenance answers private,
no-store 503 `ingress_unavailable`, “The instance cannot serve published maps
yet.”, before reading a body or resolving a token. Malformed wire provenance
still answers 400. The viewer page is outside these API budgets; IPv6 address
rotation is not bounded by this policy.

## Ownership and sharing

The rules for who sees and changes what are the same on every client: the
pages, REST with a session or a token, MCP and the assistant.

### One owner, private until a project shares it

Every map, dataset, workflow, connection and project has exactly one owner,
the account that created it. Creation takes the owner from the credential,
never from a field, and there is no owner selector. Everything starts private
to its owner, administrators included: admin status manages accounts and the
instance name and grants no access to anyone's content.

Sharing happens at one boundary, the project. A project's owner gives a
person the role `viewer` or `editor`, and that one grant covers every map,
workflow and dataset filed in the project, whoever owns it. Nothing else is
shared: not unfiled work, not a single map or dataset on its own, and never a
connection. A person **reaches** a resource when they own it or when it is
filed in a project they own or belong to; anything else answers exactly as
if it did not exist.

Reach decides every read. Lists, counts, the `?project=` filter, the table
catalogue and schema discovery, dependencies, lineage, previews, renders,
tiles, widget values, exports and downloads cover exactly what the caller
reaches. Every map, workflow and dataset read and listing names its `owner`
(display name and SQL name); every project names its `owner` and the
caller's `role` (`owner`, `editor` or `viewer`), and the project filter
offers the caller's own projects and the ones shared with them. Facts about
what the caller does not reach are left out rather than named: a dependency,
an input in a dataset's lineage, a membership in another project, a
connection. A reachable document is shown as stored, its SQL text and
history included.

Changes to who holds a role, removals and a project's dissolution govern the
person's very next request, with no sign-out. The people and transfer
operations are described under Projects in the families below.

### What each role can do

**A viewer** reads everything filed in the project in full: maps with their
layers, widgets and history, workflows with their steps, layout and run
history, datasets and their previews, renders, tiles, widget values, layer
and dataset downloads, SQL over the project's datasets, and the project
export. A viewer changes nothing: every write to something they do not own,
running a workflow, filing, publishing, undo and card images included,
answers `403 forbidden` and changes nothing. A viewer may duplicate a reached
map or workflow into their own space: the copy is theirs, unfiled, and keeps
the original's SQL home.

**An editor** has everything a viewer has and changes the content of the
maps and workflows filed in the project, whoever owns them: layers, styles,
widgets, camera, legend, history and undo, workflow steps and parameters,
names and notes. SQL or a dataset parameter that an editor saves into
someone else's map or workflow, directly or through undo and redo, must name
only datasets within the editor's own reach in its SQL home, a workflow's
declared outputs aside; otherwise the save is refused with `sql_error`
naming the reference, and nothing changes. An editor can never lodge a
reference they could not evaluate themselves. An editor runs the project's
workflows: each run is the runner's own, its outputs are created as the
runner's datasets, never replacing anyone else's, and are filed into the
workflow's project as each one commits, and a rerun replaces only that
runner's earlier output. An editor draws sketches on a shared map, each
sketch dataset the drawer's own. An editor files their own maps, workflows
and datasets into the project and removes them again, and an editor's
duplicate of a reached map or workflow is filed into the project.

**The owner of a map, workflow or dataset** keeps the acts that change what
it is or who holds it: deleting it, transferring it, a map's card images and
its publication settings (the token, the published fields, the widget
publication toggle, the theme and the reader controls). Datasets change,
refresh and go only by their owner, whatever the role, because a dataset's
name is bound into other people's SQL. The owner of a resource may always
withdraw it from any project, member or not. A person removed from a project
keeps their own work filed there until they take it out: their own reads and
listings still report that project's identity (`projectId`, `projectIds`),
though the project itself stays absent to them, so the work never reads as
in no project and they withdraw it by that identity on the members call.

**The project's owner** alone renames the project, edits its note,
dissolves it, gives and removes roles and transfers it; an administrator has
no such power over someone else's project. The project's owner may also act
as an editor on any map or workflow filed in the project, and may remove
anything filed there. Removing never deletes or reassigns anything, and
dissolving a project unfiles its contents and ends every member's reach
through it.

Deleting a dataset never changes another person's map or workflow: a layer
or step that named it fails by name for whoever opens it. Removing a layer
that draws someone else's sketch leaves their dataset; removing one's own
sketch layer also deletes its dataset.

A request naming something the caller does not reach answers `404
not_found`, the same as for something that does not exist; a change the
caller may not make to something they reach answers `403 forbidden` with one
fixed sentence. Neither changes anything.

### SQL names and SQL homes

Every account has a **SQL name**, `sqlName` on account reads, on every
`owner` and in the directory search (see Account below). It is how SQL names
another person's dataset and how the sharing operations name a person.

Every map and workflow has a **SQL home**, `home` on every read: the SQL
name of the account that created it. Transfer, duplication and the person
looking leave it unchanged. The home decides what a plain table name means:

- In the SQL console, and wherever SQL is run directly (`POST /api/query`
  without `writtenIn`, an operation's parameters), the home is the caller:
  `roads` is the caller's own dataset.
- In a map's layers and widgets and a workflow's steps, the home is the
  map's or the workflow's: `roads` is the home account's dataset, or, in a
  workflow, its own output named `roads` when it declares one. That holds
  for whoever evaluates it and for every purpose: rendering, fields,
  statistics, classification, extent, sliders, widgets, search, exports,
  image renders, tiles and workflow runs. `writtenIn` on `POST /api/query`
  evaluates in a map's or workflow's home instead of the console.
- `<sql name>.<dataset>` names that person's dataset wherever a table can be
  named, external even when a workflow output shares the name; the caller's
  own SQL name qualifies their own.

A name resolves only when the caller reaches the dataset. In the console an
unreachable name fails as an unknown table; in a map's or workflow's
evaluation it fails with `The dataset "<reference>" is not available to
you.`, the same whether the dataset is hidden or missing, and a same-named
dataset of someone else is never drawn in its place. So when Bob opens
Ada's map, its plain `roads` is Ada's `roads`, drawn while Bob reaches it,
and Bob's own `roads` appears in that map's SQL as `bob.roads`. How the
engine does this is under
[The read-only SQL instance](#the-read-only-sql-instance).

### Addressing another person's dataset

Two reachable datasets may share a name. Every listing gives each dataset
its `qualifiedName`, the name the caller would type: the plain name for
their own, `<sql name>.<name>` for anyone else's. A bare name in a path or
an operation parameter keeps its meaning, the caller's own dataset. Another
person's dataset is addressed by its qualified name (`ada.roads`) on dataset
reads, features, downloads, the catalogue's `names` filter and operation
parameters, or by its identifier in a `/api/tables/{name}` path. A dataset
parameter stored in a workflow step follows the workflow's home, not the
caller. A change to another person's dataset, by any address, answers `403`.
A project export gives each dataset its own archive entry under its
`qualifiedName`, and its map and workflow documents carry their `home`, so
two people's `roads` never collide.

### SQL that moves between homes

The same text means different datasets in different homes, so SQL that
moves from where it was written into another context (console SQL added to
a map, a builder preview saved as a layer, a layer captured into a workflow
step, a node pasted between workflows, a previewed result saved as a
dataset) is carried, not copied. The operations that store it take
`writtenIn`, and each reference is rewritten only as far as it must be to
keep the dataset it meant in its new home. Where that cannot be done the
request is refused with the reason; nothing silently rebinds. The rules are
under [Carrying SQL between contexts](#carrying-sql-between-contexts).

### Transfer

Transfer is the only change of ownership, always the current owner's own
act, with the recipient named by SQL name as `{"to": "<sql name>"}`:

- A project goes to one of its active members
  (`POST /api/projects/{id}/transfer`): the recipient leaves the member
  list, the previous owner becomes an editor, and the name, note, other
  people and contents stay as they were, each filed item keeping its own
  owner.
- A map or workflow goes to an active person who already reaches it through
  the project it is filed in (`POST /api/maps/{id}/transfer`,
  `POST /api/recipes/{id}/transfer`); an unfiled one must be filed first. It
  keeps its SQL home, so its SQL means what it meant, and everything that
  hangs off it: a map's layers, history, card images and publication, which
  becomes the new owner's and renders with the new owner's reach; a
  workflow's steps, layout and run history, each run's outputs staying with
  whoever ran it.
- Datasets and connections have no transfer.

A recipient who is deactivated, not yet redeemed, unknown or out of reach is
refused with `invalid_request`, anyone else who reaches the resource with
`forbidden`, and a refusal or a failure changes nothing.

### What stays private

- **Unfiled work**, and anything filed only in projects a person neither
  owns nor belongs to.
- **Connections.** A project grant reaches the datasets filed in it, never
  the PostGIS connection behind one: the connection answers anyone but its
  owner `not_found`, refreshing the dataset is its owner's act, a reached
  snapshot shows its origin kind and nothing about the connection, and a
  project archive carries no connection facts.
- **Work that outlives the request.** Standalone operation runs, prepared
  downloads, retained look images and server renders, and assistant runs and
  confirmations belong to the account that started them. Reach is asked
  again where such work commits: a prepared download on its claim, a render
  at every phase, a project export as the archive completes, a pending
  confirmation when it resumes. A result already issued stays its
  initiator's for its retention lifetime after reach is withdrawn, as a copy
  they hold, and grants no new access to its source. Runs contained in a
  workflow follow the workflow instead: everyone who reaches it reads them,
  and the run's initiator or the workflow's owner cancels one, the initiator
  even after they stop reaching the workflow (answered `204` without the
  run).
- **The account itself**: its profile, password, API tokens and personal
  settings. The directory search (`GET /api/accounts/search`) is the one
  deliberate exception to account reads being an admin's, and it offers
  active people's display names and SQL names and nothing else.

### Published links

A published link stays anonymous and read-only, and its settings are the
map owner's alone, editors included out. It renders live in the map's SQL
home with the map owner's current reach, restricted to the datasets the
map's own layers name: an editor's permitted content edits reach the link at
once, a transfer never rebinds it, and nothing else of the owner's space can
be reached through it. Details are under Publish in the families below.

### Deactivated accounts

Deactivation freezes by owner. Every map, workflow, dataset and project a
deactivated account owns stays reachable to whoever reached it, with its
content and ownership read-only for everyone, editors and the project's owner
included, until reactivation. Filing is not content: an active owner may
still withdraw their own resource from a frozen project, and an active
project owner may remove a frozen resource from theirs, while a frozen
project accepts nothing new. A deactivated member keeps their place, marked,
with the role inert until reactivation, and the owner can remove them. A
project whose owner is deactivated stays shared as it was, with its people
and its transfer unavailable, administrators included. A workflow whose
owner is deactivated can still be run by its editors and the project's
owner. Existing publications stay readable. Reactivation restores everything
to the same person.

## Resource families

Operations carry a tag; these are the tags, with what each family is for.

**System.** `GET /api/health` is the readiness probe: `200` when storage is
usable, `503` with a reason when it is not. `GET /api/config` returns the
runtime settings a browser client legitimately needs (available basemaps,
palettes, the render cap, the preview row count, and whether a geocoder is
configured, but never a configured URL that might carry a key), and
`defaults`: what a new map, a new layer, the workflow canvas, the SQL console
and a fresh image export card start with on this instance. `defaults` is one
flat object keyed and valued as `PATCH /api/instance/settings` takes them, every
key present with its effective value; a basemap the instance no longer offers
reads as `auto`, which is what a new map starts on. Every signed-in account and
agent can make this read. [The configuration guide](configuration.md#instance-defaults)
lists the eighteen keys with their values and defaults. The same read carries
`rules`, the rules every account follows, keyed and valued the same way:
`tokens.create`, `tokens.expiry`, `publishing.publish`, `publishing.embedding`,
`connections.create` and `imports.links`, each with its effective value; and
`passwordMin`, the fewest characters a password set from now needs.
[The configuration guide](configuration.md#security-and-rules) lists them with
the rest of the sign-in and publishing settings. `templates.catalogue` says
whether the template catalogue is in use.
`GET /api/openapi.json` serves the description. `GET`/`PATCH /api/settings`
return the caller's account display name and per-screen view preferences,
plus the shared instance name. Only admins may change the instance name.
`sourceGrouping` is how the SQL console's source list groups datasets for
the caller, `person` (their own, then each other person's) until they choose
`project`; the read always carries it, and it is one account's alone.
`look` is the caller's look, six picks with the first choice the default:
`color` (`kelp`, `harbor`, `heather`, `slate`), `contrast` (`standard`,
`more`), `font` (`inter`, `system`), `background` (`atlantic`, `plain`,
`graticule`, `hex`), `corners` (`rounded`, `soft`) and `rail` (`hover`,
`open`, `icons`). The read always carries all six, a kept value this version
no longer offers reading as its default without being rewritten; a patch
takes any of them and leaves the rest as they are. There is no `null`: a
pick returns to the default when its first choice is sent. Inside `look`
nothing unknown is tolerated: a `look` that is not an object, a value outside
a pick's choices (`null` included), or a key that is not a pick refuses the
whole patch with `invalid_request`. A failing pick is
named as `look.<key>: reason`; a key that is not a pick is identified by its
position inside `look` and never echoed, since arbitrary key text may hold a
credential. Unknown fields elsewhere in the body are ignored.
The complete document remains `displayName`, `instanceName`, `viewPrefs`,
`sourceGrouping` and `look`. View and sort choices for maps, data, workflows
and projects, the SQL grouping choices and the look's choices come from the
account setting definitions.
Partial slices merge; absent slices stay absent and stored preferences are
not filtered on read. One account's patch never changes another's preferences.
Every field in a patch is validated and authorized before any write.
`/api/palettes` manages saved color palettes.

`GET /api/instance/settings` requires a current admin, through a cookie or
bearer token, rechecked on every call. Successes and refusals are private,
no-store. Its `settings` object names every instance and platform key with
the definition, effective `value`, `source`, `storedValue`, `locked` and
`invalidOverride`. A non-empty environment override locks the setting;
an invalid numeric override remains locked on its default without exposing
the rejected text. Shadowed stored values remain visible. Environment changes
require a restart. Empty numeric overrides count as absent; a set empty
assistant model list keeps only the default model.

Provider credentials disclose only `{ set: true }` or `{ set: false }`.
The encryption key discloses `environment`, `data-directory` or
`not-yet-present`, without generating or reading a key. Address `value` and
`defaultValue` disclose only scheme and host as `origin`, or
`{ set: true, unreadable: true }`; user information, paths, queries and fragments
are absent. A service address is write-only: its `storedValue` is always null,
and one an admin stored reads as `{ set: true, origin }`, or as set and
unreadable once the instance's encryption key no longer opens it. The satellite
tile template in effect, stored or set by `DEZFIL_SATELLITE_URL`, reads as
`{ set: true, origin, userInformation: true }` while it carries a user name or
password, never given: no browser loads tiles from it, so the imagery is not
drawn. With
neither a stored address nor a variable, the address finder and travel time
read `{ set: false }`, OpenStreetMap the public Overpass server's origin and the
S3 address the rule `aws-bucket-endpoint`, Amazon S3's own addresses.
The built-in `documentedDefault` stays as documented, including any
path. Contextual defaults can carry a `rule`. `services` reports what the
services keep, read from the data folder and this process: for `geocode`,
`isochrone` and `overpass` their cache's `bytes`, `answers` and `budgetMb`, and
for `overture` the release list this process keeps, `{ listed: false }` or
`listed` with `releases`, `newest` and `listedAt`. `parts` reports each part of
the server as System's Status shows it: for `query_engine` the engine library's
`version`, whether the engine that runs people's SQL has `started` and the
`extensions` it loaded; for `tile_builder` whether the program is `found` where
its setting points (a bare name looked up on the search path, by a file check)
and its `version` once this server has run it, else null; for `image_renderer`
whether its browser is `found` and `imagesAtOnce`; for `metadata_database` its
`file` name without its folder. The read contacts no provider, initializes no
engine, launches no browser, runs no program and creates no configuration
artifact. `capacities` contains
`geocodeRows` (at least one) and `isochroneOrigins` (possibly zero), matching
operation admission without promising a provider. `maxImageDimension` is
the fixed export maximum; `version` is the package version and `startedAt`
is the stable process start time. `warnings` reports an effective query timeout
at or above the run timeout, including a mismatch imposed by the environment.

`GET /api/auth/entry` anonymously returns `instanceName`, `signInMessage`,
`lostPasswordContact`, `landingPage`, `passwordMin` and `setupRequired`, plus the
legacy `prefillName` before setup. `passwordMin` is the shortest password the
screen's new password needs: 8 for the first account, then the instance's. The three General values use their stored values or
default to empty message, empty contact and `home`. Empty contact means the
built-in recovery line. After sign-in, setup or a redeemed invitation, the
browser lands on the page `landingPage` names (`/projects`, `/maps`,
`/workflows`, `/data` or `/sql`; Home, `/`, for `home` or any other value). A
signed-in visit to the setup or sign-in page redirects to Home; the invitation
page opens whether or not someone is signed in. Responses are private, no-store.

`PATCH /api/instance/settings` changes only submitted editable keys, sixty-nine
of them: the fourteen Limits numbers; the services' eight numbers
`geocodePaceMs`, `geocodeRequestTimeoutS`, `geocodeMatchCacheHours`,
`isochronePaceMs`, `isochroneRequestTimeoutS`, `isochroneCacheHours`,
`overpassTimeoutS` and `overpassCacheHours`, in their variables' units; the four
service addresses `geocoderUrl`, `isochroneUrl`, `overpassUrl` and
`s3Endpoint`; the satellite imagery's tile address `satelliteUrl`, which must
hold `{z}`, `{x}` and `{y}` and carry no user name or password (a browser cannot
load tiles from such an address, so the key belongs in the path or the query,
and the refusal says so), and its credit `satelliteAttribution`, at most 160
characters; the five basemap switches `basemaps.dark`, `basemaps.light`,
`basemaps.streets`, `basemaps.satellite` and `basemaps.singleMapStyles`, each
`true` or `false`; the template catalogue's switch `templates.catalogue`,
`true` or `false`, and its address `templatesCatalogueUrl`, an address as a
service's is (only `DEZFIL_TEMPLATES_CATALOGUE` may name a folder on the server
instead, which every read gives as `{ "set": true, "folder": true }`, never its
path); the four General values `instanceName`,
`signInMessage`, `lostPasswordContact` and `landingPage`; the eighteen
instance defaults `newMap.basemap`, `newMap.latitude`, `newMap.longitude`,
`newMap.zoom`, `newMap.legendCorner`, `newLayer.colorCycle`,
`newLayer.pointOpacity`, `newLayer.lineOpacity`, `newLayer.areaOpacity`,
`newLayer.lineWidth`, `newLayer.pointRadius`, `canvas.opens`, `canvas.minimap`,
`canvas.resultsBand`, `sqlConsole.textSize`, `sqlConsole.lineWrap`,
`imageExport.width` and `imageExport.shape`; and the twelve sign-in and
publishing settings `security.sessionDays`, `security.linkDays`,
`security.failedPerAccount`, `security.failedPerAddress`,
`security.passwordMin`, `tokens.create`, `tokens.expiry`,
`publishing.publish`, `publishing.embedding`, `publishing.embedSites`,
`connections.create` and `imports.links`. The closed `InstanceSettingsPatch`
schema names each key and its kind, bounds or choices. For example,
`{ "previewRows": 2000, "queryTimeoutS": 90 }`,
`{ "newMap.zoom": 4.5, "sqlConsole.textSize": "14", "sqlConsole.lineWrap": true }`
or `{ "publishing.embedding": "listed", "publishing.embedSites": ["https://intranet.example"] }`;
a number-like choice (text size, image width and shape, session and link
days) is text. `publishing.embedSites` is a list of at most 50 sites, each
`http` or `https` with a host and an optional port and nothing else, kept as
its origin; a failing entry is named by its position, never echoed. Browsers
match a site listed with `http` to its `https` address as well, so
`http://portal.example` also admits `https://portal.example`. A service
address is `http` or `https` text with a host, at most 2,048 characters once
trimmed, kept as given and stored encrypted with the instance's key; it reads
back as scheme and host alone, so a new key means sending the whole address
again. Before the write, an address the egress policy would refuse now is
refused with `400 invalid_request` naming its key with the policy's own
sentence: a literal in blocked space, mapped and NAT64 forms included, or a
name all of whose addresses resolve there, unless `DEZFIL_EGRESS_ALLOWLIST`
names it. A name that does not resolve at save is kept; every request to the
address is checked again. No refusal repeats an address. Null clears
a stored value, and an empty object changes nothing. A default applies to new
things only: no existing map, layer, published view or open screen changes with
it. A rule refuses new reach and takes nothing away: no session, link, token,
password, publication or connection that exists changes with it. Text is trimmed before its length is checked (80 characters for the name,
280 for the message, 120 for the contact). Empty text clears the stored value and reports
the default source. The generated tool input accepts the same whitespace
padding through a string pattern. The answer is the same configuration document as the read.

The admin and the complete body are checked inside one immediate transaction
against the committed configuration. Any refusal or failure rolls back the
entire change. Non-empty environment variables lock their settings, null
included: `409 setting_locked` takes precedence over `400 invalid_request`
when the body contains both locked and invalid keys. Known failing keys and
reasons are all named; unknown keys are identified by entry position to avoid
echoing arbitrary input. Validation covers unknown and non-editable keys, kind,
whole numbers, finite decimals (kept as given, never rounded), bounds, true or
false for a switch, text length, choices, sites, a query timeout below the run
timeout, a per-address sign-in count no lower than the per-account one, and at
least one listed site while embedding is limited to listed sites, each pair
checked on the values the change would leave. An existing environment mismatch remains visible in `warnings` and
blocks no unrelated edit. Different concurrent keys both land; the last
accepted write wins for one key. There is no stale-write refusal or Undo.

Cookie writes require the trusted same Origin; current admin bearer tokens
call directly. The assistant confirms before calling where writes are admitted;
SQL and workflow assistants refuse this operation. The response and errors
carry the read's disclosure protections. Storage and live consumers change
together only after durable commit. Limits apply to new work, with admitted
budgets, accepted waiters and public window counts retained. Increased lane
capacity wakes waiters after commit. Environment changes still need a restart.
In addition to validation and lock refusals, the operation can answer
`authentication_required` (401), `forbidden` (403), `request_body_too_large`
(413), `internal` (500) and `ingress_unavailable` (503).

Two more operations serve the services, with the same admin checks, the same
trusted-Origin rule for cookies and private, no-store answers.
`POST /api/instance/services/{service}/test` tests one service (`geocode`,
`isochrone`, `overpass`, `overture`, `s3`, `satellite` or `templates`): one fixed request at
its address in effect, never one given in the call, sent the way the service's
own requests go, through the egress check with redirects and after the gap
between requests. The satellite imagery's is one fixed low-zoom tile (zoom 3,
x 4, y 2) at its tile template within 10 seconds, passing when the answer is
an image: the tile read to its end within those seconds, at most 4 MiB, and
complete for its format (PNG, JPEG, GIF, WebP or AVIF), the time taken being
its arrival whole. A cut or larger tile is `unexpected_answer`; one still
arriving at 10 seconds is `timed_out`. The template catalogue's is its index,
read as a refresh reads it within the link import's time bound (or from the
folder `DEZFIL_TEMPLATES_CATALOGUE` names), an index this server would refuse
being `unexpected_answer`; while an admin has turned the catalogue off it is
refused with 409 `templates_catalogue_off` and sends nothing.
It answers `{ service, result: "passed", milliseconds }`, Overture
`{ service, result: "passed", releases, newest }`, the template catalogue
`{ service, result: "passed", templates, milliseconds }`, or `result: "failed"` with
one `reason`: `not_set_up`, `refused` (with the check's sentence as `message`),
`unreachable`, `timed_out`, `status` (with the `status` answered) or
`unexpected_answer`; never a body, an address or a key. It changes no setting
and reads or writes no cache, except that the Overture Test keeps the release
list it finds; a second Test of a service while one runs shares its request.
`DELETE /api/instance/caches` empties the cached answers of one service
(`?service=geocode`, `isochrone` or `overpass`) or of all three, and answers
`{ cleared }`; an answer whose request began before the Clear is not kept, and
settings, datasets, runs and the release list are unchanged. Both are
generated as tools, `test_service` and `clear_service_caches`: the embedded
assistant confirms each, and the SQL and workflow assistants refuse them.

Two more serve System, admins only and rechecked on every call, with private,
no-store answers. `POST /api/instance/parts/{part}/test` runs one small fixed
check on one part as it is configured now, never one given in the call:
`data_folder` writes and removes one empty file in the data folder within 5
seconds; `query_engine` asks the engine that runs people's SQL one fixed
spatial question within 30 seconds, interrupting it a second before them,
starting a cold engine with the extensions already installed and installing
nothing, so without the spatial extension it answers `not_found` and leaves the
engine for the next query to start; `tile_builder` asks the tile builder its
version, then builds a small archive from a few fixed points in its own scratch
folder and removes it, within 30 seconds, beside any layer build; a tile builder
still running 3 seconds before the limit is asked to stop, ended outright if it
has not 2 seconds later, and its folder removed once it is gone, all within the
30 seconds; `image_renderer` photographs a small fixed picture of
this server's own within 10 seconds, only on an image slot free now with no
image waiting, else it answers `busy` at once, and an image asked meanwhile
waits for it as behind any image; its browser is closed, or ended, within those
10 seconds, and only then is its slot free again; `metadata_database` takes the
database's write lock, reads the schema's version and gives the lock back,
writing nothing. It answers `{ part, result: "passed", milliseconds }` or
`result: "failed"` with one `reason`: `not_found`, `busy`, `timed_out` or
`failed`; never a path, a program's output or an error's words. It changes no
setting, leaves no file and sends nothing outside this server; a second Test of
a part asked while one runs, its part's work still ending included, gets that
run's answer. `GET /api/instance/storage` answers what the data folder holds by
kind (`tables`, `tile_archives`,
`service_caches`, `thumbnails`, `templates`, `metadata_database`,
`leftover_files` and `other`), each as `{ bytes, files, finished }`, with the
`total` and the volume's `disk` space, `{ free, total }` or null. `templates`
is the downloaded templates and the copies of an installed template's data the
query engine reads, which no sweep removes while a version needs them.
`leftover_files` is what the
next restart's sweeps would remove, work in progress included, the ownership
records of staged project exports among it. Each file counts once, however
many names it has; the read takes names, sizes, which files the metadata
references and which the installed templates' records name, opens no other
file, follows no link and answers no name, owner, path or file name. One walk runs at a time
and its answer is given again for 30 seconds, unless a cache is cleared: a Clear
ends a walk under way at once, the reads already joined to it getting what it
had counted, and a read after the Clear never gets a walk begun before it but
joins one fresh walk. Every read's deadline is 10 seconds from its asking: the
walk that answers it cuts every filesystem call and the disk's statistics by
then and stops its reference read at the first of its slices of 200 rows to end
past it. A walk stopped by its deadline or ended by a Clear gives each kind it
had not finished as at least what it counted, `finished: false`, and `disk` as
null when its statistics had not come. A cookie request to the Test needs the same trusted Origin; one to the
storage read must show it comes from this instance's own page, by an Origin
that is this instance's, `Sec-Fetch-Site: same-origin` or the
`X-Dezfil-Account` header its pages send, and is refused with none of them or
with another origin's Origin or a cross-site or same-site `Sec-Fetch-Site`. A
token calls directly. Both are generated
as tools, `test_part` and `read_storage`: the embedded assistant confirms each,
and the SQL and workflow assistants refuse them.

Three more keep the instance's basemap library, admins only and rechecked
inside each write, with the same trusted-Origin rule for cookies and private,
no-store answers. `POST /api/instance/basemaps` adds a MapLibre style by its
address, `{ name, url }`: the server reads the address once, now, first
through the egress check (an address in blocked space is refused with the
check's sentence before anything is sent), then with one request within 8
seconds and 2 MB, and keeps a valid style with its sources' credit, else its
host, answering 201 with `{ id, name, url, attribution, offered, addedAt }`.
It refuses, keeping nothing and repeating no part of the address, a name
outside 1 to 60 characters, an address that is not http or https with a host
or is longer than 2,048 characters, an address the library holds, a 51st
style, an answer that is not a style and a style it cannot read now; there is
no force. Nothing reads the address again. `PATCH /api/instance/basemaps/{id}`
with `{ offered }` offers or hides a style where a basemap is chosen, and
`DELETE /api/instance/basemaps/{id}` removes one, answering `{ removed: true }`;
maps that took a style keep their copy of its name, address and credit
through both. The configuration read lists the library as `basemapStyles`,
hidden styles included, and `GET /api/config` the offered ones as
`basemapStyles` (id, name, address, credit): a style's address is public to
whoever draws a map on it. A map takes an offered one with `PATCH
/api/maps/{id}` and `customBasemap: { libraryStyle }`, the style's id alone:
the map keeps its own copy of the name, address and credit, nothing is
fetched, and a hidden or unknown id is refused with `invalid_request`. While
an admin has turned `basemaps.singleMapStyles` off, a pasted `url` the library
does not offer is refused with `basemap_not_offered`, before it is read, when
a map write or an undo or redo would newly put it on a map, for admins too;
an address the map already holds is kept, and `GET /api/config` reports the
switch as `singleMapStyles`. The three library operations are generated as
tools, `add_basemap_style`,
`set_basemap_style_offered` and `remove_basemap_style`: the embedded assistant
confirms each, and the SQL and workflow assistants refuse them.

Built-in and configured basemaps, the palette catalogue, geometry projections,
the API reference, operation catalogue and offered assistant models are shared
instance resources. They require authentication but have no owner filter. Any
authenticated account can create or delete a saved custom palette, including
one created by another account. Deleting a palette keeps existing layer colors.
A map's own styles and custom basemap belong to the map and follow its reach;
admin status adds nothing. Model and geocoder credentials are server settings;
catalogue responses never return their secret values.

**Settings compatibility change.** `/api/settings` now requires authentication
and returns `401` for missing or invalid credentials. `displayName` and
`viewPrefs` belong to the caller's account; first-account setup adopts legacy
preferences. A non-admin patch containing `instanceName` returns `403`, with
all personal and instance fields unchanged. Identity-bearing responses and
refusals use `Cache-Control: private, no-store`.

Password derivations share two active slots across every credential entry point,
with six ordinary and two reserved protected waiters. Each waiter has at most
five seconds; FIFO holds within each class. Validated link redemptions and
signed-in current-password checks are protected; a password change retains that
class for the new-password derivation too. Protected work takes the next free
slot ahead of ordinary work, but at most one protected derivation is active,
even when the other slot is idle. Ordinary work may use both slots and running
work is never pre-empted. Known and unknown sign-ins use the same ordinary class;
there is no account-existence priority or guaranteed admission under continuous
load. Recovery issuance derives nothing.

Overflow or deadline answers 503 `authentication_busy`, “Authentication is busy.
Try again shortly.”, with `Retry-After: 1`, `error.retryAfter: 1` and private,
no-store. It issues no credential, consumes no link, changes no profile/password
and adds no login failure. Busy sign-ins and sign-ins cancelled before derivation
starts refund both reservations. Cancellation after derivation starts retains the
source reservation against its per-address budget (`security.failedPerAddress`,
twenty by default) until the fifteen-minute window expires, refunds the account reservation and adds no failures, preserving
the clean-source exception.
A fourth simultaneous protected caller is refused at once and may retry
immediately without a login lockout; the response retains its one-second retry
advice. Cancellation removes waiting work; running native work owns its slot
until settlement, even on failure. Password rules and work factor are unchanged.
The clean-source correct-password exception keeps its ordinary FIFO turn.
`error.retryAfter` means seconds before retry after a login limit or temporary
authentication capacity refusal. Five seconds bounds waiting, not derivation
runtime: measure the work on your image and host; slower hosts may time out.

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
or hashes. Each token carries `expiresAt`: the lifetime `tokens.expiry` gave it
at creation, or null when it never expires. A later change of that rule moves
no token's expiry. A token past its expiry answers `401 token_expired` and stays
listed until revoked. While `tokens.create` is `admins`, a member's creation
answers `403 rule_refused` with `error.rule: "tokens.create"`, and the tokens
they already have keep working. `DELETE /api/account/tokens/{id}` revokes an own token; another
account's token ID returns `404` without changing it. Missing, invalid,
revoked or deactivated credentials return `401` on every account operation.
These operations use the same private response and cookie-origin rules as
settings. The Account and API / MCP tokens cards in Settings call these APIs.

Credential maintenance starts at boot and on the first credential access at least
one hour after a completed pass. Each trigger examines at most 500 rows per kind;
unfinished passes continue on subsequent accesses without the hourly delay.
Sessions and sign-in links, including revoked or consumed records, leave only
one day past their stored expiry. Revoked tokens leave thirty days after
revocation. Recent revocations retain their Revoked label; removed tokens vanish
on refresh, and revoking their identifier returns `404 not_found`, "Token not
found.", just like any unknown identifier. Maintenance gives no live token a new
expiry; a token keeps the one it was created with.
Deletion rechecks eligibility, preserving renewed sessions and live replacements.
The inactive session backlog is bounded by the session length (thirty days by
default, ninety at most) times the sign-in rate, plus the one-day margin and
sweep lag; continued credential access drains it. There is no live-session
quota, timer service or database-file shrink promise. Sessions roll for the
instance's session length, `security.sessionDays`, thirty days by default; a
session keeps the expiry it holds and its next use renews it by the stored
length. Ordinary links last the instance's link lifetime, `security.linkDays`,
seven days by default, each keeping the lifetime it was issued with; recovery
links last fifteen minutes.

**Users.** Admins use `GET`/`POST /api/users` to list or invite accounts,
`PATCH /api/users/{id}` to change another account's admin flag or active status,
and `POST /api/users/{id}/sign-in-link` to replace a sign-in link or reset a
password. Inviting defaults to a non-admin account; `isAdmin: true` explicitly
grants administration. The invitation and reset replies disclose a copyable
`signInUrl` once, with an `expiresAt` timestamp the instance's link lifetime
later, seven days by default. The recipient
chooses a password; the instance sends no email. The link credential is carried
in the fragment and does not reach the server until redemption.

Normalized duplicate emails return `email_taken`. A deactivated duplicate also
returns `accountId` and `canReactivate: true`, so the same account can be restored.
An email awaiting deletion completion stays reserved without offering reactivation,
including after its profile has been removed. Accepted deletion refuses reactivation
with `409 deletion_in_progress`. An unaccepted invitation returns to invited status on reactivation. Self-demotion
and self-deactivation are refused even when another admin exists, and competing
changes cannot leave the instance without an active admin. Reset invalidates the
password and browser sessions while leaving tokens valid. Deactivation refuses
sessions and tokens; reactivation preserves the account without reviving ended
sessions.

**Account deletion.** Another active admin may delete an ever-active account only
following separate deactivation, including a deactivated admin. An unredeemed
invitation may be deleted directly and wholly. Self-deletion returns
`409 self_change_refused` before the active-target refusal `409 account_not_deactivated`.

`GET /api/users/{id}/deletion-preview` returns the Users identity, `invited`,
`totals` (maps, datasets, workflows, projects, connections, publishedLinks),
`people` (distinct other active accounts losing reach), and an opaque `confirmation`.
It discloses no private resource names, project references, roster or content.
If deletion is already accepted, it returns that deletion's `id` and `state`.
`DELETE /api/users/{id}` requires a JSON body with `confirm: true`, that
`confirmation`, and the exact `email` for an ever-active account. Invitations
need no typed email. The 65,536-byte limit applies. Missing confirmation is
`400 invalid_request`; changed eligible inventory or eligibility is
`409 deletion_changed`, with no effects. The admin must obtain a fresh preview.
The precondition includes identities, grants, filings and publication links;
a same-count swap or reactivate/deactivate cycle invalidates it. Unrelated
edits to surviving documents do not.

Deletion permanently erases owned work wherever filed. It dissolves owned
projects, unfiles surviving members' work, ends grants and published links,
and erases credentials and retained account work. It grants no private read.
Deactivation remains the way to keep shared work. A response is `200` with
`{id, state: "completed"}` only when cleanup has finished, or `202` with
`state: "pending"` or `"needs-retry"`. Repeating acceptance returns the same
unfinished deletion without restarting it. `GET /api/users/deletions/{id}`
reads unfinished state; `POST /api/users/deletions/{id}/finish` resumes the
same deletion, including after restart. Concurrent continuation joins the
same work. All require current admin authority and private responses.
`GET /api/users` adds `deletions`, a separate array of unfinished reservations
with `id`, `state` and `account: {id, name, email, isAdmin}`. This survives
profile erasure so Users can offer Finish deleting. Completed identities are
absent from both arrays. A completed deletion id returns `404 not_found`;
a client that previously received acceptance can refresh Users to reconcile
that absence. An arbitrary missing identifier proves no deletion.

Except for unredeemed invitations, cleanup purges all geocode, isochrone and
Overpass answer caches, so subsequent requests contact providers again.
An ever-active account retains only its opaque identity, deleted state,
permanently reserved identifying SQL name and original-adoption marker.
Completion frees its email; invitations also free their SQL name. Deleted
actors are explicit `{deleted: true}`, distinct from null/Unknown, without
name or SQL name; surviving facts, times and homes stay fixed. Other people's
derived datasets, SQL, lineage and run text remain and may contain names or
personal text. Issued private copies retain their shipped lifetime. Backups,
host snapshots/logs, providers, browser-local SQL/conversations and exports
are outside deletion; restores can revive credentials and data. Neither
anonymization nor disk-remanence erasure is promised. An outside database
reader or insufficient temporary space can leave compaction unfinished;
release the reader or restore space, then use Finish deleting.

Finishing deletion rewrites the whole metadata store and pauses all responses.
Allow free working space on both the data volume and SQLite's temporary filesystem;
the [host guide](self-hosting.md#leaving-and-deleting-accounts) gives measured pauses
and space requirements. A failed compaction remains unfinished and safe to retry.
Completion also waits for prepared files to settle or expire and cleanup to finish.
Recorded dataset inputs identify foreign card images, tiles and private prepared
copies for erasure; existing unattributed card images owned by others remain. Runs
of workflows deleted before their owner's account no longer have a workflow owner
and remain, with Deleted account as starter. Copies outside the instance, including
downloaded files and a database a connection wrote to, are not reached.

**Directory.** `GET /api/accounts/search?q=` is how a signed-in person finds
someone to share a project with, and the one deliberate exception to
account reads being an admin's. Any signed-in account may call it. It finds
other active accounts by any part of their display name (case-insensitive,
the query trimmed) or by their exact email (trimmed, case-insensitive), and
answers each as `name` and `sqlName` and nothing else: never an email, an
admin flag or an account identity. Deactivated accounts, invitations not
yet redeemed and the caller are never offered, and nobody answers twice. An
empty query answers nobody; at most 20 people answer, an exact email match
first, then by display name. Managing accounts stays with the admin-only
Users operations above.

**Tables.** The catalogue of datasets. Listings cover every dataset the
caller reaches and name each one's `owner` and its `qualifiedName`, the name
the caller would type: the plain name for their own, `<sql name>.<name>` for
another owner's, so two owners' `roads` are told apart. Another owner's
PostGIS snapshot shows its source kind and nothing about the connection
(neither the connection nor its remote schema and table), and
a derived dataset's recorded inputs resolve only within the reader's reach:
another owner's derived dataset lists, in its `sourceParams` as in the
inspection, only the inputs the reader reaches, while its SQL and parameters
read as stored.
A bare name in a path or an operation parameter is the caller's own dataset;
another owner's dataset is addressed by its qualified name (`ada.roads`) on
reads, features, downloads and operation parameters, or by its identifier in
a path. A change to another owner's dataset, by any address, answers `403`. `POST /api/tables` takes a
`multipart/form-data` upload; `POST /api/imports/url`,
`/api/imports/osm`, `/api/imports/overture`, and `/api/imports/postgis`
bring data in from elsewhere, several of them with a matching `preview` or
`count` call so the size of an import is known before it runs. While
`imports.links` is `admins`, a member's `POST /api/imports/url`, from a web
address or cloud storage, answers `403 rule_refused` with
`error.rule: "imports.links"`; a link dataset already imported keeps
refreshing. Reads are
`GET /api/tables`, `GET /api/tables/{name}` and
`GET /api/tables/{name}/features`. `GET /api/catalogue/tables` is the
schema-only listing built for agents, and is the one paginated endpoint in
the API (below); each of its rows names the owner, the `qualifiedName` and
`projectIds`, the projects it is filed in that the caller reaches, and for
the caller's own dataset every project it is filed in (never another
person's membership in a project the caller does not reach), as
`GET /api/tables` does. The assistant's
grounding reads it by `qualifiedName`, one identity per name, and on a map or
workflow page adds the page's `home` and each table's `homeName`, the name
that page's own SQL uses for it. Geometry recognition lives here too: `GET`, `PUT` and
`DELETE /api/tables/{name}/geometry` with a preview call beside them, and
`GET /api/geometry/projections` for the projection choice.

**Query.** `POST /api/query` runs one read-only SQL statement and returns
columns, an exact row count, a capped preview, and the runtime in
milliseconds. With `writtenIn` it runs where the SQL was written: a map's SQL
home, as that map's layers are read (the builder's SQL preview does this), or
a workflow's context; without it, in the caller's own console.
`POST /api/query/export` turns a result into a downloadable
file through a ticket that `GET /api/query/export` then redeems.

**Maps.** A map groups ordered, styled layers. Every map read and listing
carries `owner` (display name and SQL name) and `home` (the SQL name of the
account whose datasets the map's plain table names mean), and `projectId`:
on the caller's own map always, even a project they no longer reach, and on
anyone else's the project through which the caller reaches it; `GET /api/maps` lists the caller's
own maps and every map filed in a project they own or belong to, and
`?project=` accepts any project they reach. Create, read, update, delete,
duplicate; plus the editing history (`GET /api/maps/{id}/history`,
`POST .../undo`, `POST .../redo`), the dependency read, card thumbnails,
search within a map, widget values, and server-side image export
(`POST /api/maps/{id}/export/image`). A new map takes the instance's defaults
for its basemap, starting view and legend corner (`defaults` in
`GET /api/config`), by whichever path creates it; a duplicate keeps its
source's values, and an existing map never changes when a default does.
`POST /api/maps/look` renders a map
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
A new layer created without a style takes the instance's defaults for new
layers: the next color of the color cycle, the opacity for its geometry, the
line width and the point radius. A style given at creation is kept as given,
and a drawn sketch's layer takes only the cycle's color.
A layer's SQL is read in the map's SQL home. SQL written somewhere else (the
caller's console, a dataset's "Add to a map", another map, a workflow) says so
with `writtenIn`, and is carried into the map's home before it is stored (see
"Carrying SQL between contexts" below).
`GET /api/layers/{id}/render` is what the canvas draws, for everyone who
reaches the map; `GET /api/layers/{id}/tiles/{z}/{x}/{y}` serves a tiled
layer's archive to a reader who can reach every dataset it recorded drawing,
and answers `not_found` (404) otherwise. A reader beyond the current archive's
reach whose own render succeeds has tiles prepared in their own reach.
`GET /api/layers/{id}/fields` and `.../fields/{field}` describe columns and
their statistics, and `POST /api/layers/{id}/fill` and `.../scale` compute a
classification or a size ramp. `GET /api/layers/{id}/export/{format}`
downloads the layer's rows.

**Publish.** `POST /api/maps/{id}/publish` mints a token,
`GET /api/maps/{id}/publish` reads the current publication, and `DELETE`
revokes it. The anonymous side is `GET /api/published/{token}` plus tiles,
render, extent and widget-value calls scoped to that token, which only ever
expose the fields the publication declared
(`GET /api/maps/{id}/published-fields`). A published map evaluates in its
SQL home with its current owner's reach, restricted to the datasets its own
layers name: nothing else of the owner's space is mounted for the link, so
catalogue inspection through it can disclose no other name, and a dataset
the owner can no longer reach fails on the link rather than drawing anything
else. **Upgrade exception:** a published layer or widget whose SQL reads the
instance's catalogue (the engine's views, tables and columns functions, the
information schema, `sqlite_master`) fails on the link with
`catalogue_not_published` while its owner holds datasets the map does not
name, rather than disclosing them; the same layer still draws in the owner's
builder, and a map that names everything its owner holds keeps rendering it. The token, the published field
selection, the widget publication toggle, the theme and the reader controls
change only by the map's owner: through these operations, through map and
layer writes that carry them, and through undo and redo. For anyone else a
write or a replay that would change one is refused whole with `forbidden`,
and nothing changes. While `publishing.publish` refuses the owner (`admins`
for a member, `none` for everyone), publishing anew and any change to a
publication's theme, reader controls or published fields answer
`403 rule_refused` with `error.rule: "publishing.publish"`; a published map
stays public, follows its map's edits and can be unpublished. Under
`publishing.embedding` `listed` or `off`, the published page (`/v/{token}`)
carries `Content-Security-Policy: frame-ancestors` naming the listed sites, or
`'none'`, read afresh for each answer; under `any` it carries none, and the
anonymous API answers never do. The token is the link, so it is the owner's to read as
well: every map read and listing carries `publishToken` to the map's owner
alone and `null` to anyone else who reaches the map, beside `published` and
`publishedAt`, which everyone reads, and the publication read answers anyone
else its settings without `token`.

**Sketches.** Drawing on the map as data. A draw session becomes one
ordinary dataset plus one layer; features carry a stable id and a drawn
kind, and deleting the owning layer removes both. Anyone who may change a
map's content draws on it: the dataset is the drawer's own, filed into the
map's project where the drawer may file, and the layer names it in the
map's SQL home, under the drawer's SQL name when that home is someone
else's. Only the drawer changes its features. Removing a layer that draws
someone else's sketch leaves their dataset. Deleting a dataset never
changes another person's map or workflow: deleting one's sketch from
someone else's map leaves its layer there, and a layer or step that named a
deleted dataset fails by name for whoever opens it.

**Operations.** Spatial and data verbs. `GET /api/operations` is the
catalogue of what this instance offers, `POST /api/operations/run` starts
one, and the run is followed through `GET /api/operations/runs` and
`GET /api/operations/runs/{id}`, with a cancel call. Each run produces a
durable dataset with recorded provenance.

**Recipes.** Every workflow read and listing carries `owner`, `home` and
`projectId` as maps do. A workflow read by someone whose own space is not its
home resolves every name in that home within the reader's reach: a name out
of reach is a missing input named as written, with the sentence a resource
evaluation gives, and lineage, output links and captured layers out of reach
are left out. A reader with no output of their own is shown the owner's; when
that output exists outside the reader's reach, the step's condition is
`output_unavailable`, naming nothing, never `output_missing`, which says the
output was deleted. Workflows: a named, ordered list of steps whose dependencies
point only backwards, so the system can answer what is now out of date. The
family covers the workflow, its steps, their order, the canvas layout, and
the runs of both a single step and the whole workflow. Each person's run
makes their own outputs, so a step's view describes one run: the reader's own
latest output of it when they have one, else the workflow owner's, and its
`output` names that run's `runner` and `runId`, with the step's conditions,
inputs and last success describing the same run. An output that came with a
copy of a template (its dataset's source is `template`) was made by no run:
its step reads `lastSuccessAt` null, its `output` names no job or run, and
`templateResult` names the template (`template`, its id) and the `version`
copied; the step's first run replaces that output with its own and
`templateResult` is null from then on. Each run record names its
`runner`. A qualified reference (`ada.staged`) stays external everywhere it is
read: ordering, staleness and a workflow's duplication, which renames the
copy's own outputs where its SQL reads them and leaves a qualified dataset of
the same name as written.

The dependency reads (`GET /api/maps/{id}/dependencies`,
`GET /api/recipes/{id}/dependencies`) resolve every reference, qualified ones
included, to the datasets the caller reaches, and leave out what they do not
reach. A workflow's lists every runner's recorded output the caller reaches.
Each entry says whether the caller `owned` it and, for a dataset some
workflow's run produced, names that `producer` when the caller reaches the
workflow, with whether they own it: the datasets and workflows a filing
checklist offers are the caller's own, and the rest are listed as not theirs
to add.

**Projects.** An optional named set over maps, workflows and datasets, with
a members call and an export. `GET /api/projects` lists the caller's own
projects and the ones shared with them; each carries `owner` and the
caller's `role` (`owner`, `editor` or `viewer`), and its counts and size
cover everything filed in it. Any reached project is a valid `?project=`
value on the maps, datasets and workflows listings, and `none` means the
caller's own items filed in no project at all; one still filed in a project
its owner no longer reaches is not `none`. Renaming, the note and
dissolution stay the project owner's. Export (`POST /api/projects/{id}/export`)
is open to everyone who reaches the project, viewers included: a selection
names members filed in it that the caller reaches, whoever owns them. In the
archive every dataset has its own entry under the name its exporter types,
its `qualifiedName` (`datasets/roads.parquet` for the exporter's own,
`datasets/ada.roads.parquet` for Ada's), so two people's `roads` never
collide; the `project.json` manifest names each dataset's `qualifiedName` and
`owner` and the exporter's SQL name (`exportedBy`), and every map and
workflow document carries its SQL `home`, so the datasets its plain names
meant stay identifiable. No connection facts travel in an archive. Filing follows its own
rules, on the members call and wherever a project is named at creation (a
new map or workflow, an upload or an import): adding needs the
destination's permission, so the project's owner and its editors file their
own maps, workflows and datasets, and a project whose owner is deactivated
accepts nothing new; the owner of a resource may always withdraw it from any
project, member or not; the project's owner may remove anything filed in
their project, which never deletes it or changes its owner. A viewer's
attempt to add, or anyone's attempt to remove what someone else owns from a
project they do not own, is refused with `forbidden` and changes nothing.

A project's people are its owner and its members, each member a `viewer` or
an `editor`. `GET /api/projects/{id}/people` answers them to the project's
owner: the owner first, then the members by name, each with display name, SQL
name and role, and `deactivated` while their account is (a deactivated
member's grant is inert until reactivation). Anyone else who reaches the
project is answered the owner and themselves alone, with their own role: the
roster is the owner's to manage. `PUT
/api/projects/{id}/people/{sqlName}` with a `role` adds a person or changes
their role, and `DELETE` on the same path removes one; both are the project
owner's alone, a member's attempt answers `forbidden`, and an administrator
gains nothing. A person is named by their SQL name. Only an active account
other than the owner can hold a role: a deactivated account, an invitation
not yet redeemed and an unknown name are refused alike with
`invalid_request`. Removing someone who holds no role changes nothing, and
nothing a removed person owns is deleted, unfiled or reassigned. A change
governs the person's reach on their next request, with no sign-out.

`POST /api/projects/{id}/leave` ends only the credential holder's grant. It takes
no body and answers `{"left":true}`, never a roster. Active Viewers and Editors
may leave, including frozen projects. Absent and non-member projects both answer
`404 not_found`; owners answer `409 project_owner_cannot_leave` and can transfer
or delete instead. On the next read the project leaves lists and filters;
exclusive reach ends on the next request, exactly as after owner removal.
Other grants and ownership remain, and owned work stays filed and shared, with
its project identity still available for withdrawal. Historical attribution
keeps its name. Already admitted reads finish once; outputs recheck permission
and input reach at commit. No edit revision changes. The owner can add a departed
person again under ordinary membership rules; a repeated Leave answers 404.

Transfer is the only change of ownership, always the current owner's own
act, with the new owner named by their SQL name as `{"to": "<sql name>"}`.
`POST /api/projects/{id}/transfer` makes one of the project's active
members its owner: the recipient leaves the member list, the previous owner
becomes an editor, and the name, note, other people and contents stay as
they were, everything filed there keeping its own owner. `POST
/api/maps/{id}/transfer` and `POST /api/recipes/{id}/transfer` hand a map
or workflow to another active person who already reaches it through the
project it is filed in (that project's owner or one of its people); an
unfiled one is refused until it is filed. The resource keeps its SQL home,
so its SQL means what it meant, and everything that hangs off it: a map's
layers, history, card images and publication, which becomes the new owner's
and renders with the new owner's reach; a workflow's steps, layout and run
history, each run's outputs staying with whoever ran it. A recipient who is
deactivated, not yet redeemed, unknown or out of reach is refused with
`invalid_request`; anyone else who reaches the resource with `forbidden`;
and a refusal or a failure changes nothing. Datasets and connections have
no transfer.

**Connections.** PostGIS connections: create, test, list the remote tables,
preview a relation, snapshot it into a local dataset. Passwords are
encrypted at rest. Connections are never shared: a project grant reaches the
datasets filed in the project, never the connection behind one. Such a
connection is listed, browsed, tested and used by nobody but its owner, and
answers anyone else `not_found` exactly as a connection that does not exist;
refreshing the dataset through it is its owner's act, refused to the
project's editors with `forbidden`; no route or tool transfers a connection;
and a project archive carries no connection facts. While `connections.create`
is `admins`, a member's create, or an edit pointing a connection at another
host, port or database, answers `403 rule_refused` with
`error.rule: "connections.create"`; testing, browsing, importing, refreshing,
renaming, a new password for the same database and deleting keep working.

Create (`POST /api/connections/postgis`) and edit
(`PATCH /api/connections/postgis/{id}`) interpret a Postgres URI or libpq
key-value `url` once, then discard it. Explicit fields override only a valid
string. `sslmode=require` means SSL required; `prefer`, `disable` and `allow`
mean SSL not required and emit `prefer`, which can still negotiate TLS.
An absent or empty mode defaults to required on create and retains the saved
setting on edit. Identical repeats are accepted. Strict (`verify-ca`,
`verify-full`), unknown and conflicting repeated modes refuse before source
contact, even with explicit fields.

Both string forms now refuse the following unsupported protection requests,
including strings previously accepted with these options silently omitted:

| String parameter | Treatment of nonempty values |
| --- | --- |
| `channel_binding`, `gssencmode` | Refuse except `prefer` and `disable`, which are ignored. |
| `ssl_min_protocol_version`, `ssl_max_protocol_version` | Refuse custom TLS bounds. |
| `sslrootcert` | Refuse supplied trust, including paths with `sslmode=require` and `system`, even when encryption is opportunistic. |
| `sslcrl`, `sslcrldir` | Refuse supplied revocation policy. |
| `sslcert`, `sslkey`, `sslpassword` | Refuse supplied certificate credentials. |
| `sslcertmode` | Refuse except `allow`, which is ignored. Neither required certificate use nor suppression of certificate disclosure is supported. |
| `require_auth`, `krbsrvname`, `gsslib` | Refuse authentication restrictions and selected identity/provider. |
| `sslsni` | Ignore `1`; refuse all others, including `0`. |
| `sslcompression`, `gssdelegation` | Ignore `0` and `1`; refuse all others. |
| `sslnegotiation` | Ignore `postgres`; refuse all others, including `direct`. |
| `requiressl`, `ssl` | Ignore `requiressl=0` and `ssl=false`; refuse all others, including `requiressl=1` and `ssl=true`. The separate JSON boolean `ssl` is unchanged. |
| `scram_client_key`, `scram_server_key` | Refuse alternative authentication credentials. |
| `oauth_issuer`, `oauth_client_id`, `oauth_client_secret`, `oauth_scope` | Refuse alternative authentication credentials, trust choices and access restrictions. |
| `requirepeer` | Ignore: the peer-user check applies only to Unix sockets; connections use guarded TCP. |

Empty values, including OAuth scope, are absent. Ignored values are neither
forwarded nor stored and make no mandatory protection promise. All supplied
occurrences count, after URI decoding or key-value quoting/escaping: a later
empty or permissive value cannot hide a refused value. Names in this protection
inventory are case-insensitive in both forms; values keep their exact spelling.
Protection validation reads the complete URI query, including text after a
raw `#`, so fragment syntax cannot hide an inventory parameter. Connection
fields and `sslmode` retain their existing URL fragment interpretation;
the SSL-mode key also retains its existing case-sensitive URI matching.
The existing SSL-mode
refusal takes precedence; otherwise the first refused parameter in input
order is named, using its canonical name and never its value.

The response is HTTP **400**, code **`invalid_request`**, with this exact
sentence for `channel_binding`:

> This connection string uses the unsupported protection parameter channel_binding; Dezfil supports connection fields and SSL required or not required.

For another parameter, only the parameter name changes. MCP returns the same
code and sentence as an error in text and structured content. Refusal makes
no source attempt and changes no saved fields, encrypted credential or health
memory. The form fills nothing from a refused paste, preserves prior fields,
password and status, and keeps submission of those fields available.

Previously stored connections retain their behavior. Their original string
was discarded, leaving only endpoint, credentials and the SSL boolean, so
requested protections cannot be recovered or refused retrospectively. There
is no migration or automatic invalidation. Submitting a new string invokes
the new validation. Other parameters keep their existing treatment, including
omission of `options`, `service` and `min_protocol_version` (a wire-protocol
floor); omission outside this inventory is not a claim of harmlessness.

**Templates.** Finished maps and workflow examples with their data, shipped in
the image or listed by the template catalogue, for every signed-in account,
with private, no-store answers; an anonymous request is refused.
`GET /api/templates` lists them from what this server holds and sends
nothing: the shipped templates first, in the image's order, then the entries
of the catalogue list this process last read, in its index's order (a shipped
id wins over an entry naming it), then the downloaded templates that list does
not name. Each card carries the template's facts (`id`, `kind`, `title`,
`question`, `place`, `tags`, `dataDate`, `sources`, and for a workflow example
its `steps` in order, each with its `id`, the `operation` it runs, the `output`
it makes and the names it `reads`, so its graph draws before it is downloaded;
`steps` is null for a map template), the `version` an open or
a copy begun now takes, `origin` (`shipped` or `catalogue`), the `installed`
and `listed` versions, `present` (false when an open would download it),
`size` and whether its `picture` is `kept`, `not_kept` or `too_large`. An
entry naming the installed version is drawn as installed, whatever its
checksum. `catalogue` says where the catalogue stands: `state` (`listed`,
`empty`, `not_read`, `off`, `unreachable`, `slow` or `refused`), its `host` as
scheme and host (null for a folder, with `folder: true`, never its path),
`readAt`, and for a refusal its `reason` (`status` with the `status`,
`egress_blocked`, `service_address_unreadable`, `template_index_too_large`,
`template_index_invalid`, `template_index_repeats_id` or
`template_address_outside`). `downloads` says what the downloaded templates
hold: how many `versions` and the `bytes` their folders take. `POST /api/templates/refresh` reads the catalogue
at the address in effect: its index (at most 1 MB) and then each listed
template's two pictures in the index's order (at most 2 MB each, a picture
past it refused alone, and 64 MB for the list, later entries drawn without
one), through the egress check, redirects included, within the link import's
time bound, with no credential on any request. It reads at most once in ten
minutes, answering the kept list inside that window and joining a read under
way; the kept list is replaced only once a new read is whole, and a read that
finishes after the address or the switch changed is discarded. While an admin
has turned the catalogue off it is refused with 409 `templates_catalogue_off`
and sends nothing; a saved address the instance's key no longer opens is
refused with `service_address_unreadable`. Cookie requests need the same
trusted Origin. `GET /api/templates/{id}` answers one card with `howMade`, an
unknown id 404 `template_not_listed`. `GET /api/templates/{id}/picture?theme=`
answers the card's map picture as PNG (light when no theme is named), from
disk for a shipped or downloaded version, else as the kept list holds it;
it is a card image, outside the tool set. `POST /api/templates/{id}/fetch`
downloads one version so it opens and copies with no further request: the
`version` its optional JSON body names (at most 64 KB), else the one its card
takes now. An installed version (shipped, or downloaded before) answers at
once and sends nothing; a shipped template has its shipped version alone.
Any other must be the version the catalogue list this process last read
names. Its archive is read from its address through the egress check,
redirects included, with no credential on any hop, within the link import's
time bound (or from the catalogue's folder), its size and SHA-256 checked
against the index as it lands; then it is unpacked and admitted as a client's
documents are, every dataset and bundled result read through the upload's
reader (what it measured is recorded), every layer's SQL, columns, widgets
and timeline and every step bound to the template's own data and the results
of earlier steps, nothing else, a workflow example's step list in its facts
the workflow's own, what each step reads included; and only then moved into place under the data
folder's `templates/<id>/<version>/`. Two calls for one version download it
once, and downloads run one at a time on this instance; a download waiting
its turn when an admin turns the catalogue off or moves it sends nothing. A
version installed before stays as it is, so a newer listed version installs
beside it and the older one stays in use when the newer is refused. It
answers `{ id, version, size, downloaded }`, `downloaded` false when the
version was installed already. Refused, coded, leaving nothing installed:
404 `template_not_listed` for a version neither installed nor listed, 409
`templates_catalogue_off` while the catalogue is off, 400
`service_address_unreadable`, 413 `template_archive_too_large` (past the size
the index declares or 150 MB), `template_unpacked_too_large` or
`template_picture_too_large`, 422 `template_checksum_mismatch` and the
template reader's other codes (`template_reference_outside` for a layer or
step naming a dataset that is not the template's, a person's or another
template's), 403 `egress_blocked`, 502 `remote_fetch_failed` and 504
`remote_timeout`. `POST /api/templates/{id}/copy` makes a copy of one
installed version into a new project of the caller's, all of it or nothing:
the `version` its optional JSON body names (at most 64 KB, with an optional
`name`), else the installed one. The copy is local and sends nothing: an
installed version is copied whether the catalogue still lists it or not, and
with the catalogue off; a listed version that is not installed is refused
with 409 `template_not_installed`, so it is fetched first. The project is
named as the body says (trimmed, 1 to 120 characters), else after the
template's title, and its note carries a line naming the template, its
version and the day. Filed in it under fresh identities: the template's map,
every layer, widget, the legend order, camera, basemap and timeline as
stored, each widget, the legend order and the timeline bound to the copied
layers, its SQL home the caller's; a workflow example's workflow, each step
the caller's own, reading the datasets and earlier outputs as landed and
declaring its output as landed, each bundled result recorded as the caller's
output of its step by no job and no run (read with `templateResult` and no
last success until the step's first run), its canvas layout with every
position under the copy's step or the dataset as landed and every note; and
every dataset and bundled result of the template, the caller's, under its
name in the template or the next free name by the suffix rule
(`stations_2`), reserved against the caller's datasets, every output name
their workflows declare and every word the template's own SQL uses (a name
its query defines for itself, such as a `WITH` name, is never one a dataset
lands under), each layer's and step's SQL rewritten to name the dataset as
landed; a renamed dataset that the SQL names with no alias keeps its old
name as one (`FROM stations_2 AS stations`), so a column the SQL qualifies
by that name still finds it. The rewrite is checked under exactly the names
the copy lands, before its one metadata transaction, and the transaction
takes the names again, the project first: when a write committed meanwhile
moved them, it writes nothing and the copy checks the new names and runs
again, so two copies at once each land whole under distinct names; a
failure anywhere before the commit leaves no project, map or
dataset of the caller's and no file, and a download stays installed. A
copied dataset's `source` is `template`, with the template's `id` and
`version` in its `sourceParams`; it is never refreshed. The map's card images
are the template's pictures, saved after the copy with evidence naming the
copied datasets; when they cannot be saved the copy stands and its card
shows the placeholder until the map's first capture. It answers 201
`{ project, members }`, the project as `GET /api/projects/{id}` reads it with
its members, and `Location` naming the project. Refused, coded, with nothing
created: 404 `template_not_listed`, 409 `template_not_installed`, 409
`templates_catalogue_off` for a version not installed while the catalogue is
off, 422 `template_reference_unbound` for a layer or step naming a dataset
the copy does not make, 422 `template_record_mismatch` and the reader's other codes
for an installed version that changed on disk, 400 `invalid_request` and 413
`request_body_too_large`. `DELETE /api/templates/downloads`, admins only and
rechecked on every call, with the same trusted-Origin rule for cookies,
removes every version downloaded when it began and the copies of their data
the query engine reads that no installed version needs any more; shipped
templates and every copy anyone made are untouched. Each version is retired
as a dataset's file is: no open, copy or render begun after the call finds
it, the readers already under way finish first, and only then are its files
removed; a download that lands meanwhile stays, and a removed template
downloads again at its next open or copy while the catalogue lists it. It
sends nothing outside this server and answers `{ versions, bytes }`, what
went. List, read one, refresh, fetch, copy and remove are generated as
tools, `list_templates`, `get_template`, `refresh_templates`,
`fetch_template`, `copy_template` and `remove_template_downloads`; the SQL
and workflow assistants are offered the first two and refuse the refresh,
which reaches outside this server, and the fetch, the copy and the removal,
which write. The embedded assistant asks before removing, its words naming
the size the downloads take, and before a fetch and before a copy, its words
naming the version and its size;
a call naming no version is completed with the version those words name
before it waits (for a copy, the installed one; with none installed it is
refused with `template_not_installed` and not asked), so approving it later
acts on that version even if the catalogue lists a newer one by then.

**Agents.** The assistant and the MCP endpoint. `POST /api/assistant/runs`
reserves a run, `POST /api/assistant/messages` sends a message under that
run id, and `GET /api/assistant/runs/{id}` re-reads it after a lost
response. `GET /api/assistant/pending` recovers open confirmations, and
`GET /api/assistant/policy` answers what a run on a given page admits.
`POST /api/mcp` is the MCP endpoint; see the MCP page.

## How errors are shaped

API failures use this envelope, except bodyless HEAD, abandoned requests and
unmatched framework 404 responses:

```json
{ "error": { "code": "query_timeout", "message": "..." } }
```

A request naming something the account cannot reach answers `not_found`,
exactly as if it did not exist. A change to something the account can reach
but may not make answers `403` with the code `forbidden` and one fixed
sentence, and changes nothing.

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
(`src/lib/api/error-catalogue.ts`). There are **134** codes. Clients should
branch on codes, never on prose.

One status is unusual: a client that abandons an in-flight evaluation gets
`499` with no body, the de-facto convention for a client-closed request.

## Bounds, limits and pagination

There is no general pagination. Listings return their whole set, which is
sized for a single instance, and the bounds that matter are on the work
rather than on the page:

- `GET /api/catalogue/tables` is the exception. It pages with `limit`
  (1 to 32, default 32) and an exclusive `after` cursor over qualified
  names, unique within one caller's reach,
  and pages columns separately with `columns` (0 to 64, default 64) and
  `columnOffset`. It exists so an agent can walk a large catalogue without
  pulling everything.
- `GET /api/operations/runs` takes a `limit` and answers newest first.
- Query results carry a capped preview and a flag saying whether it was
  truncated, plus the exact total row count, so a caller always knows what
  it is not seeing.
- SQL console and preview answers (`POST /api/query`) have fixed byte limits:
  **33,554,432 bytes (32 MiB)** for the complete uncompressed UTF-8 JSON answer
  and **2,097,152 bytes (2 MiB)** for one non-geometry column value, including
  nested values, quotes and escaping. Equality is admitted. Schema, repeated
  column names, runtime and the envelope count toward the result. Native
  GEOMETRY columns (including CRS-qualified types) count toward the result
  ceiling only, whether emitted as WKT or parsed GeoJSON. Explicit WKT/GeoJSON
  text and geometry-looking text/JSON remain non-geometry. Exceeding either
  bound refuses the whole answer with HTTP 422 `query_result_too_large`,
  the catalogue sentence below and no partial rows or details. These limits
  have no setting; row limits, engine budgets and complete file exports are unchanged.
- PostGIS five-row preview (`POST /api/connections/postgis/{id}/preview`)
  uses the same fixed ceilings on returned columns and rows. Internal health
  is excluded. Source geometry/geography columns, identified by source type
  and emitted as WKT, count only toward the result ceiling. Text and JSON
  coordinates retain the cell ceiling. Excess returns the same whole-answer
  422 catalogue refusal. Health, cancellation and source timeouts stay unchanged.
- Geometry-choice preview (`POST /api/tables/{name}/geometry/preview`) shares
  those fixed ceilings. Metadata, grid rows and map features count together.
  Count the existing 512-character excerpts; source text and nested JSON remain
  non-geometry. Native WKT excerpts and evaluated native map geometries count
  only toward the result ceiling. Simplification and its original-geometry
  fallback stay unchanged. Excess refuses the whole preview with the same 422
  catalogue error, with no partial sample.
- Dataset inspection (`GET /api/tables/{name}`) uses the same fixed 32 MiB
  complete-answer and 2 MiB non-geometry-cell ceilings for its fifty-row
  preview. Its registered native geometry column is emitted as WKT and counts
  toward the result ceiling only. All metadata, schema, ownership, project
  memberships and resolved inputs count in the same answer. An oversized
  inspection returns the same 422 catalogue refusal with no partial data.
  A refused dataset inspection prevents its detail and docked set-geometry
  panel from opening. It also blocks tool column pickers, SQL schema inventory
  and completion, workflow dataset reads and facts, and automatic layer addition
  after a tool run. The tool run can report failure even though the dataset has
  already been written. Existing layer rendering, dataset map features, complete
  API file exports and owner deletion from Data use separate reads and remain
  available.
- Timeouts, memory budgets, configured size caps, area budgets, render caps, queue
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

SQL referring to a table outside the caller's reach returns the same
`sql_error` for a hidden or nonexistent table. It includes no name suggestions.
In the console (`/api/query`, its export, and every agent tool that runs SQL)
that is the generic `The query refers to an unknown table.` A resource's own
evaluation (a layer's render, fields, statistics, extent, classification,
widget values, export, tile build, and a workflow step) names the reference
instead, exactly as written, when it binds nothing the caller can reach: `The
dataset "<reference>" is not available to you.` It says nothing about whether
the dataset exists or whose it is, and it is the same message whether the
dataset is hidden or missing. It applies to a qualified name outside reach, to
a workflow's declared output the runner has not produced, and to any plain
name when the caller is not the SQL home; the home's own unknown plain name
keeps the generic message, as before. A run that saves a result as a dataset
names a qualified reference outside reach the same way. A published link shows
the documented sentence for `sql_error` either way. Engine failures omit internal statements,
artifact paths and native-library internals. Input diagnostics and a source
position remain when available.

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
and temporary views for exactly the datasets its caller can reach
(`src/lib/query/views.ts`), each dataset once. An evaluation has a SQL home:
the caller for SQL run directly, the stored home of a map or workflow (the
account that created it) for that map's layers, widgets, search, exports and
tiles and for that workflow's steps. The home's datasets that the caller can
reach are mounted under their plain names; every other owner's reachable
dataset is mounted under one name, `<SQL name>.<dataset>`. A workflow step
also binds the workflow's declared outputs under their plain names, ahead of
the home's datasets: each binds the dataset the same runner's latest
successful run of that step produced, and an output that runner has not
produced has no view at all, so its name never falls back to a home dataset.
One hardened engine serves all accounts under the same shared memory budget.
The views disappear when the connection closes. Artifact projection metadata
may be cached by owner, dataset identity, artifact and geometry metadata; the
views and binding evidence are recreated on each connection.

Unqualified names, `main.table`, `memory.table`, `memory.main.table`, and
computed `query_table()` / nested `query()` references resolve inside that local
catalogue. So does `<SQL name>.<dataset>`, wherever a table can be named: in a
table reference (where the table goes by its dataset name, as a
schema-qualified one would, unless another table of the same `FROM` goes by
that name: then it goes by `ada.roads`, so `roads JOIN ada.roads` joins two
tables), a qualified column (`ada.roads.x`), a qualified
star exclusion, a computed or listed `query_table()` argument, a table macro
such as `histogram_values()`, and nested or serialized SQL. It names that
person's dataset, external even when a workflow's declared output shares the
name; the caller's own SQL name names the caller's own. A first part that is an
alias or a common table expression in scope keeps its SQL meaning. The single
quoted name a mounted dataset carries in the catalogue (`"ada.roads"`) is
accepted as the binding it is, and means `ada.roads` in every local spelling
(`main."ada.roads"`, `memory.main."ada.roads"`): it binds that person's dataset
by identity, for an editor's save as for an evaluation's record of what it
drew; any other identifier containing a dot is still refused. The compiler preserves stored SQL. Publication evaluations use the
map's SQL home and the publication owner's reach restricted to the datasets
the map's layers name, including inactive owners and
pending adoption. Refresh, deletion and name reuse affect later evaluations; an admitted
materialization keeps its captured identities and artifacts until it completes.

### Carrying SQL between contexts

The same text can mean different datasets in two contexts: `roads` in Bob's
console is Bob's dataset, in a map of Ada's it is Ada's. So text that moves
from where it was written into another context is carried rather than
copied. Every operation that stores text written elsewhere takes
`writtenIn`, one of `{"kind": "console"}`, `{"kind": "map", "id": …}` or
`{"kind": "workflow", "id": …}` (a map or workflow the caller does not reach
answers as a missing one), and each dataset reference is resolved where the
text was written and written again for where it goes:

- a plain name of a dataset the destination's home owns stays plain, unless
  an output of the destination workflow takes that name; any other dataset
  becomes `<SQL name>.<dataset>`;
- an already qualified name, and the engine's own catalogues and schemas,
  stay as written;
- a plain name of one of the source workflow's own outputs becomes the
  dataset the caller's latest successful run of that output made.

A table that becomes qualified keeps the name its columns go by: where it
would otherwise go by another (a relation of the same FROM clause shares its
name, or the dataset an output stands for is named differently), it is
aliased as written, so Bob's `FROM roads, ada.roads` carried into Ada's map
becomes `FROM bob.roads AS roads, ada.roads` and `roads.x` still reads his.
Only those references change; the rest of the text, comments and layout
included, is stored as written, and nothing where the text came from is
touched. A reference that cannot be carried refuses the request with
`sql_error` naming it, and nothing is written: a dataset outside the caller's
reach (`The dataset "<reference>" is not available to you.`), a workflow
output the caller has not produced, or a computed table name that would have
to change. Text whose context does not change is stored byte for byte.
Layer creation (`POST /api/maps/{id}/layers`) carries this way; the console's
"Add to a map", a dataset's "Add to a map" (which names the dataset by its
`qualifiedName`) and the builder's table picks and imports all say they were
written in the console. So do adding and editing a workflow step
(`POST /api/recipes/{id}/steps`, `PATCH .../steps/{stepId}`): a node pasted
from another workflow says which one, and the step's own output name already
counts as taken in the destination. Capturing a layer into a step
(`fromLayerId`) works from any layer the caller reaches and carries its
filtered SQL from the map's home. A standalone operation
(`POST /api/operations/run`, a dry run included) carries parameters written
in a map or workflow into the caller's own console, so a result previewed in a
map's home and saved as a dataset is the rows the preview showed, owned by the
caller. `POST /api/query` takes the same `writtenIn` to evaluate where the
text was written instead of carrying it.

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

## Access rules in detail

The boundary each family holds, beneath the model described under
[Ownership and sharing](#ownership-and-sharing), with the error-contract
changes that came with accounts.

**Layers.** Layer routes require an active account and resolve each layer
through its map, so a layer follows its map's reach; administrators gain
nothing. Hidden and missing layers both answer `not_found` (404), including
fields, statistics, rendering, tiles and direct exports. New widget, timeline,
legend-order and layer-order references must belong to the exact map being
edited. A missing or mismatched reference now answers `not_found` (404),
replacing the former `invalid_request` (400), a breaking change. Malformed
input still answers `invalid_request`. An unchanged orphan widget already
stored in history remains readable and can be echoed unchanged.

**Document revisions and attribution.** Reached map and workflow reads,
their child definitions, list/project entries, history, layout, publication
settings and filing dependency reads carry `editRevision`, `lastChangedAt`
and `lastChangedBy`. Producer workflows in dependency lists carry their own
facts. `lastChangedBy` is `{ name, sqlName }`, `{ deleted: true }` for a deleted
actor, or explicit null for unknown authorship, including legacy records. This
additional actor variant is a contract change: clients must handle all three.
The deleted variant carries neither name nor any profile fields. Actor labels
change on read without changing revisions, authorship or times. Fixed SQL homes
remain separately readable and are never an actor label. Departure and deactivation do not
erase a recorded actor. Anonymous published views carry none of these facts.
Workflow steps and their revision are captured together before presentation;
separately read definition and layout belong together only when revisions match.
Camera, thumbnails, dataset contents and run bookkeeping do not advance these
facts. Covered writes require the paired revision as described below.

Covered JSON successes return the resulting `editRevision`, including map,
layer, sketch attachment, publication, history, workflow definition, step,
layout, direct filing and map/workflow transfer responses. Workflow envelopes
carry it at the top level as well as on the enclosed definition or layout.
Project creation with members, membership changes and dissolution return
`revisions: [{ kind, id, editRevision }]` for each affected surviving map or
workflow the caller still reaches, including withdrawn filings. Project
member workflows are an array of ordinary workflow entries.

This is a breaking change to the success contract for layer deletion, sketch deletion and
unpublication from `204` to `200` with JSON. Sketch deletion returns
`{ mapId, layerId, editRevision? }`; when it changes no map, both IDs are null
and no revision is returned. Complete-document deletion has no resulting
revision; a transfer ending the caller's reach also omits it. Administrative
publication revocation retains its narrow bodyless
response without disclosing map facts, and cancellation keeps its documented
conditional bodyless response. Generated tool schemas describe these JSON
results; the executor, MCP structured/text output and assistant context retain
their revisions.

**Shared history attribution.** `GET /api/maps/{id}/history` returns
`canUndo`, `canRedo`, `undoTarget` and `redoTarget`. Each target is null or
contains `steps`, `eligible` and `reason`. Steps name their original author
as `{ name, sqlName }`, `{ deleted: true }` for a deleted actor, or null for
unknown historical authors. Workflow run `runner` uses the same three variants. A target
covers one contiguous group by one actor; coalescing never combines actors.
Eligibility applies to the whole group under the caller's current edit,
SQL admission and publication permissions. Undo and redo record the acting
account as last changer while preserving each step's original author.

**History and card images.** History follows the map: everyone who reaches it
reads its availability, and undo and redo are content changes, open to whoever
may change the map's content. Undo and redo validate the whole recorded
gesture, including layer targets and saved map references, before changing
records or deleting artifacts. A foreign or mismatched replay reference returns
`not_found` and leaves the cursor and all records unchanged. Restoring a
deleted layer preserves its recorded identity and parent; it cannot replace a
live layer belonging to another map. Card image writes are the map owner's, and
staged writes recheck access before publishing; reads and copies follow the
rule for retained artifacts below.

**Datasets.** Dataset names belong to their owner. Different accounts can each
import `roads`; uploads and sketches choose suffixes using only the creator's
names. Dataset lists, catalogue totals and schema pages, inspection, features
and exports cover the datasets the caller reaches; sketch edits, geometry
changes and refresh are the owner's. Administrator status grants no access to
another account's data. A project named at creation (an upload, an import, a
new map or workflow) must be one the account owns or edits, whose owner is
active, and is checked before source or artifact work. Refresh and geometry
changes keep the durable identity and owner, rechecking account activity before
committing. Hidden and missing names and references return the same `404
not_found` response. This replaces the previous `map_not_found` response for a
missing sketch parent.

**Connections.** Saved PostGIS connections are private to their creator,
administrators included, and a project grant never reaches one. The list,
edits, tests, source catalogue, previews and snapshot lists use the caller's
own connections. Names are unique within the account. Hidden and missing
connection IDs both return `404 not_found` with the same generic message before
credentials, source access or health writes. Stored import and refresh
references obey the same rule; an imported dataset, shared or not, grants no
access to its source connection. Private source work rechecks access before
committing or recording health. This is a breaking error-contract change for a
snapshot whose saved connection is missing: refresh now returns `404 not_found`
instead of `409 not_refreshable`. Connection absence messages no longer echo
the submitted ID.

**Workflows.** Workflow definitions, steps and layouts follow the workflow's
reach and are read in its SQL home within the reader's reach; a step can
capture any layer the caller reaches. Hidden or missing workflow, step,
captured-layer and project references use the same generic `404 not_found`,
including mixed parent/child requests. Refused compound changes leave
definitions and filing unchanged.
A step's declared output name is taken (`name_taken`) when a dataset of that
name is in the workflow's SQL home, where its steps read plain names, or in
the declaring person's own space, where their run lands the output. A
person other than the home's account whose name only the home holds is told
"That name is not available in this workflow." without the dataset being
named, since the home's datasets need not be theirs to see.
Duplication names the copy's outputs against the duplicator's own datasets and
workflows and the datasets of the SQL home the copy keeps, so every name it
allocates passes the same declaration rule. Same-workflow conflicts and the frozen name of an existing output
retain their previous rules. Deleting a workflow leaves its datasets.

**Filing.** A compound filing change is checked part by part by the filing
rules, and any refused part rolls the whole change back: a hidden or missing
member returns the generic `404 not_found`, a reached one the caller may not
file or remove returns `forbidden`. Initial filing follows the same rules. A
removal of what is not filed in the project changes nothing. An owner who no
longer reaches a project may still withdraw their own resources from it, and is
answered with an empty composite. Deleting a project unfiles its contents
without deleting or transferring them. Export selections are checked before
archive assembly and account activity is checked again before returning the
completed file. A hidden or missing selected export member now returns `404
not_found` rather than `400 invalid_request`; this is a breaking error-contract
change. An owned resource outside the project still returns `400
invalid_request`.

**Dependencies and lineage.** The dependency reads resolve dataset identities
in the map's or workflow's SQL home within the caller's reach; memberships name
only projects the caller reaches, and producers only workflows the caller
reaches, each marked with whether the caller owns it. Workflow lineage retains
the original input identity and bound artifact after deletion; a new dataset
with the same name does not replace that history.

**Retained artifacts record what they drew.** A tile archive records the
dataset identities its build's evaluation bound, each with the artifact it was
read from; a published view held for its freshness bound records every
evaluation its assembly ran; a card image records the identities its map's SQL
binds in the map's home within the uploader's reach. The builder sends a card
image with the map's SQL revision as it stood when the capture started
(`revision` on `PUT /api/maps/{id}/thumbnail`); an image sent without one, or
whose map's layers moved from that revision before it arrived, is kept
unattributed, each image of a themed pair on its own. An evaluation that reads
the engine's catalogue (its catalogue functions, the information schema, a
listing of relations) records the whole reach it evaluated in. Tile
fingerprints fold in the recorded identities with their current artifacts, so
a refresh, deletion or replacement of a dataset a layer drew makes its tiles
stale and a same-named dataset of another account never does; a dataset's
refresh or deletion invalidates or reclaims the tiles of every layer that drew
it, whoever's map it is on. Tiles and card images made before artifacts
recorded their inputs carry no evidence and are unattributed: served to the
map's owner only until rebuilt or recaptured. Such a tile archive is
invalidated or reclaimed by the refresh or deletion of its map owner's dataset
whose name its layer's SQL contains as a whole word, as tiles were before.

Serving or copying a retained artifact authorizes what it recorded against the
caller's reach at that moment, never when it was made. A tile archive is
served to a reader who can reach every dataset it drew; a tile request
otherwise answers `not_found`, as does one for an archive whose evidence names
another build (one being swapped in). A card image is served to a reader who
reaches the map and every dataset it drew; any other image is passed over like
a missing one, so the reader gets the card's placeholder `404`. An image is
copied into a duplicate only when the duplicator may be served it, a themed
pair only whole. A published link is served an archive, and a held view of
itself, only while the map's owner can still reach what it drew, and an
archive or view that read the catalogue only within what the map names.
Unattributed artifacts are the map's current owner's alone, so a transfer
hands them to the new owner, and the new owner's reach governs everything
else. Removing a dataset from a project, replacing a layer's SQL or
transferring the map changes what is served at the next request.

**Operation jobs.** Standalone operation jobs keep their initiating owner
independently of any output. Their parameters, errors, results, subject
histories and cancellation are private to that account, including after output
deletion. Identical subject names and history limits are separate per account;
output-name conflicts are checked in that account's space. Workers check
current account activity before preparation and at publication. An unfinished
job whose owner becomes inactive fails with `authentication_required` and keeps
no new dataset or staging artifact. Restart reconciliation settles interrupted
jobs without re-executing them, and prunes each recorded owner's history
independently. The jobs a workflow run contains follow the workflow instead:
cancelling the run, by its initiator or by the workflow's owner, stops each of
them.

**Workflow runs.** Workflow plans, run histories, member attempts and retained
outputs follow the workflow: everyone who reaches it reads them, with output
links out of the reader's reach left out. Every supplied step or run must
belong to the addressed workflow. Hidden, missing and mixed-parent references
return the same `404 not_found`, before planning or admission. A changed
confirmation containing only the workflow's current members still returns `409
plan_changed`. At each output's commit the runner's permission and reach to
every input are asked again: an input another person owns that the runner no
longer reaches refuses that output with `sql_error` naming it as written, even
though the step already read it; a runner who may no longer run the workflow
(no longer its editor, or no longer reaching it after it was unfiled, moved,
dissolved out of its project or transferred) completes the steps already
admitted privately, into their own datasets, unfiled, without changing the
workflow's recorded outputs, proposals or definitions, and no further step is
admitted. A workflow moved or transferred while running files each output into
its project as it stands at commit.

Workflow execution rechecks activity after planning, at worker entry and before
publication. Deactivation drains admitted work, prevents further admission and
publication, and preserves outputs already committed. The workflow keeps terminal
attempts even when job history prunes them or a step or output is deleted. Startup
reconciliation marks unfinished runs interrupted, including inactive owners' runs,
and never re-executes them or attaches another owner's job attempt.

**Renders and tiles.** Private layer renders, tile status and tile bytes follow
the map's reach and the archives' recorded inputs, administrators included.
Builds are kept apart by the reach that asked for them: a refused or failed
build is that reach's alone, reported as failed to it for the same query until
the query or the data under it changes, and never replaces the archive or the
status anyone else is served; only a build that commits replaces the layer's
archive. Builds retain their initiating account authority across the queue,
export and atomic archive swap. Deactivation before publication prevents a new
authoritative archive, and an in-flight private read rechecks activity before
returning bytes. Deleting an owned layer fences its outstanding build;
reactivation permits a fresh build. Visible published layers use their current
publication token independently of owner activity. Revocation prevents that
token's outstanding build from publishing an archive.

**Assistant runs.** Assistant receipts and parked confirmations are private to
their initiating account, including for administrators. Ownership survives
failure and deletion of an output. Deactivation interrupts unfinished
execution, discards late provider content and prevents further tool admission;
committed work remains. Reactivation restores access to the same receipts. A
hidden confirmation cannot be resolved or consumed. Superseding an unknown or
hidden confirmation is a harmless no-op for that confirmation.

**Retained results.** Retained map checks and prepared layer, query and project
downloads also bind to the initiating account independently of their source.
Only that account can retrieve, observe or release them, including after source
deletion. Copied ids receive the same refusal as unknown ids without consuming
the owner's result. Render and export execution rechecks activity before
returning or retaining bytes; a deactivated caller cannot redeem a retained
result. Existing eviction, expiry, stream cleanup and process-restart behavior
remains unchanged.

**Publications.** `DELETE /api/publications/{token}` lets a current admin
revoke a known link only while its owner is deactivated. The authority and
owner-status checks share the revocation transaction. An active owner's link,
an unknown token, and an already revoked token receive the same `not_found`;
success is `204` with no content. The operation provides no map discovery or
private read access. Its generated tool is `revoke_inactive_publication`, with
destructive consequence metadata and confirmation using only the submitted
token.

Anonymous publication queries evaluate with the map owner's current reach,
restricted to the datasets the map names, never a signed-in visitor's.
Deactivation does not revoke existing links. Before first-account setup, legacy
links carry a publication-only pending-adoption scope; setup atomically
replaces it with the original account's scope. Token revocation is rechecked
after asynchronous widget, render and extent work, and retires cached or
in-flight assembled views.

### Map edit preconditions

Breaking change for unversioned clients: `PATCH /api/maps/{id}` requires
`X-Edit-Revision` for every content field, including widgets, layer order,
publication settings and unchanged values. A viewport-only PATCH needs none;
a mixed viewport/content PATCH is atomic under the content revision. Map
DELETE also requires the revision from the displayed or read map. Creation
and copying to a new map need no destination revision. There remains one map
PATCH operation. Its MCP `expected_revision` argument is conditionally required;
`delete_map` requires it unconditionally.

Read the map first, retain its `editRevision`, and send that exact value in
`X-Edit-Revision` (MCP: `expected_revision`). Each accepted JSON result supplies
the next revision. Deletion returns 204 with no surviving revision. Missing or
malformed values return `400 invalid_request`: “Read this item first, then send
its editRevision in X-Edit-Revision.” A stale value returns `409 stale_revision`:
“This item has changed. Reload it before trying again.” Permission checks come
first. Refusal changes no content, history, actor, publication or artifacts,
including when validation races another edit. Reload explicitly before making
a new edit; never attach a refreshed token to a refused payload.

### Layer edit preconditions

Layer creation, PATCH, in-map duplication and DELETE require the parent map's
`X-Edit-Revision`. The generated `create_layer`, `update_layer`, `duplicate_layer`
and `delete_layer` tools require `expected_revision`. Read the map or layer and
retain that paired revision, then chain each accepted result. These operations
return JSON with the resulting map `editRevision`; unchanged values still
require the current revision and advance neither revision nor attribution.
Missing or malformed bases return `400 invalid_request`; stale bases return
`409 stale_revision` with the sentence above. A save racing SQL validation or
style derivation is refused whole and is never re-derived on the newer state.
Layer deletion includes an owned sketch's dataset and artifacts: a refused
deletion leaves them intact. Dataset deletion itself remains outside the edit
precondition contract, including its existing map-changing cascades.

### Sketch attachment preconditions

Starting a sketch (`POST /api/maps/{id}/sketches`, `create_sketch`) requires
that map's current revision. Removing its layer uses the same precondition
as other layer deletions. This is a breaking change for callers that omitted
`X-Edit-Revision` (or MCP `expected_revision`). Missing or malformed values
answer `400 invalid_request`; stale values answer `409 stale_revision` with
“This item has changed. Reload it before trying again.”

Attachment checks the revision before artifact creation and again in the
registry transaction. A refused attachment removes its staged file and
registers no dataset or layer. A refused layer removal changes neither the
sketch dataset nor its artifacts, map content, history or publication.
Feature edits and dataset-side sketch deletion remain dataset operations
without a revision precondition; a deletion that changes a map definition
advances that map's revision.

### Shared undo and redo preconditions

`POST /api/maps/{id}/undo` and `/redo` (`undo_change`, `redo_change`) require
`X-Edit-Revision` (MCP `expected_revision`) from the map or history state the
caller saw. This is a breaking change for callers that omitted it. Missing
or malformed revisions answer `400 invalid_request`; stale ones answer
`409 stale_revision`: “This item has changed. Reload it before trying again.”
The check is repeated after SQL admission, before changing any row or cursor.
A current request with no eligible timeline position still answers
`409 invalid_request` with “Nothing to undo.” or “Nothing to redo.”

Undo targets the latest applied step or contiguous group, whoever authored
it; redo targets the next undone one. Groups and coalescing never cross actor
boundaries. There is no selective personal undo and no skipping an ineligible
group. Publication restrictions, SQL admission and reference checks refuse
the whole group, without changing content, history, attribution or artifacts.
Accepted replay returns a fresh revision and attributes the action to the
replayer while keeping the original step authors. Restoring identical values
or a deleted layer never revives an old token. A new edit discards redo.


Publication writes require the read map's `X-Edit-Revision` (MCP
`expected_revision`): creating the link, changing its theme or controls, and
revoking it all compare the same document token. Missing or malformed values
answer `400 invalid_request`; stale values answer `409 stale_revision` with
“This item has changed. Reload it before trying again.” Refusal changes no
publication, history or attribution. Chain the resulting JSON `editRevision`
into the next write. A current no-op retains the revision. This is a breaking
change for unversioned publication clients. The separate admin operation
`DELETE /api/publications/{token}` still needs no revision: it can revoke only
a deactivated owner's known token, advances the map revision and returns no
private document facts.


Workflow definition and layout writes require `X-Edit-Revision` (MCP
`expected_revision`): rename/delete, add/edit/remove/move a step, discard a
proposal and replace the layout. Read the workflow, step or layout and retain
its paired token. All share one revision, including notes and positions; chain
each accepted JSON result. Missing or malformed revisions return
`400 invalid_request`; stale revisions return `409 stale_revision` with
“This item has changed. Reload it before trying again.” Validation races are
refused without changing definition, layout, attribution or outputs. A current
no-op keeps its revision. Creation and duplication into a new workflow need no
destination revision. This breaks unversioned workflow editing clients.

Direct map and workflow filing and transfer require the revision paired with
that document's read. Transfers send `X-Edit-Revision` (`expected_revision` in
MCP). Compound filing, including initial members when creating a project, puts
`expectedRevisions` inside the member-change object. Its keys are `map:<id>` and
`workflow:<id>`, with the respective `editRevision` values. Every map and workflow
named in an add or removal needs a basis, including unchanged memberships;
datasets need none. Missing or malformed bases answer `400 invalid_request`;
one stale basis answers `409 stale_revision` and rolls back the entire change,
including project creation and dataset membership. The result's `revisions`
contains each still-reachable document's resulting token. These are breaking
request-contract changes. Project dissolution and project transfer remain
exempt, and dissolution still advances each affected document's revision.

Workflow start requests now require `X-Edit-Revision` (`expected_revision` in
MCP), for both a whole/dependent workflow and a single step. `plan: true`
remains a read with no revision input; its response includes the `editRevision`
paired with the planned definition. Carry that token into the start after
pending saves settle. Missing or malformed tokens answer `400 invalid_request`;
a stale token, including a change during asynchronous planning, answers
`409 stale_revision` before any run, job or output is created. Starts never
silently replan against a newer revision. Assistant confirmations retain the
planning revision with their approved members. Approval after a definition edit
is refused even when membership is unchanged or fresh grounding has read the edit.
An accepted start returns its
`editRevision` with `run` and does not itself advance the document revision.
This is a breaking request-contract change. The existing confirmed-membership
check and single-run lock still apply.

## Unsupported methods

After authentication, an unsupported method on a documented API path returns
`405 method_not_allowed` with the standard error envelope. `Allow` lists exactly
the methods documented for that path, including automatic HEAD and OPTIONS.
HEAD is bodyless; OPTIONS returns 204 with the same Allow header. Unknown API
paths retain 404 after authentication. Anonymous entry boundaries are unchanged.
The catalogue message is “This method is not allowed for this path.”

## Editing with revisions

A map has one opaque `editRevision` for its content, and a workflow has one for its
whole definition and layout. Document, child, list, project-content, dependency
and producer reads pair the visible state with that revision. Use the revision
from the item you actually displayed or read. Two separate workflow definition
and layout reads may be combined only if their revisions match.

Send `X-Edit-Revision` on every covered write, including a no-op. Within a client,
order all covered writes to one document: wait for the accepted JSON result, take
its `editRevision` and compose the next edit from that accepted state. Child
writes use the parent revision. Do not refresh a token behind a queued old payload.
Compound filing sends each selected document's revision in its documented body
and returns `revisions` for the affected documents still reachable to the caller.
A revision grants no access; authentication, reach and roles are checked first.

This is a breaking change for clients that wrote without revisions or expected
bodyless covered successes. Layer deletion and unpublication now return JSON with
the parent revision. Whole-document deletion has no surviving revision. Whole
creation and copying to a new identity need no destination revision. Consult each
operation's success schema rather than assuming every success is 204.

On `409 stale_revision`, preserve unsaved work and stop that document's covered
writes. The message is exactly “This item has changed. Reload it before trying
again.” Refusal is atomic, including changes racing asynchronous validation.
Missing or malformed revisions return `400 invalid_request`. An explicit reload
reads current state; the browser offers text copying before discarding unsaved
values, queued edits and workflow-local undo. Failed reload keeps the draft. A
new attempt is a deliberate new edit, never silent replay or automatic merge.
Accepted prior saves stay accepted. Revision tokens never revive after undo or
edit-and-restore, including changes in the same clock tick or another same-account
tab. There is no editing lock or durable draft after a successful reload.

### Exceptions and attribution

A viewport-only map PATCH needs no revision and remains last-write-wins without
changing revision, history or last changer. Mixing viewport and content puts the
whole PATCH under the content precondition. Thumbnail captures may carry a
revision for information only: missing or stale revisions do not prevent landing
or decide attribution. Existing SQL and input evidence does. Missing or stale SQL
evidence can still land an owner-only image. Rendering and caches do not advance
edit revisions or attribution, and anonymous published views expose neither.

Dataset contents, geometry and sketch features, connections, account preferences,
project names/notes/membership and run bookkeeping have no document revision
precondition. A dataset cascade that changes a map definition advances that map's
revision. Project dissolution needs no member revision but advances indirectly
unfiled documents. An admin revoking a deactivated owner's known publication token
needs no map revision and gets no private map facts; the map still records the
change. Direct filing and map/workflow transfer do require revisions.

Reached map/workflow responses carry `lastChangedBy` (display `name` and fixed
`sqlName`, `{ deleted: true }` for Deleted account, or null for Unknown) and `lastChangedAt`, separately from ownership
and general update time. Actors come from credentials, including token and
assistant work. Legacy ownership adoption does not invent an author. No-ops,
refusals, camera saves and derived writes do not change attribution. Actor identities remain visible to those who still reach the record after an
actor leaves or is deactivated.

Map undo uses one shared timeline: it reverts the latest applied contiguous group
by one actor, whoever that actor was. Read `undoTarget`/`redoTarget`, their authors,
`eligible` and `reason` before offering replay. There is no selective personal undo
or skipping another person's step. A new edit discards redo; an ineligible group
is refused whole. The undoing person becomes last changer without replacing the
original authors. Workflow undo is local, and its inverse requires the revision
against which it was made. Reload discards that local history.

### Run starts and continuing runs

Read the plan after pending saves settle and send its workflow revision when
starting a workflow or single step. A stale start creates no run or output.
After admission the run tracks a durable executable-definition basis: ordered
steps, active/proposed parameters and origins. A foreign definition change stops
further admissions and promotions, even if values are restored or the clock is
unchanged. An admitted step settles under current permission, input reach and
supersession rules; committed outputs survive. A run cannot overwrite a newer
proposal. Its own successful promotion advances its basis so later steps continue.

Renaming, layout, notes, filing, dissolution and transfer advance edit revisions
but do not alone stop a running definition. Promotions preserve those changes.
Current permissions still control work; loss of Editor standing can make already
admitted outputs land privately. Outputs belong to the runner and filing follows
the project at commit. Runs report their stored initiator. Cancellation requires
no revision and retains its documented conditional bodyless 204 success.

### Executable read and successive writes

In Node.js 24 or later, set `base` to your instance origin and `token` to your
account API token before running this snippet. It leaves one private map called
Survey map with a light basemap. Every error stops the sequence.

<!-- revision-example -->
```js
async function request(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(method === "PATCH" ? { "X-Edit-Revision": current.editRevision } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}
const created = await request("POST", "/api/maps", { name: "Field notes" });
const path = `/api/maps/${created.id}`;
let current = await request("GET", path);
current = await request("PATCH", path, { name: "Survey map" });
current = await request("PATCH", path, { basemap: "light" });
```

## Error catalogue

The table is checked against `x-error-codes` and the Error schema. Codes are stable;
messages below describe the meaning, and operation-specific details may refine the
response message. Branch on the code.

<!-- error-catalogue:start -->
| Code | Meaning |
|---|---|
| `setting_locked` | An environment variable locks a submitted setting. No settings changed; change or remove the named variable and restart before editing this setting. |
| `project_owner_cannot_leave` | The project's owner cannot leave. Transfer or delete the project instead. |
| `method_not_allowed` | This method is not allowed for this path. |
| `authentication_required` | Sign in with a valid session or account token to continue. |
| `invalid_credentials` | Email or password is incorrect. |
| `account_deactivated` | This account is deactivated. Contact an admin. |
| `setup_complete` | This instance already has an account. First-account creation is unavailable. |
| `weak_password` | Use at least eight characters and avoid very common passwords. |
| `email_taken` | An account already uses this normalized email address. |
| `self_change_refused` | Another admin must change your admin flag, deactivate your account or delete it. |
| `account_not_deactivated` | Deactivate this account before deleting it. |
| `deletion_in_progress` | This account is being deleted and cannot be reactivated. |
| `deletion_changed` | This account or its work has changed. Review a fresh deletion preview before confirming. |
| `last_admin` | Keep at least one active admin. |
| `forbidden` | This request is not permitted for the current account or origin: an admin-only request, a cookie request from another origin, or a change to something the account can view but cannot make. A refused change has no effect. |
| `invalid_link` | This sign-in link is unavailable, expired, replaced or already used. |
| `token_expired` | The API token has passed the expiry it was created with and no longer works. Create a new token; the expired one stays listed until it is revoked. |
| `rule_refused` | An instance rule an admin sets refuses this action for the current account: creating an API token, publishing a map or changing a live publication, adding a database connection or pointing one at another host, port or database, or importing from a link. The refusal's rule field names the rule as PATCH /api/instance/settings takes it. Nothing changed, and what already exists keeps working. |
| `current_password_required` | Enter your current password to make this change. |
| `authentication_busy` | Authentication is busy. Try again shortly. |
| `ingress_unavailable` | Trusted socket provenance is unavailable. Authentication entry and published reads cannot proceed. |
| `geometry_not_supported` | Set geometry is available only for file uploads and URL imports. |
| `geometry_choice_invalid` | The geometry choice cannot be applied. The message explains the projection, source or validator issue. |
| `geometry_in_flight` | A geometry edit or refresh is already running for this dataset or URL import group. |
| `unsupported_format` | The uploaded file type is not one of the supported formats. |
| `upload_too_large` | The upload exceeds the configured size cap. |
| `archive_too_large` | The archive's unpacked content exceeds the configured upload size cap. |
| `remote_fetch_failed` | The remote file could not be fetched (unreachable, denied, or missing). |
| `remote_fetch_abandoned` | The outbound request was abandoned before it finished, because whoever asked for it stopped waiting. |
| `remote_too_large` | The remote file exceeds the configured remote size cap. |
| `remote_timeout` | The remote fetch exceeded the configured remote time bound. |
| `egress_blocked` | The destination address is blocked by the egress policy (loopback, private, link-local, or metadata space); the configured allowlist admits exceptions. |
| `area_too_large` | The selected area exceeds the import budget for the chosen theme. |
| `name_taken` | A table of that name already exists. Operations never replace or rename around an existing table. Choose another name. |
| `not_refreshable` | The table has no re-runnable remote source, so it cannot be refreshed. |
| `dependencies_unresolved` | A layer's statement could not be analyzed, so the map's datasets cannot be listed completely. Fix the layer's SQL and try again. |
| `export_failed` | The project archive could not be assembled; nothing was delivered. Retry, and check the server's disk space if it recurs. |
| `refresh_in_flight` | A refresh of this table (or its OSM import group) is already running; retry when it completes. |
| `connection_failed` | The database connection failed (unreachable, authentication, or missing extension). |
| `connection_password_required` | Enter the password again when changing the host or port, or turning SSL off. |
| `malformed_file` | The file could not be parsed as its declared format. |
| `request_body_too_large` | The request body exceeds its documented byte limit. |
| `mcp_read_failed` | The read could not be completed because its response could not be received. |
| `mcp_transport_failed` | The operation's response could not be received. Its outcome is unknown. |
| `mcp_response_invalid` | The instance returned a response that does not match this operation's documented result. |
| `stale_revision` | This item has changed. Reload it before trying again. |
| `invalid_request` | The request was malformed or failed validation, including a missing or malformed required edit revision. Read the item before a covered write. |
| `not_found` | The requested resource was not found. |
| `sql_rejected` | The SQL was not an accepted read-only query. |
| `sql_error` | The SQL failed to parse or execute. |
| `query_timeout` | The query exceeded the configured timeout. |
| `query_memory_exceeded` | The query exceeded the configured engine memory budget for user SQL. |
| `query_result_too_large` | The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value. |
| `tile_build_timeout` | A tile-build stage exceeded the configured tile-build timeout. |
| `render_cap_exceeded` | The layer's result exceeds the inline render cap; tiled rendering is unavailable for this geometry or configuration. |
| `tiler_unavailable` | The result is too large for inline rendering and no tile builder is installed on this instance. |
| `tile_build_failed` | The layer's tile archive could not be built. |
| `render_unavailable` | The image renderer's browser is not available on this instance, so image export cannot run. |
| `render_timeout` | The image render exceeded the configured export render budget (queue wait included). |
| `render_failed` | The image could not be rendered. Retry; if it persists, the instance's renderer needs attention. |
| `look_target_missing` | No map was named for the check and none is in context, so there is nothing to render. |
| `look_image_too_large` | No image of the map fits inside the check's byte bound at any documented size, so none was returned. |
| `look_image_unavailable` | The image of this check is no longer kept on this instance: it was evicted under the retention bounds or did not survive a restart. It is never rendered again. |
| `attachment_too_large` | The tool attachment exceeds the configured cap; narrow the export or raise the cap. |
| `operation_timeout` | The operation exceeded the configured execution budget for a run. Time spent waiting for the lane is not counted against it. |
| `operation_queue_full` | Too many operations are already queued; the run was refused rather than accepted into a queue that would not drain. Retry once some complete. |
| `run_in_flight` | This workflow already has a run in flight; a workflow runs one at a time. Wait for it, or cancel it, then run again. |
| `plan_changed` | The workflow changed since the run was confirmed, so the nodes it would run are not the ones confirmed. Nothing started; look at the plan again. |
| `operation_interrupted` | The server stopped while this run was in the lane, so it did not finish. Nothing partial was kept; run it again. |
| `input_changed` | An input was replaced while the run was waiting, so the answers it had prepared belong to data that is no longer there. Nothing was written; run it again against the current data. |
| `geocoder_unconfigured` | No geocoding endpoint is configured on this instance (the Address finder an admin sets, or DEZFIL_GEOCODER_URL), so an operation that asks a provider for addresses cannot run. The message says which one to change now. |
| `geocoder_failed` | The configured geocoding endpoint did not answer, twice in a row. The run published nothing rather than recording an absent answer as an address that does not exist. |
| `isochrone_unconfigured` | No routing endpoint is configured on this instance (the travel-time endpoint an admin sets, or DEZFIL_ISOCHRONE_URL), so an operation that asks a provider for travel-time areas cannot run. The message says which one to change now. |
| `isochrone_failed` | The configured routing endpoint did not answer, twice in a row. The run published nothing rather than recording an absent answer as an unreachable origin. |
| `service_address_unreadable` | A service address, or the satellite imagery's tile template, an admin saved in Settings cannot be read with this instance's encryption key, which changed after it was saved. The service, or the imagery style, refuses rather than reach a default; an admin saves the address again. |
| `basemap_not_offered` | The basemap a map write or an undo or redo would put a map on is one this instance does not offer now: a style an admin hid, or, while style addresses on single maps are off, a style address the basemap library does not offer. It cannot be chosen anew. The refusal's setting field names the switch, as PATCH /api/instance/settings takes it. Nothing changed; a map already on that basemap keeps it, and Auto is always offered. |
| `measurement_crs_unavailable` | The data spans more of the earth than any local projection covers, so a distance measured over it would not be in ground metres. Split it by region and measure each part; an area over the same data succeeds and records the global projection it used. |
| `operation_superseded` | The step this run belonged to was changed or removed while it was working, so the run lost its authority to publish and wrote nothing. What it would have produced is no longer what the step means. |
| `widget_layer_missing` | The widget references a layer that no longer exists, so its value cannot be computed. |
| `column_unavailable` | The write introduces a reference to a column the layer's result does not provide, or provides with a type the channel cannot use, so it was refused; stored references are never retro-refused. |
| `field_not_published` | The selection references a field the published surface does not declare: outside the layer's effective published field set and not a published widget's field. |
| `catalogue_not_published` | A published layer or widget whose SQL reads the instance's catalogue does not evaluate on the link while its owner holds datasets the map does not name: a published map reaches only the datasets its own layers name, and the link would otherwise disclose the others. |
| `selection_incompatible` | The selection's values cannot be evaluated against its field's type (for example a time range on a non-time field); it was refused before evaluation. |
| `rate_limited` | Too many requests or sign-in attempts; retry after the indicated delay. |
| `catalogue_too_large` | The schema page exceeds 96 KiB. Request fewer tables or columns. |
| `assistant_reservation_required` | Reserve a run with POST /api/assistant/runs, then send its id as runId. |
| `assistant_run_unavailable` | This run identity is unavailable and cannot execute. |
| `assistant_run_conflict` | This run identity is already bound to different input. |
| `assistant_capacity` | Eight assistant runs occupy capacity. Read GET /api/assistant/pending; release an unused reservation or abandon a pending turn with DELETE /api/assistant/runs/{id}. |
| `assistant_run_state` | This operation is not available in the current run state. |
| `assistant_submission_too_large` | The assistant submission exceeds 128 KiB. |
| `assistant_recovery_limit` | Further work stopped before the live recovery bound could be exceeded. |
| `assistant_plan_unavailable` | The current workflow membership could not be established. No run was approved or started. |
| `assistant_action_uncertain` | The action outcome could not be established. Its declared resources may have changed. |
| `assistant_action_interrupted` | The read was interrupted before completion. |
| `assistant_action_not_admitted` | The run's page context does not admit this operation; nothing was performed. Runs under a /sql or workflow context admit only operations that declare themselves read-only, and none that reaches outside this server or asks for confirmation. |
| `assistant_choice_invalid` | The submitted model choice is malformed: it must be an object whose optional model and effort are strings. |
| `assistant_model_not_offered` | The requested model is not one this instance offers. GET /api/assistant lists the models it offers. |
| `assistant_effort_not_offered` | The requested effort is not one the selected model offers. GET /api/assistant lists each model's own efforts. |
| `assistant_effort_not_supported` | The selected model has no effort levels of its own, so it takes only the provider default. Send the effort "default", or no effort at all, or choose a model that offers levels. GET /api/assistant lists each model's own efforts. |
| `assistant_context_invalid` | The submitted page context is malformed or refers to an incompatible object. |
| `assistant_context_too_large` | Page context exceeds 64 KiB of UTF-8 JSON. |
| `assistant_context_unavailable` | The page context could not be read from this instance. |
| `assistant_disabled` | The assistant is not enabled; no model credential is configured. |
| `assistant_auth` | The configured model credential was rejected by the provider. |
| `assistant_provider` | The model provider request failed (outage, quota, or network). |
| `pending_unknown` | The referenced pending action is unknown; it may have expired with the server's working state. |
| `pending_resolved` | The referenced pending action was already resolved; it will not run again. |
| `pending_superseded` | A newer message superseded the referenced pending action, declining it. |
| `invalid_sketch_feature` | The submitted sketch feature failed the structural gate: kind, geometry family, coordinate ranges, ring closure or the published vertex ceiling. |
| `not_a_sketch` | The named table is not a sketch dataset; sketch operations apply only to tables drawn on a map. |
| `feature_not_found` | No drawn feature with the given id exists in the sketch dataset. |
| `vertex_move_refused` | The vertex move was refused: only drawn polygons and freehand shapes offer vertex handles, and the index must name an existing vertex. |
| `sketch_gone` | The sketch dataset was deleted or replaced while the change was in flight; nothing was written. |
| `map_not_found` | No map exists with the given id. |
| `template_not_listed` | No template with that id is shipped with this instance, downloaded to it or listed by the catalogue list it last read. |
| `templates_catalogue_off` | An admin turned the template catalogue off (the templates.catalogue setting), so the server reaches it for nothing: no refresh, Test or download is sent. Shipped and downloaded templates still open and copy. |
| `template_archive_too_large` | A template's archive is larger than the size the catalogue's index declares for it, or than the 150 MB a template archive may be; nothing was installed. |
| `template_checksum_mismatch` | A template's archive arrived with another size or another SHA-256 than the catalogue's index declares; nothing was installed. |
| `template_unpacked_too_large` | A template's archive unpacks past this instance's upload cap; nothing was installed. |
| `template_malformed` | A template's archive is not one this server reads: not a readable ZIP holding one .dezfil folder, a document that is not JSON, or a dataset the upload's reader cannot read. |
| `template_entry_escapes` | A member of a template's archive names a path outside its folder. |
| `template_members_mismatch` | A template's documents name a member it does not hold, or it holds a member nothing names. |
| `template_format_unsupported` | A template is in a format version this server does not read. |
| `template_invalid` | A template's document fails the rules a client's document is held to, one of its layers or steps does not bind to the template's own data as a client's would, or a layer draws more than the render cap's default. |
| `template_forbidden` | A template carries a publication, token, connection, service address or setting, which no template may. |
| `template_picture_too_large` | A template's map picture is larger than its 2 MB bound. |
| `template_licence_refused` | A template's data is under a licence that does not allow redistribution. |
| `template_credit_missing` | A template's credit note does not name every source with its licence. |
| `template_reference_outside` | A template's layer or step names a dataset that is neither the template's own nor the result of an earlier step, such as a person's dataset or another template's. |
| `template_record_mismatch` | An installed template's files differ from the record written when it was installed, so it is refused rather than trusted. |
| `template_not_installed` | That version of the template is listed by the catalogue but not on this server yet, so it cannot be copied; fetch it first (POST /api/templates/{id}/fetch), then copy. Nothing was created. |
| `template_reference_unbound` | A layer or step of the template names a dataset the copy could not bind to the datasets it makes, so the copy was refused whole and nothing was created. |
| `internal` | An unexpected server error occurred. |
<!-- error-catalogue:end -->

The result-byte regression and outside probe invocations are in
[result budget commands](runbook.md#sql-result-byte-budget).
