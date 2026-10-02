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

Measured from the current source: **124 paths, 163 operations, 156 named
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
configured, but never a configured URL that might carry a key).
`GET /api/openapi.json` serves the description. `GET`/`PATCH /api/settings`
return the caller's account display name and per-screen view preferences,
plus the shared instance name. Only admins may change the instance name.
`sourceGrouping` is how the SQL console's source list groups datasets for
the caller, `person` (their own, then each other person's) until they choose
`project`; the read always carries it, and it is one account's alone.
Every field in a patch is validated and authorized before any write.
`/api/palettes` manages saved color palettes.

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
`count` call so the size of an import is known before it runs. Reads are
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
and nothing changes. The token is the link, so it is the owner's to read as
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
inputs and last success describing the same run. Each run record names its
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
and a project archive carries no connection facts.

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
(`src/lib/api/error-catalogue.ts`). There are **103** codes. Clients should
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
facts. `lastChangedBy` is `{ name, sqlName }` or explicit null for unknown
authorship, including legacy records. Departure and deactivation do not
erase a recorded actor. Anonymous published views carry none of these facts.
Workflow steps and their revision are captured together before presentation;
separately read definition and layout belong together only when revisions match.
Camera, thumbnails, dataset contents and run bookkeeping do not advance these
facts. Write preconditions are not yet required by these preparatory changes.

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
as `{ name, sqlName }`, or null for unknown historical authors. A target
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
silently replan against a newer revision. An accepted start returns its
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
