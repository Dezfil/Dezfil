---
title: "Configuration"
summary: "Every setting an instance reads, with its default, what it does, and whether it changes live in Settings or needs a restart."
read_when:
  - "you set an environment variable for an instance"
  - "you want to know a setting's default"
  - "you need to know whether a change applies live or after a restart"
audience:
  - operator
  - agent
checked: none
order: 3
moved_from:
  - "/docs/reference/configuration/"
---

The catalogue defines every deployment setting. Their defaults allow a local
instance to start without deployment configuration. The editable limits, the four
service addresses, the services' gaps, answer limits and freshness, the template
catalogue's address, and the satellite imagery's tile address and credit also
accept stored admin changes,
made on the **Limits**, **Data & services** and **Libraries** tabs of Settings.
Each settings table's **Changes** column says how each way of changing a
setting takes effect: in Settings, live; by variable, after a restart.
`GET /api/instance/settings` reports the effective configuration, sources and
locks to admins.

Every deployment setting is optional; pass them as `-e NAME=value` on
`docker run`. A setting its variable sets shows locked in Settings, naming the
variable. The **System** tab shows each part of the server (the data folder,
the query engine, the tile builder, the image renderer and the metadata
database) with a Test, what the data folder holds by kind with Clear all for
the service caches, and every setting a variable decides, with the value in
effect and its source.

For an instance setting, a non-empty deployment variable wins and locks app
changes, including clearing a stored value. Changing any environment variable
requires a restart. An accepted variable supplies its normalized value; an
invalid numeric variable keeps the setting locked and uses the built-in default.
With no variable (an empty numeric variable counts as absent), the stored value
wins, then the default. Shadowed stored values stay saved and apply after the
variable is removed and the process restarted. Admin changes through
`PATCH /api/instance/settings` apply live to new work; admitted work retains its
budget. Settings without a variable are never locked.

Other settings persist at runtime. Settings saves **account preferences** such as
the display name, view choices and the look picked on the **Appearance** tab,
and **instance preferences** such as the
admin-managed instance name, in SQLite. The instance operation also saves the
sign-in message, lost-password contact and landing page, which admins set on the
**General** tab of Settings; the entry read carries them. The sign-in page shows the
message as plain text and names the contact in its lost-password line. After a
sign-in, the first account or an accepted invitation, the browser opens the landing
page. A signed-in visit to the setup or sign-in page still opens Home. Accounts,
sessions and API token records also persist there. Saved palettes are shared
instance data. What new maps, new layers, the workflow canvas, the SQL console
and a fresh image export card start with is kept there too, set by admins on the
**Maps**, **Workflows & SQL** and **Publishing** tabs; see
[Instance defaults](#instance-defaults). So are how long sign-ins and links last,
the shortest password, and who may create tokens, publish, embed, connect and
import; see [Security and rules](#security-and-rules). So are which basemaps are
offered, the basemap library and whether a single map may take a style address
of its own, set by admins on the **Libraries** tab; see [Libraries](#libraries).
So is whether the server reads the template catalogue, set by admins on the
**Data & services** tab; see [Templates](#templates).
These are not environment variables. A service address an admin stores is kept
there too, encrypted with the instance's key, and so is the satellite imagery's
tile address; see [Service addresses and numbers](#service-addresses-and-numbers).

The optional `assistant-models.json` in the data directory supplies the model
catalogue; environment model lists narrow its offer. It is a file, not an account
preference. Its reload and validation rules are in
[the runbook](backup-and-restore.md#the-model-catalogue-file). Edit revisions and stale-save
recovery need no deployment switch.

Two conventions run through the whole surface:

- A numeric environment override that is non-numeric or not greater than zero
  falls back to its default rather than failing the boot. An absent override
  uses the stored value when available, otherwise the default. Two settings
  treat zero as a real value, the two
  provider pacing intervals, so that "no gap at all" can be expressed.
- Sizes are megabytes, durations are seconds unless the name ends in `_MS`
  or `_HOURS`.

## Settings tables

Every setting has one row, in the table of its area. A row gives the setting
as Settings names it, its variable and its Settings key where each applies,
the default with its unit, the values it takes, what it does, and how each
way of changing it takes effect: in Settings, live; by variable, after a
restart.

- [General](configuration/general.md): the instance's name, the sign-in
  message, the lost-password contact and the landing page.
- [Instance defaults](configuration/defaults.md): what new maps, new
  layers, the workflow canvas, the SQL console and a fresh image export
  start with.
- [Basemaps and imagery](configuration/libraries.md): which basemaps are
  offered, the satellite imagery and the deployment's own basemap.
- [Data and services](configuration/services.md): the address finder,
  travel time, OpenStreetMap, cloud storage, the template catalogue and the
  private network.
- [Security and rules](configuration/rules.md): sign-ins, links,
  passwords, and who may create tokens, publish, embed, connect and import.
- [Storage and programs](configuration/storage.md): the data folder, the
  encryption key and the programs the server runs.
- [Set up the assistant](assistant.md): the model keys, the provider, the
  models on offer and the assistant's budgets.
- [Reverse proxy and HTTPS](reverse-proxy.md#trusted-proxies): the trusted
  proxies and the session cookie's name.
- [Limits](../api/limits.md#limits-an-operator-changes): the limits an
  operator changes, on time, size, memory, rates and queues.

The tables are generated from the settings catalogue,
`src/lib/settings/catalogue.ts`, by `npm run docs:write`, and
`npm run lint:docs` fails a table that is not current. `npm run lint:readme`
(`scripts/check-readme-config.mjs`) holds the tables this list links to the
catalogue and to what the server reads, in both directions: every
deployment variable and every stored instance setting has exactly one row,
in its area's table, with its documented default, its Settings key and its
change timing. It keeps no separate list of settings. The test wiring, and
the test seams the server reads, are on
[Development setup](../contribute/development-setup.md#test-and-development-wiring),
held the same way.

Three classes are deliberately outside the check: test-local seams
(`DEZFIL_TEST_*` read only by test files in `src/`, and `DEZFIL_BASE_URL`),
platform plumbing (`NODE_ENV`, `PORT`, `HOSTNAME`, `NEXT_RUNTIME`, `TZ`, `CI`,
`PATH`, `DUCKDB_EXTENSION_DIR`, `UV_THREADPOOL_SIZE`), listed at the end of
this page, and an account's own preferences, which are not instance
settings.

## Instance defaults

What new maps, new layers, the workflow canvas, the SQL console and a fresh
image export card start with. Admins set them on the **Maps**,
**Workflows & SQL** and **Publishing** tabs of Settings, or through
`PATCH /api/instance/settings` under the keys their table names. Every signed-in account and
agent reads the values in effect as the `defaults` object of `GET /api/config`.
They are stored instance settings with no environment variable, so none is ever
locked, and a change applies to the next new thing at once.

Defaults apply to new things only. A map, a layer, a published view or an image
that already exists keeps what it has, and a canvas, console or export card
already open keeps what it opened with. Nothing that draws an existing map reads
a default: the builder, a published view, the read-only map view, an image
export and the server's own rendering keep each map's stored values and their
own fallbacks. A duplicated map keeps its source's values.

A number-like choice is text: send `"16"` for a text size, not `16`.

The rows of these settings are in the settings table on [Instance defaults](configuration/defaults.md).

A layer created with a style keeps it, and a drawn sketch's layer takes only the
cycle's color. Null clears a stored default, returning it to its table's default.

## Security and rules

How long sign-ins and links last, when failed sign-ins pause, the shortest
password, and who may create API tokens, publish, embed published pages, add
database connections and import from links. Admins set the sign-in and token
rows on the **Security** tab of Settings, the publishing rows on the
**Publishing** tab's Public links card, and the connection and link-import
rules on the **Data & services** tab's Connections and imports card; every row
also changes through `PATCH /api/instance/settings` under the keys their table names. They
are stored instance settings with no
environment variable, so none is ever locked, and each applies live,
without a restart.

Every signed-in account and agent reads the rules it follows as the `rules`
object of `GET /api/config`: `tokens.create`, `tokens.expiry`,
`publishing.publish`, `publishing.embedding`, `connections.create` and
`imports.links`, keyed and valued as the change operation takes them, with the
shortest password beside it as `passwordMin`. The sign-in entry read carries
`passwordMin` too, 8 before setup. The lifetimes, the sign-in counts and the
listed sites are read by admins alone, through `GET /api/instance/settings`.

The rows of these settings are in the settings table on [Security and rules](configuration/rules.md).

A number-like choice is text: send `"90"` for a session length, not `90`. The
two counts and the listed sites are checked together: a per-address count below
the per-account one, or `listed` with no site, refuses the whole change. A site
is kept as its origin, its scheme, host and any port other than the scheme's
own; a repeated site is kept once, and an empty list or null clears the list.
Browsers match a site listed with `http` to its `https` address as well, so
`http://portal.example` also admits `https://portal.example`.

A rule refuses new reach and takes nothing away. An action it refuses answers
`403 rule_refused`, with `error.rule` naming the rule, and changes nothing; the
screens show that action disabled with the same sentence. A token past its
expiry answers `401 token_expired` and stays listed until revoked. Under
`listed` or `off`, a published page's answer carries
`Content-Security-Policy: frame-ancestors` with the listed sites, or `'none'`;
under `any` it carries none, and the published data answers never carry one.

## Service addresses and numbers

The address finder, travel time, OpenStreetMap and the S3 address that
anonymous `s3://` links are read through each take an address an admin can
store on the **Data & services** tab of Settings, beside the variable that
sets it; so do the services' eight numbers. A set variable wins and locks its
row, which then shows locked, naming the variable. Each also changes through
`PATCH /api/instance/settings` under the key its table names, in the variable's unit; the
tab shows a gap in seconds and how long answers are kept in days (hours for
OpenStreetMap).

The rows of these settings are in the settings table on [Data and services](configuration/services.md).

An address is `http` or `https` with a host, at most 2,048 characters, and may
carry a key in its user information, path or query. It is write-only: stored
encrypted with the instance's key, like a connection's password, and read back
anywhere (the configuration read, the change answer, a run's view, a dataset's
record, a refusal, a Test answer, the assistant's confirmation and record) as
its scheme and host alone. A new key means sending the whole address again;
null removes a stored one, OpenStreetMap's returning to the public Overpass
server and the S3 address to Amazon S3's. With the instance's key replaced, a
stored address reads as set and unreadable and its service refuses with
`service_address_unreadable`, never reaching a default, until it is saved
again.

An address the egress policy would refuse now is refused at save, its key
named with the policy's own sentence and the address never repeated: a literal
in loopback, private, carrier-grade, link-local (cloud metadata included),
unique-local, unspecified, multicast or reserved space, mapped forms included,
or a name all of whose addresses resolve there, unless `DEZFIL_EGRESS_ALLOWLIST`
names it. A name that does not resolve at save is kept. Every request checks
again, against the address it connects to. A geocoding or travel-time run
finishes on the address, gap and answer limit it was admitted with, and answers
cached under one address are never served for another.

A gap or an answer limit applies from the next request and freshness at each
cached answer's next use; a run already admitted keeps its own. The tab also
shows each cache's use against its budget with Clear, Overture's release list
with Check now, and a Test per service; both are operations in
[the API guide](../api/http-api.md#resource-families). Each cache's budget, how long a
no-match is kept, the Overpass response budget, the Overture endpoint, signing
object-store reads with the server's credentials and the allowlist stay the
environment's alone; the tab shows the last two locked, naming their
variables.

## Libraries

What the instance offers every map, set by admins on the **Libraries** tab of
Settings: which basemaps a person may choose, whether a single map may take a
style address of its own, the basemap library, the satellite imagery and the
saved palettes.

The five basemap switches are stored instance settings with no environment
variable, so none is ever locked. Each also changes through
`PATCH /api/instance/settings` under its key, as `true` or `false`, and applies
from the next choice, without a restart. Every signed-in account reads the
basemaps on offer in `GET /api/config`, as `basemaps`, `basemapStyles` and
`singleMapStyles`.

The rows of these settings are in the settings table on [Basemaps and imagery](configuration/libraries.md).

A new map whose stored basemap is hidden starts on Auto. The tab's Reset
returns these five and never touches a style an admin added.

The basemap library holds at most 50 styles an admin added by their address,
each offered or hidden where a basemap is chosen. The server reads a style's
address once, as it is added, through the egress check, and keeps its credit or
its host; the address is public to whoever draws a map on it. Adding, hiding
and removing are operations in [the API guide](../api/http-api.md#resource-families). A
map that took a style keeps its own copy of the name, address and credit,
whatever happens to the library afterwards.

The satellite imagery's tile address and credit are `satelliteUrl` and
`satelliteAttribution` to `PATCH /api/instance/settings`, beside
`DEZFIL_SATELLITE_URL` and `DEZFIL_SATELLITE_ATTRIBUTION` under
[Rendering and tiles](#rendering-and-tiles); a set variable wins and locks its
row, which then shows locked, naming the variable. The tile address is an
address holding `{z}`, `{x}` and `{y}`, at most 2,048 characters; the server
fills it for each tile as MapLibre fills a raster template, so `{ratio}`
(`@2x` for a high-density screen, else nothing), `{quadkey}`, `{prefix}` and
`{bbox-epsg-3857}` are filled too. It is kept as
[Service addresses and numbers](#service-addresses-and-numbers) describes:
write-only, encrypted with the instance's key, read back as its scheme and host
alone, and refused at save where the egress policy would refuse it now. Unlike
a service address, it is also refused at save when it carries a user name or
password: the imagery is not drawn from such an address, so the key belongs
in the path or the query. One that carries them anyway, set by the variable or
stored before saves refused it, reads with `userInformation: true` and counts
as no imagery: Satellite is not offered and a map on it draws the default
style; the tab says so under the tile address. The credit is text of at most
160 characters. Without a readable tile address
Satellite leaves every basemap picker; a map on Satellite keeps its choice and
draws the default style, credited as that style, until an address is saved
again, and the map's basemap picker says so. The tab's Test
fetches one fixed low-zoom tile at the address in effect; one carrying a user
name or password is refused there too, with the save's sentence and nothing
sent.

The tile address never reaches a browser. The imagery style names the
instance's own tile address, and the server fetches each tile from the
template and passes it back; a published map's readers, who are not signed in,
reach the same imagery through the publication's own addresses while it is
published. Only a tile's zoom, column and row go to the template, through the
egress policy, within ten seconds and 4 MiB, and no tile is kept. The imagery
provider therefore sees this server's requests, not each viewer's: a key
restricted to browser origins or referrers needs that restriction lifted, and
a limit the provider sets per address counts all of this instance's viewers
together. An image export of a map on Satellite checks the template's host
against the egress policy before it starts and, when the policy refuses it,
answers `render_failed` rather than make the image without its imagery; a
tile the policy refuses while the image renders, at a redirect or at another
host the template names, refuses the image the same way.

The saved palettes are listed on the same tab, each with its colors, and added
or deleted there through `/api/palettes`, as in the builder. Deleting one
keeps the colors of every layer classified with it.

## Templates

Whether the server reads the template catalogue, and where it is. Admins set
both on the **Templates** card of the **Data & services** tab of Settings,
which also tests the catalogue and removes the downloaded templates, or through
`PATCH /api/instance/settings` and its generated tool. While the catalogue is
off, the card offers no Test, since the server reaches the catalogue for
nothing.

The template switch is a stored instance setting with no environment variable, so
it is never locked. It also changes through `PATCH /api/instance/settings`
under its key, as `true` or `false`, and applies from the next read, without a
restart.

The rows of these settings are in the settings table on [Data and services](configuration/services.md).

The catalogue's address is `templatesCatalogueUrl` to
`PATCH /api/instance/settings`, beside `DEZFIL_TEMPLATES_CATALOGUE` under
[Upload and remote import](#upload-and-remote-import); a set variable wins and
locks its row, which then shows locked, naming the variable. Its default is the
release catalogue of the public `Dezfil/templates` repository. It is an address
kept as [Service addresses and numbers](#service-addresses-and-numbers)
describes: write-only, encrypted with the instance's key, read back as its
scheme and host alone, and refused at save where the egress policy would refuse
it now. The variable alone may name a folder on the server instead of an
address: a folder holding the index and the archives and pictures it names,
read as files under the same checks, taken from the working directory when the
path is relative. Every read says a folder is set, never which; a save from the
API or a tool takes an `http` or `https` address alone, so no token or
assistant can point the server at a folder.

The server reads the catalogue only when the template list is refreshed, which
the **Templates** page asks for each time it opens, and a template's own page
when it names a template the server has not listed yet, at most once in ten
minutes after a successful read, or thirty seconds after a refused or failed read: the index (at most 1 MB), then each listed template's two pictures
(at most 2 MB each, 64 MB for the list), through the
egress check within `DEZFIL_REMOTE_TIMEOUT_S` and with no credential, so a
catalogue on a private network needs `DEZFIL_EGRESS_ALLOWLIST` to name it.
Changing the address or the switch drops the list read before. The
catalogue's Test on the services' Test operation reads the index alone.

The shipped templates need no catalogue: they are installed in the image's
`templates/` folder and listed first, in its index's order, whether the
catalogue is on, off or unreachable. This release ships three: the maps
*Forty years of big earthquakes* and *The world's air routes*, and the
workflow example *Health access in Rwanda*. They change only with a release; a
catalogue entry naming one of their ids does not replace it, and Remove all
leaves them. `NOTICE` lists their data's sources, licences and credits.

## Fixed result limits

SQL console/SQL previews, dataset inspection, geometry-choice preview and the
PostGIS five-row preview have fixed result limits: **33,554,432 bytes (32 MiB)**
for the complete uncompressed UTF-8 JSON answer and **2,097,152 bytes (2 MiB)**
for one non-geometry column value. Equality is admitted. Quotes, escaping,
nested values, schema, repeated keys and metadata count after existing display
conversions and excerpts. Native geometry, identified by type or registered
provenance before conversion, counts only toward the result ceiling; coordinate
text and JSON remain non-geometry. Exceeding either bound refuses the whole
answer with HTTP 422 `query_result_too_large`, without partial data or details:

> The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.

These ceilings have no setting. Row and engine-memory limits still apply;
a result below both byte ceilings can fail the engine-memory limit during
query execution or result projection, including geometry decoding. Layer
renders, dataset map features, slider and Overture previews,
published views, statistics, classification, widgets and value search retain
their existing limits. SQL, table and layer file exports still stream complete
results above both ceilings. Dataset inspection shows text values, and the WKT
of its registered geometry column, longer than 512 characters as their first
512 characters and an ellipsis, as geometry-choice preview does. Other values,
nested values, additional geometry columns, the schema, row counts and the
stored data stay whole, and SQL console/SQL previews and the PostGIS preview do
not excerpt, so long text alone no longer refuses an inspection. An inspection that still exceeds a
ceiling, with a nested value over 2 MiB for example, prevents its detail and docked set-geometry
panel from opening. It also blocks tool column pickers, SQL schema inventory
and completion, workflow dataset reads and facts, and automatic layer addition
after a tool run. The tool run can report failure even though the dataset has
already been written. Existing layer rendering, dataset map features, complete
API file exports and owner deletion from Data use separate reads and remain
available. This bounds serialized data on the covered reads,
not native chunks, JavaScript object overhead, heap or RSS.

## Storage

The rows of these settings are in the settings table on [Storage and programs](configuration/storage.md).

## Trusted proxies

The rows of these settings are in the settings table on [Reverse proxy and HTTPS](reverse-proxy.md#trusted-proxies).

## Request body admission

JSON admission has fixed outer byte tiers: 65,536 bytes for authentication
entry, Account, Users, instance settings and the three anonymous published POSTs; 16,777,216 for
other JSON, including MCP and workflows; assistant messages retain 131,072.
Excess returns 413 with the operation's documented error. Optional bodies,
escaping and UTF-8 bytes count too. Render selections remain in the small tier
even when their filters satisfy the semantic limits. MCP's base64 envelope
makes a raw upload smaller than 12 MiB; see [the MCP guide](../api/mcp.md).
Multipart uploads stream to disk under the separate file/archive caps.

The fixed `experimental.proxyClientMaxBodySize` in `next.config.ts` is
17 MiB (17,825,792 bytes), allowing the 16 MiB JSON boundary to reach its reader.
Matched paths still drain and copy up to that limit before the gate, including
anonymous callers. A fronting reverse proxy's own request-size limit bounds
that residual copy further. Canonical spellings of `/api/tables`, the public
widget-values, render and extent POST paths and the three authentication entry
POSTs bypass the copy and preserve their handler-side gates. The native door returns an
empty 400 for `TRACE`. See [self-hosting](what-leaves-the-instance.md) for the wire
behavior and [the API guide](../api/http-api.md#request-bounds) for exact refusals.

## Upload and remote import

The rows of these settings are in the settings tables on [Limits](../api/limits.md#limits-an-operator-changes) and [Data and services](configuration/services.md).

Trusted work shares the configured engine memory (3072 MB by default) and
spill storage under `engine-spill/` in the data directory, capped at four times
that memory (12288 MB by default). Restart removes abandoned spill without
touching tables, metadata, tiles or other temporary work. Memory or scratch
exhaustion answers `422 engine_memory_exceeded`, naming the work, shared budget
and `DEZFIL_TRUSTED_MEMORY_MB` remedy. These are engine budgets within the
supported 8 GiB container profile, not a whole-process memory ceiling.
A layer render (ordinary, template, selection or published, and the layer
results image exports and the map check draw) builds its inline answer under
Bytes drawn per layer: the complete uncompressed UTF-8 JSON, geometry,
properties, label anchors and envelope, is counted while it is read, and an
answer that would exceed the limit is stopped before it is complete. The layer
then takes the road it takes over the render cap: a points layer draws as
tiles (outside templates, which have no tile road), a layer the canvas filters
live has its filters applied in the query and draws if that fits, and anything
else answers the errored-layer envelope `render_bytes_exceeded`. No single
value has a ceiling of its own. Dataset map features (the dialog map's
reference layer and the dataset detail's map) count their answer the same way;
over the limit, the whole dataset or the sample asked for answers `ok: false`
with a reason and no features. A slider preview counts its answer the same
way and over the limit answers `422 render_bytes_exceeded` with no partial
preview; the builder stops asking for that preview until the layer's source
changes, and the layer still draws when the slider settles. An Overture Run
Query preview counts its answer the same way, keeping the render cap's first
features and its `truncated` flag, and over the limit answers
`422 render_bytes_exceeded` with no partial preview; the import is not held to
it. An OpenStreetMap Run Query preview counts its features the same way while
they are assembled, keeping its order (points, then lines, then polygons), the
render cap and `truncated`, and stops assembling once the preview is over the
limit or complete; one element the preview would certainly carry that is over
the limit on its own refuses it before anything is assembled. A sketch's features read (`GET /api/sketches/{name}/features`)
counts its complete answer the same way and over the limit answers
`422 render_bytes_exceeded`; the reads a change to the sketch makes are not
held to it, so a sketch too large to read whole can still be changed. A
template version is admitted only if each layer of its map draws within the
defaults of the render cap (250,000 features) and of Bytes drawn per layer
(134,217,728 bytes), counted as its view renders it, whatever this instance
sets; a layer over either answers `422 template_invalid` naming the limit. A
version installed before opens and copies as it is, and any excess shows in its
layer's render. File and
archive import processing, link and object-store imports, URL refreshes, and OpenStreetMap, Overture and PostGIS imports and refreshes
use the Data processing time limit
through preparation and commit. Accepted processing continues after departure;
expiry removes candidates and leaves previously committed data intact. Upload
reception and processing each get the same limit captured when receiving begins,
with a fresh processing deadline after the complete file reaches disk. A settings
change during receipt changes neither budget. No body byte for 60 seconds,
including before the first byte, answers `408 upload_stalled`; continuous progress
past the reception deadline answers `408 data_processing_timeout`, naming
reception and the admitted limit. The first refusal wins, except that a caller
leaving after an interrupted body is answered as departed. Refusals are sent
without draining the remaining body, with a one-second fallback for delayed
cleanup and a five-second connection-close bound while the body is still
arriving; a refused request whose body arrived completely keeps its connection. Incomplete reception cancels
on departure and removes its partial file. Other request bodies retain a
300-second receive limit (`408 request_timeout`), and headers retain 60 seconds.
The native server's clock is above these application deadlines, including a
larger deployment override. Fully received requests can reuse their connection.
The upload surface shows application refusal messages; a lost connection or an
intermediary response remains an unconfirmed transport outcome. Dataset and geometry inspection, catalogue reads, dataset map
features and projection lookup now share one admitted Query time limit through
preparation and reads, and cancel when the last interested caller leaves.
OpenStreetMap previews use the same query lifetime through source preparation
and geometry assembly, retaining the existing Overpass time and size limits.
Overture release discovery, divisions, counts and previews also use the query
lifetime, including scope preparation. Shared division reads retain the original
deadline while callers can leave independently; imports and refreshes inherit
the processing lifetime through commit. Committed work answers with its success
even when the scratch cleanup after it outlasts the limit. PostGIS connection tests, catalogue
reads and previews use the query lifetime, with imports and refreshes under
the processing lifetime. Every PostGIS attachment retains the 10-second connect
limit and owned interruption. Imports and refreshes give their source statements
a ceiling of the processing time left when the source is attached, and a source
that outlasts the limit answers `408 data_processing_timeout`. Previews keep a
30-second source statement ceiling; connection checks and catalogue reads keep
it too, or take the Query time left when the source is attached if that is
less. Both answer `408 query_timeout`. A refusal (the time limit, a departure
that cancels the work, or a resource refusal) cancels the attachment's running
statements on the source through a short-lived second connection under the same
role, with a 5-second connect limit, so source work settles within the 35-second
allowance even when its statement started late; the ceiling stays as the
backstop, and a failed cancellation is logged. A source statement blocked on
the server holds one of the runtime's workers, so at most three quarters of
that pool (`UV_THREADPOOL_SIZE`, 4 unless set, so 3 at once) may be out on
PostGIS sources; the rest wait their turn within their own time limit, and a
worker stays free for the cancellation and the rest of the server. Geometry set and clear
use one processing lifetime through preparation, revision checks and replacement,
continue after departure, and retain the previous artifact on refusal. Sketch
feature reads and map summaries share the query lifetime; sketch changes keep
one processing deadline through queue waiting, reads, conversion and commit.
Accepted changes continue after departure. An expired queued change cannot
write later or let a successor bypass an active predecessor. Dataset conversion
and project export use the processing limit, cancel on departure, and clean
temporary conversions and unfinished archives. All conversions in a project
export inherit one deadline. Template download, preparation, validation and
installation also share one processing deadline, including queue waiting and
shared downloads. Later callers do not extend it; accepted installation continues
after departure. Hardened template validation keeps its own query and memory
limits. The release install command retains the complete shipped-set check and
removes its owned scratch and lock on refusal.

## Open data providers

The rows of these settings are in the settings tables on [Data and services](configuration/services.md), [Limits](../api/limits.md#limits-an-operator-changes) and [Development setup](../contribute/development-setup.md#test-and-development-wiring).

## Query engine

The rows of these settings are in the settings table on [Limits](../api/limits.md#limits-an-operator-changes).

## Rendering and tiles

The rows of these settings are in the settings tables on [Limits](../api/limits.md#limits-an-operator-changes), [Storage and programs](configuration/storage.md) and [Basemaps and imagery](configuration/libraries.md).

## Publishing

The rows of these settings are in the settings table on [Limits](../api/limits.md#limits-an-operator-changes).

Published API budgets use verified ingress sources, shared across tokens, including
unknown tokens. View reads share one budget; tiles have another. Both together
retain at most 10,000 entries. Traffic sweeps expired windows at most once per
second; between sweeps, a new source at capacity evicts the least recently used
entry. The bound holds either way. Eviction starts a fresh window. Readers behind an
untrusted proxy share its socket budget; trusted chains use the nearest
untrusted hop. An IPv6 source is charged with its whole /64, so a host cannot step around a
budget by taking a fresh address from its prefix; an IPv4 source, IPv4-mapped
spellings included, is charged alone, and so is an IPv4 client reaching the
instance through the NAT64 prefix `64:ff9b::/96`, charged as the IPv4 address
it carries. The verified source itself stays the full address. See [self-hosting](what-leaves-the-instance.md) for provenance refusals and scope.

Password derivation admission is shared across the server process: two active,
six ordinary plus two reserved protected waiters, and a five-second maximum
wait. FIFO applies within each class. Validated links and signed-in password
checks are protected, with priority for the next slot and at most one active
protected derivation. Ordinary sign-ins can use both slots. Full classes and
deadlines answer private 503 `authentication_busy` with one-second retry advice,
without adding login failures or a lasting lockout. Running work retains its
slot until settlement. These fixed bounds introduce no configuration knob;
actual derivation time depends on the host.

## Image export

Server-side image export drives the application's own client bundle in a
headless browser inside the container.

The rows of these settings are in the settings tables on [Storage and programs](configuration/storage.md) and [Limits](../api/limits.md#limits-an-operator-changes).

## Geocoding

The rows of these settings are in the settings table on [Data and services](configuration/services.md).

## Travel-time areas

The rows of these settings are in the settings table on [Data and services](configuration/services.md).

## Operations, the background run lane

The rows of these settings are in the settings table on [Limits](../api/limits.md#limits-an-operator-changes).

## The assistant

The in-product assistant is off until a model credential is set. Without one
the surface is simply absent and everything else works unchanged
(`src/lib/assistant/config.ts`).

The rows of these settings are in the settings tables on [Set up the assistant](assistant.md) and [Limits](../api/limits.md#limits-an-operator-changes).

The optional model catalogue file that these settings narrow lives in the data
directory; see [the runbook](backup-and-restore.md#the-model-catalogue-file).

## Platform and image plumbing

These are set by the runtime or the container image, not tuned by a
self-hoster, and the configuration check excludes them by name.

| Variable | Where it is set | Effect |
|---|---|---|
| `PORT` | image sets `3000` | The listening port. Also how the server addresses its own API when it calls itself, for example from the MCP endpoint (`src/lib/self-url.ts`). |
| `HOSTNAME` | image sets `0.0.0.0` | The listening interface. |
| `NODE_ENV` | image sets `production` | Standard Node build mode. |
| `NEXT_RUNTIME` | supplied by the framework | Which runtime a module is executing in. |
| `PATH` | the system | The program search path. A tile builder or an image renderer whose setting names a program rather than a path is looked up there. |
| `DUCKDB_EXTENSION_DIR` | image sets `/app/duckdb-extensions` | The baked engine extension bundle. Overriding it defeats the offline guarantee. |
| `NEXT_TELEMETRY_DISABLED` | image sets `1` | Turns off the framework's own telemetry during build and at runtime. |
| `UV_THREADPOOL_SIZE` | the runtime, 4 unless set before start | The runtime's worker pool, shared by engine calls, file system work and password hashing. PostGIS source calls may hold at most three quarters of it at once (at least one), so blocked source reads always leave a worker for their cancellation and for the rest of the server. Raising it raises that share. |
| `TZ`, `CI` | environment | Excluded by name from the configuration check; the code does not read them as settings. |
