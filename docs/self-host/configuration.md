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
moved_from:
  - "/docs/reference/configuration/"
---

The catalogue defines every deployment setting. Their defaults allow a local
instance to start without deployment configuration. The editable limits, the four
service addresses, the services' gaps, answer limits and freshness, the template
catalogue's address, and the satellite imagery's tile address and credit also
accept stored admin changes,
made on the **Limits**, **Data & services** and **Libraries** tabs of Settings and
marked **App (live) or restart**; **Restart** marks settings changed only through
the environment.
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

## How the configuration tables are checked

This page is checked against `src/lib/settings/catalogue.ts` by
`scripts/check-readme-config.mjs` (`npm run lint:readme`); it is the one place
the settings are listed. The page must
cover every deployment definition exactly once, with no orphan row, and match
its documented default and **Changed by** value. The checker reads the catalogue
itself; it keeps no separate list of settings. It also scans production `src/`
names and the `DEZFIL_TEST_*` reads of the helper scripts and of production
`src/`, and holds this page and the catalogue to those sets in both
directions. The four test-wiring names keep their own coverage check.

Rows start with `` | `NAME` `` and contain the default, effect and **Changed by**
cells. The latter has two values: **Restart**, or **App (live) or restart** for
an editable live setting. Environment changes always require a restart.

The same check holds this page's **Instance defaults** table to the catalogue's
defaults, what new things start with, its **Security and rules** table to
the catalogue's sign-in, token, publishing, connection and import settings, and
its **Libraries** table to the catalogue's basemap switches, and its
**Templates** table to the template catalogue's switch: one row per setting
under the key the change operation takes, no orphan row, and each row's default
as the catalogue documents it.

Two classes are deliberately outside the check: test-local seams
(`DEZFIL_TEST_*` read only by test files in `src/`, and `DEZFIL_BASE_URL`) and
platform plumbing (`NODE_ENV`, `PORT`, `HOSTNAME`, `NEXT_RUNTIME`, `TZ`, `CI`,
`PATH`, `DUCKDB_EXTENSION_DIR`, `UV_THREADPOOL_SIZE`). Both are listed at the
end of this page.

## Instance defaults

What new maps, new layers, the workflow canvas, the SQL console and a fresh
image export card start with. Admins set them on the **Maps**,
**Workflows & SQL** and **Publishing** tabs of Settings, or through
`PATCH /api/instance/settings` under the keys below. Every signed-in account and
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

| Setting | Values | Default | Taken when |
|---|---|---|---|
| `newMap.basemap` | `auto`, `dark`, `light`, `streets`, `satellite` | `auto` | A map is created, by any path. `auto` follows the theme. `satellite` is offered where imagery is set up; a basemap the instance no longer offers starts the map on `auto`. |
| `newMap.latitude` | A number from -85 to 85 | `40` | A map is created: the latitude it opens at. |
| `newMap.longitude` | A number from -180 to 180 | `0` | A map is created: the longitude it opens at. |
| `newMap.zoom` | A number from 0 to 22 | `1.3` | A map is created: the zoom it opens at. |
| `newMap.legendCorner` | `top-left`, `top-right`, `bottom-left`, `bottom-right` | `bottom-left` | A map is created: the corner its legend sits in. At the default the map stores no corner, so the read-only map view keeps its legend top left. |
| `newLayer.colorCycle` | `uber_viz_qualitative`, `bold`, `tab10`, `paired`, `dark2`, `set3` | `uber_viz_qualitative` | A layer is created without a style, or a sketch is drawn: the layer takes the cycle's next color. |
| `newLayer.pointOpacity` | A whole number from 10 to 100, a percentage | `72` | A points layer is created without a style. |
| `newLayer.lineOpacity` | A whole number from 10 to 100, a percentage | `95` | A lines layer is created without a style. |
| `newLayer.areaOpacity` | A whole number from 10 to 100, a percentage | `50` | An areas layer is created without a style. |
| `newLayer.lineWidth` | A number from 0.5 to 50, in pixels | `2` | A lines layer is created without a style. |
| `newLayer.pointRadius` | A number from 0.5 to 100, in pixels | `3` | A layer is created without a style: the radius of its points. |
| `canvas.opens` | `full`, `framed` | `full` | A workflow canvas opens: full screen, or framed in the page. |
| `canvas.minimap` | `auto`, `always`, `never` | `auto` | A workflow canvas opens, until the person chooses in that browser. `auto` shows it from six nodes. |
| `canvas.resultsBand` | `closed`, `open` | `closed` | A workflow canvas opens, until the person chooses in that browser. |
| `sqlConsole.textSize` | `11`, `12`, `13`, `14`, `16`, in pixels | `12` | The SQL console opens: its editor's text size. The other SQL editors stay at 12 pixels. |
| `sqlConsole.lineWrap` | `true` (on) or `false` (off) | off | The SQL console opens: whether its editor wraps long lines. |
| `imageExport.width` | `1280`, `1920`, `2560`, in pixels | `1920` | A fresh image export card opens: its starting width. |
| `imageExport.shape` | `16:9`, `4:3`, `1:1` | `4:3` | A fresh image export card opens: its starting shape. |

A layer created with a style keeps it, and a drawn sketch's layer takes only the
cycle's color. Null clears a stored default, returning it to the value above.

## Security and rules

How long sign-ins and links last, when failed sign-ins pause, the shortest
password, and who may create API tokens, publish, embed published pages, add
database connections and import from links. Admins set the sign-in and token
rows on the **Security** tab of Settings, the publishing rows on the
**Publishing** tab's Public links card, and the connection and link-import
rules on the **Data & services** tab's Connections and imports card; every row
also changes through `PATCH /api/instance/settings` under the keys below. They
are stored instance settings with no
environment variable, so none is ever locked, and each applies as its last
column says, without a restart.

Every signed-in account and agent reads the rules it follows as the `rules`
object of `GET /api/config`: `tokens.create`, `tokens.expiry`,
`publishing.publish`, `publishing.embedding`, `connections.create` and
`imports.links`, keyed and valued as the change operation takes them, with the
shortest password beside it as `passwordMin`. The sign-in entry read carries
`passwordMin` too, 8 before setup. The lifetimes, the sign-in counts and the
listed sites are read by admins alone, through `GET /api/instance/settings`.

| Setting | Values | Default | Applies to |
|---|---|---|---|
| `security.sessionDays` | `1`, `7`, `30`, `90`, in days | `30` | Each session from its next use: a session keeps the expiry it holds and its next use renews it by this length, so no save signs anyone out. |
| `security.linkDays` | `1`, `3`, `7`, `14`, in days | `7` | Invitation and reset links issued after the save; a link keeps the lifetime it was issued with. Command-line recovery links keep fifteen minutes. |
| `security.failedPerAccount` | A whole number from 3 to 100 | `5` | The next sign-in attempt: failed sign-ins for one account within a fixed fifteen minutes before its next attempt pauses. The next current-password check too: wrong current passwords on that account's password and email changes, counted apart from sign-ins, before its next check pauses. Never above `security.failedPerAddress`. |
| `security.failedPerAddress` | A whole number from 10 to 1000 | `20` | The next sign-in attempt: failed sign-ins from one network address within the same fifteen minutes; every IPv6 address of one /64 counts as one address, except that an address in the NAT64 prefix `64:ff9b::/96` counts as the IPv4 address it carries. Never below `security.failedPerAccount`. |
| `security.passwordMin` | A whole number from 8 to 64, in characters | `8` | A password set after the save: at an invitation's or a reset's redemption, or a password change. The first account takes 8, and passwords set earlier keep signing in. |
| `tokens.create` | `everyone`, `admins` | `everyone` | The next API token created. Tokens made earlier keep working. |
| `tokens.expiry` | `never`, `30d`, `90d`, `1y` | `never` | Tokens created after the save, counted from their creation; a token keeps the expiry it was created with. |
| `publishing.publish` | `everyone`, `admins`, `none` | `everyone` | The next publish, or change to a publication (its theme, controls or published fields). `none` stops admins too. Published maps stay public, follow their maps' edits and can be unpublished. |
| `publishing.embedding` | `any`, `listed`, `off` | `any` | Every published page from its next load: `any` lets any site show it in a frame, `listed` only the sites in `publishing.embedSites`, `off` no other site. The link and the map's data are unchanged. |
| `publishing.embedSites` | A list of at most 50 sites, each `http` or `https` with a host and an optional port | none | Published pages while `publishing.embedding` is `listed`, which then needs at least one site. |
| `connections.create` | `everyone`, `admins` | `everyone` | The next database connection added, or a change pointing one at another host, port or database. Testing, browsing, importing, refreshing, renaming, a new password for the same database and deleting keep working. |
| `imports.links` | `everyone`, `admins` | `everyone` | The next import from a web address or cloud storage. Link datasets keep refreshing. |

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
`PATCH /api/instance/settings` under its key below, in the variable's unit; the
tab shows a gap in seconds and how long answers are kept in days (hours for
OpenStreetMap).

| Setting | Variable | Values | On the tab |
|---|---|---|---|
| `geocoderUrl` | `DEZFIL_GEOCODER_URL` | An address | Address finder: Address |
| `geocodePaceMs` | `DEZFIL_GEOCODE_PACE_MS` | 0 to 60,000 milliseconds | Address finder: Gap between requests, in tenths of a second |
| `geocodeRequestTimeoutS` | `DEZFIL_GEOCODE_REQUEST_TIMEOUT_S` | 1 to 120 seconds | Address finder: Answer time limit |
| `geocodeMatchCacheHours` | `DEZFIL_GEOCODE_MATCH_CACHE_HOURS` | 24 to 8,760 hours | Address finder: Keep found addresses for, in days |
| `isochroneUrl` | `DEZFIL_ISOCHRONE_URL` | An address | Travel time: Address |
| `isochronePaceMs` | `DEZFIL_ISOCHRONE_PACE_MS` | 0 to 60,000 milliseconds | Travel time: Gap between requests, in whole seconds |
| `isochroneRequestTimeoutS` | `DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S` | 1 to 120 seconds | Travel time: Answer time limit |
| `isochroneCacheHours` | `DEZFIL_ISOCHRONE_CACHE_HOURS` | 24 to 8,760 hours | Travel time: Keep areas for, in days |
| `overpassUrl` | `DEZFIL_OVERPASS_URL` | An address | OpenStreetMap: Address |
| `overpassTimeoutS` | `DEZFIL_OVERPASS_TIMEOUT_S` | 10 to 900 seconds | OpenStreetMap: Time budget per query |
| `overpassCacheHours` | `DEZFIL_OVERPASS_CACHE_H` | 1 to 720 hours | OpenStreetMap: Keep answers for |
| `s3Endpoint` | `DEZFIL_S3_ENDPOINT` | An address | Cloud storage: S3 address |

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

The five switches below are stored instance settings with no environment
variable, so none is ever locked. Each also changes through
`PATCH /api/instance/settings` under its key, as `true` or `false`, and applies
from the next choice, without a restart. Every signed-in account reads the
basemaps on offer in `GET /api/config`, as `basemaps`, `basemapStyles` and
`singleMapStyles`.

| Setting | Values | Default | Applies to |
|---|---|---|---|
| `basemaps.dark` | `true` (offered) or `false` (hidden) | on | Where a basemap is chosen: the builder's picker, a published page's switcher, the **Maps** tab and a new map's default. Hidden, putting a map on Dark anew is refused with `basemap_not_offered`, by a write or an undo or redo; a map already on it keeps it. Auto keeps following the theme with it either way. |
| `basemaps.light` | `true` (offered) or `false` (hidden) | on | As `basemaps.dark`, for Light. |
| `basemaps.streets` | `true` (offered) or `false` (hidden) | on | As `basemaps.dark`, for Streets. |
| `basemaps.satellite` | `true` (offered) or `false` (hidden) | on | As `basemaps.dark`, for Satellite, which is offered only while imagery is set up and its tile address readable. |
| `basemaps.singleMapStyles` | `true` (allowed) or `false` | on | A style address pasted on a single map. Off, an address the library does not offer is refused with `basemap_not_offered` when a write or an undo or redo would newly put it on a map, admins included; an address a map already holds is kept, and its editor may remove it. |

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

The switch below is a stored instance setting with no environment variable, so
it is never locked. It also changes through `PATCH /api/instance/settings`
under its key, as `true` or `false`, and applies from the next read, without a
restart.

| Setting | Values | Default | Applies to |
|---|---|---|---|
| `templates.catalogue` | `true` (used) or `false` | on | Every read of the catalogue: its list, its pictures and its downloads. Off, the server reaches the catalogue for nothing; the shipped templates and the ones already downloaded still open and copy. |

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

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_DATA_DIR` | ./data; /data in the container | The single durable directory. Back up the complete stopped directory and any external encryption key. `src/lib/config.ts` falls back to `data` under the working directory; the image sets `/data` and declares it a volume. It also holds the optional `assistant-models.json` [model catalogue](backup-and-restore.md#the-model-catalogue-file). | Restart |
| `DEZFIL_SECRET_KEY` | generated | 64 hex characters (32 bytes), the at-rest encryption key for stored connection credentials. Unset, a key is generated into the data directory as `secret.key` on first boot and reused from there (`src/lib/secrets.ts`). A wrong or lost key makes stored credentials unreadable. | Restart |

## Trusted proxies

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_TRUSTED_PROXIES` | unset | Comma-separated IP addresses or CIDRs of reverse proxy socket peers. Only these peers may supply forwarding information. Configure proxies to replace host/protocol/port forwarding fields and append the actual client address; direct clients' forwarding headers are discarded. | Restart |
| `DEZFIL_SESSION_COOKIE` | port-based | Session cookie name: `dezfil_session` on listening port 3000, otherwise `dezfil_session_<port>`. Overrides the name for containers sharing a host. Must be a non-empty HTTP cookie-name token; invalid values stop startup. | Restart |

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

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_UPLOAD_MAX_MB` | `5120` | Size cap for one uploaded file. | App (live) or restart |
| `DEZFIL_DATA_PROCESSING_TIMEOUT_S` | `3600` | Data processing time limit, in seconds, for reception and processing separately. Stored whole seconds from 60 to 21600 apply to newly admitted work; reset with null. A non-empty deployment override locks the row. | App (live) or restart |
| `DEZFIL_REMOTE_MAX_MB` | `2048` | Size cap for one remote import (URL or object store). Deliberately below the upload cap: remote fetches run unattended. | App (live) or restart |
| `DEZFIL_REMOTE_TIMEOUT_S` | `300` | Time bound for one whole remote fetch, redirects and body included. | App (live) or restart |
| `DEZFIL_EGRESS_ALLOWLIST` | unset | Comma-separated hosts, IPs, or CIDRs the server may fetch for a user despite the egress policy. By default loopback, private-network, link-local, and cloud-metadata destinations are refused for every request the policy governs: imports and refreshes from web addresses, cloud storage links read without the server's credentials, database connections, the address finder and place search, travel time, OpenStreetMap, the Overture release list, custom basemap styles, map image exports, the satellite imagery, the satellite imagery's Test and the template catalogue (`src/lib/net/egress.ts`). A loopback Overpass or Overture fixture needs it too. | Restart |
| `DEZFIL_OBJECT_STORE_CREDENTIALS` | off | `1`, `true`, or `yes` signs `s3://`, `gs://`, and `az://` imports with the instance's own credential chain. Off, object-store reads are anonymous, so a user can only read what the public can (`src/lib/ingest/remote.ts`). | Restart |
| `DEZFIL_S3_ENDPOINT` | AWS | S3-compatible endpoint for anonymous `s3://` imports, addressed path-style. | App (live) or restart |
| `DEZFIL_TEMPLATES_CATALOGUE` | `https://github.com/Dezfil/templates/releases/latest/download/index.json` | The template catalogue's index, read by the server; see [Templates](#templates). The variable alone may name a folder on the server instead, read as files under the same checks and never disclosed by its path. | App (live) or restart |

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

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Overpass endpoint for OpenStreetMap imports. Point it at your own instance to escape the public per-IP limits (`src/lib/osm/overpass.ts`). | App (live) or restart |
| `DEZFIL_OVERPASS_TIMEOUT_S` | `60` | Time budget sent with each Overpass query. | App (live) or restart |
| `DEZFIL_OVERPASS_MAXSIZE_MB` | `512` | Response budget sent with each Overpass query; a response over twice this is aborted locally. | Restart |
| `DEZFIL_OVERPASS_CACHE_MB` | `2048` | Overpass response-cache budget, evicted oldest first. | Restart |
| `DEZFIL_OVERPASS_CACHE_H` | `24` | How long a cached Overpass response stays fresh. | App (live) or restart |
| `DEZFIL_OSM_MAX_KM2` | `10000` | Area budget for one OpenStreetMap import. | App (live) or restart |
| `DEZFIL_OVERTURE_MAX_KM2` | `25000` | Area budget for the Overture places theme; other themes scale from it by density. | App (live) or restart |
| `DEZFIL_OVERTURE_S3_ENDPOINT` | unset, the public bucket | S3-compatible endpoint override for Overture reads, path-style. Fits a private mirror of the bucket (`src/lib/overture/releases.ts`). | Restart |

## Query engine

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_QUERY_TIMEOUT_S` | `60` | Time limit for any evaluation of user SQL (the SQL workspace, layer rendering and published views) and for the interactive reads beside it: dataset, geometry and sketch reads, catalogue reads, projection lookup, OpenStreetMap, Overture and PostGIS previews, and PostGIS connection checks. | App (live) or restart |
| `DEZFIL_QUERY_MEMORY_MB` | `2048` | Memory budget of the hardened read-only engine instance, shared by every query on it. A query past it fails with a coded error and the instance keeps serving. | Restart |
| `DEZFIL_TRUSTED_MEMORY_MB` | `3072` | Trusted engine memory, in engine MB, shared across trusted work. Dedicated scratch allowance is four times this value. Fixed without an override; locked with one. Shown on System beside hardened engine memory. | Restart |
| `DEZFIL_PREVIEW_ROWS` | `1000` | Rows returned in a query or preview result. | App (live) or restart |
| `DEZFIL_SLIDER_PREVIEW_ROWS` | `50000` | Source points transferred for an interactive slider preview. | Restart |

## Rendering and tiles

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_RENDER_CAP_FEATURES` | `250000` | Features a single layer renders before the API asks for a limit or an aggregation instead. | Restart |
| `DEZFIL_RENDER_CAP_BYTES` | `134217728` | Bytes drawn per layer (128 MiB): each complete uncompressed UTF-8 JSON inline answer, including its envelope. Equality is admitted. A number written with more than 40 characters (a long literal in a JSON value, an arbitrary-precision integer) must also fit, as its text, in what is left when it is read. Fixed without an override; locked with one. Shown on Limits > Queries. | Restart |
| `DEZFIL_TILE_BUILD_TIMEOUT_S` | `600` | Timeout for each stage of a background tile build. | Restart |
| `DEZFIL_TIPPECANOE` | `tippecanoe` | Path to the tile-building binary (`src/lib/tiles/tiler.ts`). The image installs it on the path. | Restart |
| `DEZFIL_BASEMAP_URL` | built-in styles | A MapLibre style URL that replaces the built-in basemap and pins it in both themes, for instances with no internet access (`src/lib/basemap.ts`). | Restart |
| `DEZFIL_BASEMAP_ATTRIBUTION` | unset | Credit line shown on maps that use `DEZFIL_BASEMAP_URL`. Unset, no credit is shown for the override: the built-in credit would name a provider that is not serving the tiles. | Restart |
| `DEZFIL_SATELLITE_URL` | unset | Raster tile URL template (`{z}/{y}/{x}`) for satellite imagery, with your own key or token in its path or query. The template stays on the server: browsers, a published map's readers among them, load the tiles through the instance, which fetches each one from it. No imagery ships with the app; unset and with no tile address stored on the **Libraries** tab, no imagery basemap is offered at all. A template with a user name or password in it is not drawn and counts as no imagery; the **Libraries** tab says so under the tile address. | App (live) or restart |
| `DEZFIL_SATELLITE_ATTRIBUTION` | unset | Credit line the imagery provider requires, shown on every map using it and stored with anything published from one. An admin can store it on the **Libraries** tab instead. | App (live) or restart |

## Publishing

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_PUBLISH_FRESHNESS_S` | `30` | How stale a published view may be, which is its cache window. | Restart |
| `DEZFIL_PUBLIC_RATE_LIMIT` | `60` | Anonymous published-view requests per ten-second window, per verified source. | App (live) or restart |
| `DEZFIL_PUBLIC_TILE_RATE_LIMIT` | `600` | Anonymous tile requests per ten-second window, per verified source. One pan is dozens of tiles, so tiles get their own, larger bucket (`src/lib/publish/rate-limit.ts`). | App (live) or restart |

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

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_CHROMIUM_PATH` | `/usr/bin/chromium` | The headless browser binary. The image bakes one in and sets this variable. | Restart |
| `DEZFIL_EXPORT_RENDER_TIMEOUT_S` | `90` | Budget for one render, queue wait included. | App (live) or restart |
| `DEZFIL_EXPORT_REQUEST_TIMEOUT_S` | `20` | Bound on an external render request. After the request burst settles and app-origin requests finish, the relay ends its current sockets, including worker fetches, and refuses re-dials only to the stalled hosts for the rest of that render. The image is still produced with the available content. Requests with no terminal event stay armed for another cut after the same bound. The response reports the abandonment count and hosts, counting repeated cuts again. App-origin requests retain the whole render budget. | Restart |
| `DEZFIL_EXPORT_RENDER_CONCURRENCY` | `2` | Concurrent renders. Software rendering is CPU-expensive, so work past the cap waits inside the budget. | App (live) or restart |

## Geocoding

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_GEOCODER_URL` | unset | A Nominatim-compatible `/search` endpoint, used by place search in the builder and by the batch geocoding operation. Unset, search still answers layers, values, and coordinates, and the geocode operation is not offered. The URL stays server-side, so it may carry a key. | App (live) or restart |
| `DEZFIL_GEOCODE_PACE_MS` | `1000` | Minimum gap between two requests to that endpoint, enforced across the whole instance with one request in flight at a time. `0` means no gap. | App (live) or restart |
| `DEZFIL_GEOCODE_REQUEST_TIMEOUT_S` | `10` | Deadline for one geocoding exchange. A batch row costs the pace or this, whichever is longer, so both bound the batch size the operation accepts. | App (live) or restart |
| `DEZFIL_GEOCODE_MATCH_CACHE_HOURS` | `720` | How long a matched address is kept. | App (live) or restart |
| `DEZFIL_GEOCODE_NO_MATCH_CACHE_HOURS` | `24` | How long a no-match is kept, shorter because that is what improves when provider data does. | Restart |
| `DEZFIL_GEOCODE_CACHE_MB` | `64` | Size budget for the geocode answer cache, evicted oldest first. | Restart |

## Travel-time areas

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_ISOCHRONE_URL` | unset | A Valhalla-compatible `/isochrone` endpoint. Unset, the operation stays visible and refuses with a sentence naming this setting (`src/lib/isochrone/endpoint.ts`). | App (live) or restart |
| `DEZFIL_ISOCHRONE_PACE_MS` | `1000` | Milliseconds between isochrone requests, one exchange in flight at a time. | App (live) or restart |
| `DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S` | `20` | Whole-exchange deadline for one request. Routing answers slower than geocoding. | App (live) or restart |
| `DEZFIL_ISOCHRONE_CACHE_HOURS` | `168` | How long a fully answered isochrone is kept. Only complete answers are cached. | App (live) or restart |
| `DEZFIL_ISOCHRONE_CACHE_MB` | `64` | Size budget for that cache, evicted oldest first. | Restart |

## Operations, the background run lane

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_OPERATION_TIMEOUT_S` | `600` | Execution budget for one operation run. Time spent waiting for the lane is not charged against it. | App (live) or restart |
| `DEZFIL_OPERATION_CONCURRENCY` | `1` | Operations executing at once. They are heavy work on the shared engine, so work past the cap queues. | App (live) or restart |
| `DEZFIL_OPERATION_QUEUE_MAX` | `20` | Runs that may wait for the lane. A run arriving at a full queue is refused with a coded error. | App (live) or restart |
| `DEZFIL_OPERATION_HISTORY_PER_SUBJECT` | `20` | Runs kept per subject. The subject's most recent success is preserved inside that depth. | Restart |

## The assistant

The in-product assistant is off until a model credential is set. Without one
the surface is simply absent and everything else works unchanged
(`src/lib/assistant/config.ts`).

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Enables the assistant with Anthropic. | Restart |
| `OPENAI_API_KEY` | unset | Enables the assistant with OpenAI. | Restart |
| `DEZFIL_AI_PROVIDER` | first key set | `anthropic` or `openai`, when both keys are present. An unknown value leaves the assistant disabled with an explanatory reason. | Restart |
| `DEZFIL_AI_MODEL` | provider default | Overrides the model. Defaults are `claude-opus-5` for Anthropic and `gpt-5.6-terra` for OpenAI. | Restart |
| `DEZFIL_AI_MODELS_ANTHROPIC` | unset | Comma-separated model identities narrowing and ordering what a person may choose. Unset offers the effective [catalogue](backup-and-restore.md#the-model-catalogue-file). The instance default is always present exactly once. Only the resolved provider's list applies. | Restart |
| `DEZFIL_AI_MODELS_OPENAI` | unset | The same, for OpenAI. See the [catalogue instructions](backup-and-restore.md#the-model-catalogue-file). | Restart |
| `DEZFIL_ASSISTANT_STEP_BUDGET` | `20` | Maximum model and tool steps one assistant request may take. | Restart |
| `DEZFIL_ASSISTANT_OFFER` | `subset` | Which operations a page's run is offered at the start: `subset` (that page's operations plus the grounding reads, the rest reachable through a discovery tool) or `full` (every operation the page admits, no discovery tool). Any other value reads as `subset` (`src/lib/assistant/offer.ts`). | Restart |
| `DEZFIL_ASSISTANT_AUTO_CHECK` | on | Whether the assistant looks at the rendered map by itself after a turn that changed it. `0`, `false`, or `off` turns it off; an explicit check stays available. | Restart |
| `DEZFIL_ASSISTANT_LOOK_TIMEOUT_S` | `30` | Budget for that map check, request to response. | Restart |
| `DEZFIL_ASSISTANT_LOOK_RETENTION` | `256` | Renders of the map check kept in process for the transcript, full images and thumbnails counted together, oldest evicted first. They are gone when the process restarts. | Restart |
| `DEZFIL_ASSISTANT_LOOK_RETENTION_MB` | `96` | Byte budget for those retained renders. | Restart |
| `DEZFIL_TOOL_ATTACHMENT_MAX_MB` | `32` | Cap on a download answered to an agent tool. Past it the tool gets a coded error instead. | Restart |

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

## Test and development wiring

Read by test files, end-to-end specs, and helper scripts, never by the
server as a setting. They are listed here so nobody mistakes one
for a tunable. All four names and their defaults are checked here:

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_TEST_PG_URL` | unset | Test/probe process only: disposable PostGIS fixture URL for live source tests and the full result-budget probe. Never read by the product server. | Restart |
| `DEZFIL_TEST_PUBLICATION_LOG` | unset | Test preload only: NDJSON destination for per-admission published-source state. Required by `scripts/publication-observer.mjs`; no effect without that preload. | Restart |
| `DEZFIL_TEST_DERIVATION_LOG` | unset | Test preload only: NDJSON destination for native derivation starts, completions and admission occupancy. Required by `scripts/derivation-observer.mjs`; no effect without that preload. | Restart |
| `DEZFIL_TEST_EXTENSION_REPOSITORY` | unset | Tests only: a loopback extension repository the engine that runs people's SQL installs from, so a test that lets it install an extension reaches a fixture that records the request, never the internet. Never set in a deployment. | Restart |

- `DEZFIL_BASE_URL`: the target address for the browser test runner and the
  headless journey scripts.
- `DEZFIL_E2E_FIRST_RUN=1`: leaves account setup to the first-run browser
  journey on an empty scratch store instead of provisioning a signed-in fixture.
- `DEZFIL_TEST_PG_TLS_URL`, `DEZFIL_TEST_OVERTURE`,
  `DEZFIL_TEST_TILER_LOG`, `DEZFIL_TEST_TILER_RELEASE`,
  `DEZFIL_TEST_TILER_STARTED`: fixture endpoints and stub seams for the unit
  suites.
- `DEZFIL_E2E_ASSISTANT`, `DEZFIL_E2E_LISTEN_PORT`, `DEZFIL_E2E_SELF_PORT`,
  `DEZFIL_E2E_RENDER_STUB`, `DEZFIL_DEBUG_PNG`: switches for the browser
  suite.
- `DEZFIL_ASSISTANT_LIVE`, `DEZFIL_RESTART_CHILD`, `DEZFIL_STREAM_EVIDENCE`,
  `DEZFIL_GEOMETRY_TILER_RELEASE`, `DEZFIL_GEOMETRY_TILER_STARTED`: opt-in
  arms and seams inside individual unit test files.
- `DEZFIL_MCP_PROBE_LOG`, `DEZFIL_PLUGIN_RENDER_LOG`: log destinations for
  the helper scripts under `scripts/` that drive the agent surfaces.

A handful of further `DEZFIL_`-prefixed names appear inside individual test
files and inside the performance harness under `scripts/perf/`, where they
select an optional arm or name an output file. They are local to the file
that reads them and are not part of the settings surface. The configuration check
does not see them, because it scans non-test source files under `src` and only `DEZFIL_TEST_*`
reads in helper scripts and in those source files.
