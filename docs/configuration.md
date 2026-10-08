# Configuration

The catalogue defines every deployment setting. Their defaults allow a local
instance to start without deployment configuration. The editable limits also accept
stored admin changes, made on the **Limits** tab of Settings and marked **App (live)
or restart**; **Restart** marks settings changed only through the environment.
`GET /api/instance/settings` reports the effective configuration, sources and
locks to admins.

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
import; see [Security and rules](#security-and-rules). These are not
environment variables.

The optional `assistant-models.json` in the data directory supplies the model
catalogue; environment model lists narrow its offer. It is a file, not an account
preference. Its reload and validation rules are in
[the runbook](runbook.md#the-model-catalogue-file). Edit revisions and stale-save
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

Both this page and the **Configuration** table in [README.md](../README.md)
are checked against `src/lib/settings/catalogue.ts` by
`scripts/check-readme-config.mjs` (`npm run lint:readme`). Each document must
cover every deployment definition exactly once, with no orphan row, and match
its documented default and **Changed by** value. The checker reads the catalogue
itself; it keeps no separate list of settings. It also scans production `src/`
names and script `DEZFIL_TEST_*` reads, and holds both documents and the catalogue
to those sets in both directions. The three test-wiring names keep their own
coverage check.

Rows start with `` | `NAME` `` and contain the default, effect and **Changed by**
cells. The latter has two values: **Restart**, or **App (live) or restart** for
an editable live setting. Environment changes always require a restart.

The same check holds this page's **Instance defaults** table to the catalogue's
defaults, what new things start with, and its **Security and rules** table to
the catalogue's sign-in, token, publishing, connection and import settings: one
row per setting under the key the change operation takes, no orphan row, and
each row's default as the catalogue documents it.

Two classes are deliberately outside the check: source-local test seams
(`DEZFIL_TEST_*` in `src/` and `DEZFIL_BASE_URL`) and platform plumbing (`NODE_ENV`, `PORT`, `HOSTNAME`,
`NEXT_RUNTIME`, `TZ`, `CI`, `DUCKDB_EXTENSION_DIR`). Both are listed at the
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
rows on the **Security** tab of Settings and the publishing rows on the
**Publishing** tab's Public links card; every row also changes through
`PATCH /api/instance/settings` under the keys below, the connection and
link-import rules only there. They are stored instance settings with no
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
| `security.failedPerAccount` | A whole number from 3 to 100 | `5` | The next sign-in attempt: failed sign-ins for one account within a fixed fifteen minutes before its next attempt pauses. Never above `security.failedPerAddress`. |
| `security.failedPerAddress` | A whole number from 10 to 1000 | `20` | The next sign-in attempt: failed sign-ins from one network address within the same fifteen minutes. Never below `security.failedPerAccount`. |
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

A rule refuses new reach and takes nothing away. An action it refuses answers
`403 rule_refused`, with `error.rule` naming the rule, and changes nothing; the
screens show that action disabled with the same sentence. A token past its
expiry answers `401 token_expired` and stays listed until revoked. Under
`listed` or `off`, a published page's answer carries
`Content-Security-Policy: frame-ancestors` with the listed sites, or `'none'`;
under `any` it carries none, and the published data answers never carry one.

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
results above both ceilings. A refused dataset inspection prevents its detail and docked set-geometry
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
| `DEZFIL_DATA_DIR` | ./data; /data in the container | The single durable directory. Back up the complete stopped directory and any external encryption key. `src/lib/config.ts` falls back to `data` under the working directory; the image sets `/data` and declares it a volume. | Restart |
| `DEZFIL_SECRET_KEY` | generated | 64 hex characters (32 bytes), the at-rest encryption key for stored connection credentials. Unset, a key is generated into the data directory as `secret.key` on first boot and reused from there (`src/lib/secrets.ts`). A wrong or lost key makes stored credentials unreadable. | Restart |

## Trusted proxies

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_TRUSTED_PROXIES` | unset | Comma-separated IP addresses or CIDRs of reverse proxy socket peers. Only these peers may supply forwarding information. Configure proxies to replace host/protocol/port forwarding fields and append the actual client address; direct clients' forwarding headers are discarded. | Restart |

## Request body admission

JSON admission has fixed outer byte tiers: 65,536 bytes for authentication
entry, Account, Users, instance settings and the three anonymous published POSTs; 16,777,216 for
other JSON, including MCP and workflows; assistant messages retain 131,072.
Excess returns 413 with the operation's documented error. Optional bodies,
escaping and UTF-8 bytes count too. Render selections remain in the small tier
even when their filters satisfy the semantic limits. MCP's base64 envelope
makes a raw upload smaller than 12 MiB; see [the MCP guide](mcp.md).
Multipart uploads stream to disk under the separate file/archive caps.

The fixed `experimental.proxyClientMaxBodySize` in `next.config.ts` is
17 MiB (17,825,792 bytes), allowing the 16 MiB JSON boundary to reach its reader.
Matched paths still drain and copy up to that limit before the gate, including
anonymous callers. A fronting reverse proxy's own request-size limit bounds
that residual copy further. Canonical spellings of `/api/tables` and the public
widget-values, render and extent POST paths bypass the copy and preserve their
handler-side gates. The native door returns an
empty 400 for `TRACE`. See [self-hosting](self-hosting.md) for the wire
behavior and [the API guide](api.md#request-bounds) for exact refusals.

## Upload and remote import

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_UPLOAD_MAX_MB` | `5120` | Size cap for one uploaded file. | App (live) or restart |
| `DEZFIL_REMOTE_MAX_MB` | `2048` | Size cap for one remote import (URL or object store). Deliberately below the upload cap: remote fetches run unattended. | App (live) or restart |
| `DEZFIL_REMOTE_TIMEOUT_S` | `300` | Time bound for one whole remote fetch, redirects and body included. | App (live) or restart |
| `DEZFIL_EGRESS_ALLOWLIST` | unset | Comma-separated hosts, IPs, or CIDRs the server may fetch for a user despite the egress policy. By default loopback, private-network, link-local, and cloud-metadata destinations are refused on URL imports and database connections (`src/lib/net/egress.ts`). | Restart |
| `DEZFIL_OBJECT_STORE_CREDENTIALS` | off | `1`, `true`, or `yes` signs `s3://`, `gs://`, and `az://` imports with the instance's own credential chain. Off, object-store reads are anonymous, so a user can only read what the public can (`src/lib/ingest/remote.ts`). | Restart |
| `DEZFIL_S3_ENDPOINT` | AWS | S3-compatible endpoint for anonymous `s3://` imports, addressed path-style. | Restart |

## Open data providers

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Overpass endpoint for OpenStreetMap imports. Point it at your own instance to escape the public per-IP limits (`src/lib/osm/overpass.ts`). | Restart |
| `DEZFIL_OVERPASS_TIMEOUT_S` | `60` | Time budget sent with each Overpass query. | Restart |
| `DEZFIL_OVERPASS_MAXSIZE_MB` | `512` | Response budget sent with each Overpass query; a response over twice this is aborted locally. | Restart |
| `DEZFIL_OVERPASS_CACHE_MB` | `2048` | Overpass response-cache budget, evicted oldest first. | Restart |
| `DEZFIL_OVERPASS_CACHE_H` | `24` | How long a cached Overpass response stays fresh. | Restart |
| `DEZFIL_OSM_MAX_KM2` | `10000` | Area budget for one OpenStreetMap import. | App (live) or restart |
| `DEZFIL_OVERTURE_MAX_KM2` | `25000` | Area budget for the Overture places theme; other themes scale from it by density. | App (live) or restart |
| `DEZFIL_OVERTURE_S3_ENDPOINT` | unset, the public bucket | S3-compatible endpoint override for Overture reads, path-style. Fits a private mirror of the bucket (`src/lib/overture/releases.ts`). | Restart |

## Query engine

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_QUERY_TIMEOUT_S` | `60` | Timeout for any evaluation of user SQL: the SQL workspace, layer rendering, and published views alike. | App (live) or restart |
| `DEZFIL_QUERY_MEMORY_MB` | `2048` | Memory budget of the hardened read-only engine instance, shared by every query on it. A query past it fails with a coded error and the instance keeps serving. | Restart |
| `DEZFIL_PREVIEW_ROWS` | `1000` | Rows returned in a query or preview result. | App (live) or restart |
| `DEZFIL_SLIDER_PREVIEW_ROWS` | `50000` | Source points transferred for an interactive slider preview. | Restart |

## Rendering and tiles

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_RENDER_CAP_FEATURES` | `250000` | Features a single layer renders before the API asks for a limit or an aggregation instead. | Restart |
| `DEZFIL_TILE_BUILD_TIMEOUT_S` | `600` | Timeout for each stage of a background tile build. | Restart |
| `DEZFIL_TIPPECANOE` | `tippecanoe` | Path to the tile-building binary (`src/lib/tiles/tiler.ts`). The image installs it on the path. | Restart |
| `DEZFIL_BASEMAP_URL` | built-in styles | A MapLibre style URL that replaces the built-in basemap and pins it in both themes, for instances with no internet access (`src/lib/basemap.ts`). | Restart |
| `DEZFIL_BASEMAP_ATTRIBUTION` | unset | Credit line shown on maps that use `DEZFIL_BASEMAP_URL`. Unset, no credit is shown for the override: the built-in credit would name a provider that is not serving the tiles. | Restart |
| `DEZFIL_SATELLITE_URL` | unset | Raster tile URL template (`{z}/{y}/{x}`) for satellite imagery, with your own key or token. No imagery ships with the app; unset, no imagery basemap is offered at all. | Restart |
| `DEZFIL_SATELLITE_ATTRIBUTION` | unset | Credit line the imagery provider requires, shown on every map using it and stored with anything published from one. | Restart |

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
untrusted hop. See [self-hosting](self-hosting.md) for provenance refusals and scope.

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
| `DEZFIL_EXPORT_REQUEST_TIMEOUT_S` | `20` | Bound on any single request the render page makes. A slower one is abandoned, the image is still produced, and the response reports how many were dropped and from which hosts. | Restart |
| `DEZFIL_EXPORT_RENDER_CONCURRENCY` | `2` | Concurrent renders. Software rendering is CPU-expensive, so work past the cap waits inside the budget. | App (live) or restart |

## Geocoding

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_GEOCODER_URL` | unset | A Nominatim-compatible `/search` endpoint, used by place search in the builder and by the batch geocoding operation. Unset, search still answers layers, values, and coordinates, and the geocode operation is not offered. The URL stays server-side, so it may carry a key. | Restart |
| `DEZFIL_GEOCODE_PACE_MS` | `1000` | Minimum gap between two requests to that endpoint, enforced across the whole instance with one request in flight at a time. `0` means no gap. | Restart |
| `DEZFIL_GEOCODE_REQUEST_TIMEOUT_S` | `10` | Deadline for one geocoding exchange. A batch row costs the pace or this, whichever is longer, so both bound the batch size the operation accepts. | Restart |
| `DEZFIL_GEOCODE_MATCH_CACHE_HOURS` | `720` | How long a matched address is kept. | Restart |
| `DEZFIL_GEOCODE_NO_MATCH_CACHE_HOURS` | `24` | How long a no-match is kept, shorter because that is what improves when provider data does. | Restart |
| `DEZFIL_GEOCODE_CACHE_MB` | `64` | Size budget for the geocode answer cache, evicted oldest first. | Restart |

## Travel-time areas

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_ISOCHRONE_URL` | unset | A Valhalla-compatible `/isochrone` endpoint. Unset, the operation stays visible and refuses with a sentence naming this setting (`src/lib/isochrone/endpoint.ts`). | Restart |
| `DEZFIL_ISOCHRONE_PACE_MS` | `1000` | Milliseconds between isochrone requests, one exchange in flight at a time. | Restart |
| `DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S` | `20` | Whole-exchange deadline for one request. Routing answers slower than geocoding. | Restart |
| `DEZFIL_ISOCHRONE_CACHE_HOURS` | `168` | How long a fully answered isochrone is kept. Only complete answers are cached. | Restart |
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
| `DEZFIL_AI_MODELS_ANTHROPIC` | unset | Comma-separated model identities narrowing and ordering what a person may choose. Unset offers the effective catalogue. The instance default is always present exactly once. Only the resolved provider's list applies. | Restart |
| `DEZFIL_AI_MODELS_OPENAI` | unset | The same, for OpenAI. | Restart |
| `DEZFIL_ASSISTANT_STEP_BUDGET` | `20` | Maximum model and tool steps one assistant request may take. | Restart |
| `DEZFIL_ASSISTANT_OFFER` | `subset` | Which operations a page's run is offered at the start: `subset` (that page's operations plus the grounding reads, the rest reachable through a discovery tool) or `full` (every operation the page admits, no discovery tool). Any other value reads as `subset` (`src/lib/assistant/offer.ts`). | Restart |
| `DEZFIL_ASSISTANT_AUTO_CHECK` | on | Whether the assistant looks at the rendered map by itself after a turn that changed it. `0`, `false`, or `off` turns it off; an explicit check stays available. | Restart |
| `DEZFIL_ASSISTANT_LOOK_TIMEOUT_S` | `30` | Budget for that map check, request to response. | Restart |
| `DEZFIL_ASSISTANT_LOOK_RETENTION` | `256` | Renders of the map check kept in process for the transcript, full images and thumbnails counted together, oldest evicted first. They are gone when the process restarts. | Restart |
| `DEZFIL_ASSISTANT_LOOK_RETENTION_MB` | `96` | Byte budget for those retained renders. | Restart |
| `DEZFIL_TOOL_ATTACHMENT_MAX_MB` | `32` | Cap on a download answered to an agent tool. Past it the tool gets a coded error instead. | Restart |

The optional model catalogue file that these settings narrow lives in the data
directory; see [the runbook](runbook.md#the-model-catalogue-file).

## Platform and image plumbing

These are set by the runtime or the container image, not tuned by a
self-hoster, and the README check excludes them by name.

| Variable | Where it is set | Effect |
|---|---|---|
| `PORT` | image sets `3000` | The listening port. Also how the server addresses its own API when it calls itself, for example from the MCP endpoint (`src/lib/self-url.ts`). |
| `HOSTNAME` | image sets `0.0.0.0` | The listening interface. |
| `NODE_ENV` | image sets `production` | Standard Node build mode. |
| `NEXT_RUNTIME` | supplied by the framework | Which runtime a module is executing in. |
| `DUCKDB_EXTENSION_DIR` | image sets `/app/duckdb-extensions` | The baked engine extension bundle. Overriding it defeats the offline guarantee. |
| `NEXT_TELEMETRY_DISABLED` | image sets `1` | Turns off the framework's own telemetry during build and at runtime. |
| `TZ`, `CI` | environment | Excluded by name from the README check; the code does not read them as settings. |

## Test and development wiring

Read by test files, end-to-end specs, and helper scripts, never by the
server as a setting. They are listed here so nobody mistakes one
for a tunable. All three names and their defaults are checked in both guides:

| Variable | Default | Effect | Changed by |
|---|---|---|---|
| `DEZFIL_TEST_PG_URL` | unset | Test/probe process only: disposable PostGIS fixture URL for live source tests and the full result-budget probe. Never read by the product server. | Restart |
| `DEZFIL_TEST_PUBLICATION_LOG` | unset | Test preload only: NDJSON destination for per-admission published-source state. Required by `scripts/publication-observer.mjs`; no effect without that preload. | Restart |
| `DEZFIL_TEST_DERIVATION_LOG` | unset | Test preload only: NDJSON destination for native derivation starts, completions and admission occupancy. Required by `scripts/derivation-observer.mjs`; no effect without that preload. | Restart |

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
that reads them and are not part of the settings surface. The README check
does not see them, because it scans non-test source files under `src` and only `DEZFIL_TEST_*`
reads in helper scripts.
