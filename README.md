# Dezfil

Self-hosted spatial SQL and map publishing, powered by DuckDB and files.
Upload geospatial data, query it with SQL, style it on a map, publish a
shareable view — from one container.

> Status: pre-release, under active development.

## Run it

For development, with live reload:

```sh
npm ci
npm run dev
```

Open <http://localhost:3000>.

With Docker installed:

```sh
docker build -t dezfil .
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data dezfil
```

Open <http://localhost:3000>. The instance reports readiness at
`/api/health`.

Everything Dezfil stores, including accounts, sessions, token records, tables,
maps, layers, styles and published links,
lives in the `/data` volume (`dezfil-data` above). Back up by copying that
volume with the container stopped; move to a new container by mounting the
same volume. To move to another machine, stop the container and copy the
whole directory and preserve any externally supplied `DEZFIL_SECRET_KEY`. Running without
the volume works, but state then lasts only for that container's lifetime.

On first run, create the initial admin account. Application pages and APIs
require a session or an account API token; admins manage accounts in Users,
and the instance name, the sign-in page, the defaults for new maps, layers and
screens, the basemaps on offer, the satellite imagery and the saved palettes,
the limits, the services' addresses and numbers, and the sign-in, token,
publishing, connection and import rules in Settings.
Each person picks their own look on the **Appearance** tab of Settings: color,
contrast, panels (Glass, Liquid or Paper), background, typeface, corners and how
the side menu opens. The look is kept with the account, so it shows from the
first paint in every browser that account signs in to; published pages and
exported images keep Dezfil's default look.
Each account's maps, datasets, workflows, connections and projects are private,
including from admins, until a project's owner shares the project: its people
then reach everything filed in it, as viewers or editors.
Connections are never shared. Dataset and connection names belong to that
account's space; SQL names another person's dataset `<sql name>.<dataset>`.
Basemap, palette, operation and model catalogues remain shared; any signed-in
account can save or delete a custom palette. Published links remain readable without an account,
as do embeds on the sites the instance allows, and the readiness probe. An instance upgraded from a release without accounts
also shows setup once. Secure new and upgraded instances until you complete setup,
and complete it promptly: whoever reaches setup first becomes the admin.

**Templates**, last in the side menu, shows every signed-in account the
finished maps and workflow examples the instance offers: the ones shipped in
the image first, then those the template catalogue lists, each card with its
picture (a workflow example's graph, its tools on a line of their own), its
place, the date of its data, its question, its tags and its sources' names
(each source's credit and licence on hover), and for one not yet on the
server the size its first open downloads. A search box narrows
the cards by title, question, place and credit, and the tag chips by tag, each
chip counting the search's matches. The page draws what the server already
holds at once and reads the catalogue after; while the catalogue is off, does
not answer, lists nothing or is refused, one line says why only the templates
on the server show. The image ships three, which open and copy with no
network: the maps *Forty years of big earthquakes* and *The world's air
routes*, and the workflow example *Health access in Rwanda*. [NOTICE](NOTICE)
lists their data's sources, licences and credits.

Opening a template shows the version its card named, read only: a map as a
map one may only view opens, a workflow example's canvas as a viewer sees it
with no run, and beside either **How it's made**, with the question, each
dataset's source, licence, credit and date, the workflow's steps, each layer's
SQL and style, and the styling choices. A version not yet on the server
downloads first. A template's address can be shared: one this server has not
listed yet has the catalogue read before the page answers. **Make a copy** is the page's one action, and a card's too:
its dialog names the version it copies, proposes the title as the new
project's name and says what comes and its size. Confirming downloads that
version if it is not on the server yet, copies it into a new project of your
own and opens its map in the builder (a workflow example: its canvas), where
each output that came with the copy says so until its first run.

Existing work belongs to the recorded original account after an upgrade.
Read the [ownership upgrade instructions](docs/runbook.md#upgrading-ownership-storage)
before updating. SQL uses your imported datasets by name. Direct file reads
and file-referencing projection definitions are refused, including in saved
queries and published layers; ordinary EPSG transforms remain supported.

Create a personal token on the **Tokens** tab of Settings, under
**API / MCP tokens**, for a script or agent. Copy its secret once; it cannot be
read back. REST and MCP calls use that account's current permissions. Revoking a token stops both. See the
[MCP guide](docs/mcp.md) for client setup and the [API guide](docs/api.md) for
ordered writes.

Maps and workflows refuse a save based on an older edit revision, even from
another tab signed into the same account. Unsaved values remain visible. Reload
offers text copying before discarding the draft and reading current work; it does
not merge or replay the refused edit. Saved camera moves remain independent.
Last-change labels identify the person who changed the document; ownership is a
separate fact. Project sharing gives Viewers read access and Editors map/workflow
editing and run access. Publication, deletion and transfer remain the owner's.

Viewers and Editors can leave a project; their owned work stays filed and shared.
Another active admin can permanently delete an account after deactivation. Leave
it deactivated to keep shared work. Deletion breaks owned publications, dissolves
owned projects and keeps the identifying SQL name reserved. Finish deleting resumes
unfinished cleanup after restart. Read the [host guide's measured pause, required
space and retained-copy limits](docs/self-hosting.md#leaving-and-deleting-accounts)
before using it.

## Configuration

Every deployment setting below is optional; pass them as `-e NAME=value`
on `docker run`. The editable limits, the four service addresses, the
services' gaps, answer limits and freshness, the template catalogue's address,
and the satellite imagery's tile address and credit also accept stored admin
changes, marked
**App (live) or restart**, made on the **Limits**, **Data & services** and
**Libraries** tabs of Settings; a setting its variable sets shows locked there,
naming the variable. A stored address is kept encrypted and reads back as its
scheme and host alone. The **System** tab shows each part of the server (the data
folder, the query engine, the tile builder, the image renderer and the
metadata database) with a Test, what the data folder holds by kind with Clear
all for the service caches, and every setting a variable decides, with the
value in effect and its source. The test-wiring rows are for probe processes
and tests. `GET /api/instance/settings` reports the effective configuration to
admins.
Account and instance preferences persist in the data directory, alongside the
optional model catalogue file. See [configuration](docs/configuration.md).

For an instance setting, a non-empty deployment variable wins and locks app
changes, including clearing a stored value. Changing any environment variable
requires a restart. An accepted variable supplies its normalized value; an
invalid numeric variable keeps the setting locked and uses the built-in default.
With no variable (an empty numeric variable counts as absent), the stored value
wins, then the default. Shadowed stored values stay saved and apply after the
variable is removed and the process restarted. Admin changes through
`PATCH /api/instance/settings` apply live to new work; admitted work retains its
budget. Settings without a variable are never locked.
How long sign-ins and links last, the shortest password, and who may create
tokens, publish, embed, add database connections and import from links have no
variable: admins set them on the **Security**, **Publishing** and
**Data & services** tabs or through
`PATCH /api/instance/settings`, as [Security and rules](docs/configuration.md#security-and-rules)
lists. Which basemaps are offered where one is chosen, and whether a single map
may take a style address the library does not offer, have no variable either:
admins switch them on the **Libraries** tab, which also keeps the basemap
library and the saved palettes, as [Libraries](docs/configuration.md#libraries)
lists. Whether the server reads the template catalogue has no variable either:
admins switch it on the **Data & services** tab, whose Templates card also
holds the catalogue's address, its Test and Remove all for the downloaded
templates, as [Templates](docs/configuration.md#templates) says.

| Setting | Default | What it controls | Changed by |
|---|---|---|---|
| `DEZFIL_DATA_DIR` | ./data; /data in the container | Durable data directory (the mounted volume), including the optional `assistant-models.json` [model catalogue](docs/runbook.md#the-model-catalogue-file). | Restart |
| `DEZFIL_TRUSTED_PROXIES` | unset | Comma-separated IP addresses or CIDRs of reverse proxy socket peers. Only these peers may supply forwarding information. Configure proxies to replace host/protocol/port forwarding fields and append the actual client address. Direct clients' forwarding headers are discarded. | Restart |
| `DEZFIL_SESSION_COOKIE` | port-based | Session cookie name: `dezfil_session` on listening port 3000, otherwise `dezfil_session_<port>`. Overrides the name for containers sharing a host. Must be a non-empty HTTP cookie-name token; invalid values stop startup. | Restart |
| `DEZFIL_UPLOAD_MAX_MB` | `5120` | Upload size cap, in MB. | App (live) or restart |
| `DEZFIL_DATA_PROCESSING_TIMEOUT_S` | `3600` | Data processing time limit, in seconds, for reception and processing separately. Stored whole seconds from 60 to 21600 apply to newly admitted work; reset with null. A non-empty deployment override locks the row. | App (live) or restart |
| `DEZFIL_EGRESS_ALLOWLIST` | unset | Hosts, IPs, or CIDRs the server may fetch for a user despite the egress policy. By default, loopback, private-network, link-local, and cloud-metadata destinations are blocked for every request the policy governs: URL imports and anonymous cloud storage links, PostGIS connections, the address finder, travel time, OpenStreetMap, the Overture release list, custom basemap styles, map image exports, the satellite imagery's Test and the template catalogue. | Restart |
| `DEZFIL_REMOTE_TIMEOUT_S` | `300` | Time bound for one whole remote fetch (URL and object-store imports), redirects and body included. | App (live) or restart |
| `DEZFIL_REMOTE_MAX_MB` | `2048` | Size cap for one remote import (URL and object-store), in MB. | App (live) or restart |
| `DEZFIL_OBJECT_STORE_CREDENTIALS` | off | Opt-in (`true`): sign `s3://`/`gs://`/`az://` imports with the instance's own credential chain. Off, object-store reads are anonymous — users can only read what the public can. | Restart |
| `DEZFIL_S3_ENDPOINT` | AWS | Custom S3-compatible endpoint (MinIO and friends) for anonymous `s3://` imports, addressed path-style. | App (live) or restart |
| `DEZFIL_OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Overpass endpoint for OSM imports. Point it at your own instance to escape the public per-IP limits. | App (live) or restart |
| `DEZFIL_TEMPLATES_CATALOGUE` | `https://github.com/Dezfil/templates/releases/latest/download/index.json` | The template catalogue's index, read by the server. The variable alone may name a folder on the server instead, holding an index and the archives and pictures it names, read as files under the same checks; every read says a folder, never which. | App (live) or restart |
| `DEZFIL_OVERTURE_S3_ENDPOINT` | unset, the public bucket | S3-compatible endpoint override for Overture reads (path-style, plain http). The test seam behind the browser suite's Overture drive; also fits a private mirror of the bucket. | Restart |
| `DEZFIL_OVERPASS_TIMEOUT_S` | `60` | Server-side time budget passed with each Overpass query. | App (live) or restart |
| `DEZFIL_OVERPASS_MAXSIZE_MB` | `512` | Response budget passed with each Overpass query; a response over twice this aborts locally. | Restart |
| `DEZFIL_OVERPASS_CACHE_MB` | `2048` | Overpass response-cache budget; oldest entries are evicted past it, expired ones on sight. | Restart |
| `DEZFIL_OVERPASS_CACHE_H` | `24` | How long a cached Overpass response stays fresh, in hours. | App (live) or restart |
| `DEZFIL_OSM_MAX_KM2` | `10000` | OSM import area budget, in km². | App (live) or restart |
| `DEZFIL_OVERTURE_MAX_KM2` | `25000` | Overture import area budget for the places theme, in km²; the other themes scale from it. | App (live) or restart |
| `DEZFIL_QUERY_TIMEOUT_S` | `60` | Read-only query timeout, in seconds. It bounds every evaluation of user SQL — builder and published views alike — not just the SQL workspace. | App (live) or restart |
| `DEZFIL_QUERY_MEMORY_MB` | `2048` | Engine memory budget for user SQL, shared by all queries on the hardened instance. A query pushed over it fails with a coded error; the instance keeps serving. | Restart |
| `DEZFIL_TRUSTED_MEMORY_MB` | `3072` | Trusted engine memory, in engine MB, shared across trusted work. Dedicated scratch allowance is four times this value. Fixed without an override; locked with one. Shown on System beside hardened engine memory. | Restart |
| `DEZFIL_PREVIEW_ROWS` | `1000` | Rows returned in a query/preview result. | App (live) or restart |
| `DEZFIL_RENDER_CAP_FEATURES` | `250000` | Max features a single layer renders before asking for a LIMIT or aggregation. | Restart |
| `DEZFIL_RENDER_CAP_BYTES` | `134217728` | Bytes drawn per layer (128 MiB): each complete uncompressed UTF-8 JSON inline answer, including its envelope. Equality is admitted. Fixed without an override; locked with one. Shown on Limits > Queries. | Restart |
| `DEZFIL_SLIDER_PREVIEW_ROWS` | `50000` | Max source points transferred for an interactive slider preview. | Restart |
| `DEZFIL_PUBLISH_FRESHNESS_S` | `30` | How stale a published view may be — its cache window. | Restart |
| `DEZFIL_TILE_BUILD_TIMEOUT_S` | `600` | Timeout for each stage of a background tile build. | Restart |
| `DEZFIL_PUBLIC_RATE_LIMIT` | `60` | Anonymous published-view requests per 10s window, per verified source. | App (live) or restart |
| `DEZFIL_PUBLIC_TILE_RATE_LIMIT` | `600` | Anonymous tile requests per 10s window, per verified source (one map pan is dozens of tiles). | App (live) or restart |
| `DEZFIL_TIPPECANOE` | `tippecanoe` | Path to the tippecanoe binary used for tile builds. | Restart |
| `DEZFIL_BASEMAP_URL` | built-in styles | MapLibre style URL for the basemap. | Restart |
| `DEZFIL_BASEMAP_ATTRIBUTION` | unset | Credit line shown on maps that use `DEZFIL_BASEMAP_URL`. Unset, no credit is shown for the override: the built-in credit would name a provider that is not serving the tiles. | Restart |
| `DEZFIL_SATELLITE_URL` | unset | Raster tile URL template (`{z}/{y}/{x}`) for satellite imagery, with your own key or token in its path or query. No imagery ships with the app; unset and with no tile address stored on the **Libraries** tab, no imagery basemap is offered at all. A template with a user name or password in it is not drawn, because browsers do not load tiles from such an address; the **Libraries** tab says so under the tile address. | App (live) or restart |
| `DEZFIL_SATELLITE_ATTRIBUTION` | unset | Credit line the imagery provider requires, shown on every map using it and stored with anything published from one. An admin can store it on the **Libraries** tab instead. | App (live) or restart |
| `DEZFIL_GEOCODER_URL` | unset | Nominatim-compatible `/search` endpoint for place search in the builder **and for the batch geocoding operation** (key query parameters travel with it, server-side only). Unset, search still answers layers, values, and coordinates, and the geocode operation is not offered. Public Nominatim expects at most one request per second; see `DEZFIL_GEOCODE_PACE_MS`. | App (live) or restart |
| `DEZFIL_ISOCHRONE_URL` | unset | Valhalla-compatible `/isochrone` endpoint for the travel-time-area operation (key query parameters travel with it, server-side only). Unset, the verb stays visible and refuses with a sentence naming this setting. | App (live) or restart |
| `DEZFIL_ISOCHRONE_PACE_MS` | `1000` | Milliseconds between isochrone requests — one exchange in flight at a time, this endpoint's own pace. | App (live) or restart |
| `DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S` | `20` | Whole-exchange deadline for one isochrone request; routing answers slower than geocoding. | App (live) or restart |
| `DEZFIL_ISOCHRONE_CACHE_HOURS` | `168` | How long a fully answered isochrone keeps; only complete answers are cached. | App (live) or restart |
| `DEZFIL_ISOCHRONE_CACHE_MB` | `64` | The isochrone answer cache's size budget, oldest evicted first. | Restart |
| `DEZFIL_GEOCODE_PACE_MS` | `1000` | Minimum gap between two requests to that endpoint, in milliseconds — enforced across the whole instance, so a batch and the builder's own search share one pace, and only one request is ever in flight. The public-Nominatim recipe requires one second. Lowering it against your own geocoder raises the batch size the operation accepts; `0` means no gap at all. | App (live) or restart |
| `DEZFIL_GEOCODE_REQUEST_TIMEOUT_S` | `10` | Deadline for one geocoding exchange. A batch's row costs the pace or this, whichever is longer, so lowering it raises the batch size the operation accepts — the bound is derived from both, not from the pace alone. | App (live) or restart |
| `DEZFIL_GEOCODE_MATCH_CACHE_HOURS` | `720` | How long a matched address is kept. Thirty days: an address that resolved rarely moves. | App (live) or restart |
| `DEZFIL_GEOCODE_NO_MATCH_CACHE_HOURS` | `24` | How long a no-match is kept. Shorter, because an address that did not resolve is what improves when the provider's data does. | Restart |
| `DEZFIL_GEOCODE_CACHE_MB` | `64` | Size budget for the geocode answer cache; oldest entries are evicted first. | Restart |
| `DEZFIL_SECRET_KEY` | generated | 64 hex characters (32 bytes) — the at-rest encryption key for stored credentials. See below before relying on the default. | Restart |
| `ANTHROPIC_API_KEY` | unset | Enables the assistant with Anthropic. Bring your own key. | Restart |
| `OPENAI_API_KEY` | unset | Enables the assistant with OpenAI. Bring your own key. | Restart |
| `DEZFIL_AI_PROVIDER` | first key set | `anthropic` or `openai` — which provider to use when both keys are set. | Restart |
| `DEZFIL_AI_MODEL` | provider default | Override the model (defaults: `claude-opus-5`, `gpt-5.6-terra`; OpenAI uses the Responses API). `DEZFIL_AI_MODEL=gpt-6-astra` restores the earlier OpenAI default. | Restart |
| `DEZFIL_AI_MODELS_ANTHROPIC` | unset | Comma-separated Anthropic model identities, narrowing and ordering the offer. Unset offers the full effective [catalogue](docs/runbook.md#the-model-catalogue-file) and shows the picker. A set empty list or a list naming only the default offers that model alone. The default stays where listed or is prepended once; only the resolved provider's list applies. | Restart |
| `DEZFIL_AI_MODELS_OPENAI` | unset | The same catalogue and narrowing rules for OpenAI, for example `gpt-5.6-terra,gpt-6-astra`. Use `gpt-5.6-terra` alone for the default one-model state. See the [catalogue instructions](docs/runbook.md#the-model-catalogue-file). | Restart |
| `DEZFIL_ASSISTANT_STEP_BUDGET` | `20` | Max model+tool steps one assistant request may take. | Restart |
| `DEZFIL_ASSISTANT_AUTO_CHECK` | on | Whether the assistant checks the map by itself after a turn that changed it: a bounded rendered image read back by the model, one line in the transcript saying what it saw. `0`, `false` or `off` turns it off; an explicit check stays available. `GET /api/assistant` reports the setting. | Restart |
| `DEZFIL_ASSISTANT_LOOK_TIMEOUT_S` | `30` | The map check's budget, request to response: queue wait, render and image preparation. Past it the check answers `render_timeout` and the note says the picture could not be taken in time. | Restart |
| `DEZFIL_ASSISTANT_LOOK_RETENTION` | `256` | Renders of the map check kept in process for the transcript's thumbnails and `GET /api/maps/look/{renderId}`, full images and thumbnails counted together, oldest evicted first; gone with the process. | Restart |
| `DEZFIL_ASSISTANT_LOOK_RETENTION_MB` | `96` | The retained renders' byte budget. | Restart |
| `DEZFIL_ASSISTANT_OFFER` | `subset` | Which operations a page's assistant run is offered at the start: `subset` (the page's own operations and the grounding reads, the rest reachable through the run's discovery tool; the measured default) or `full` (every operation the page admits, with no discovery tool, the offer every page had before the subset was measured). `GET /api/assistant/policy?page=` reports the current answer per page. | Restart |
| `DEZFIL_TOOL_ATTACHMENT_MAX_MB` | `32` | Cap on a download answered to an agent tool (the base64 attachment envelope). Over the cap the tool gets a coded error instead. | Restart |
| `DEZFIL_CHROMIUM_PATH` | `/usr/bin/chromium` | The headless browser the server image export drives (baked into the container). Runs with `--no-sandbox` — the container is rootless without the user namespaces chromium's sandbox wants, and the only pages rendered are this instance's own origin. | Restart |
| `DEZFIL_EXPORT_RENDER_TIMEOUT_S` | `90` | Server image-render budget, queue wait included. A render past it dies with a coded error. | App (live) or restart |
| `DEZFIL_EXPORT_REQUEST_TIMEOUT_S` | `20` | The bound on an external render request. After the request burst settles and app-origin requests finish, the relay ends its current sockets, including worker fetches, and refuses re-dials only to the stalled hosts for the rest of that render. The image is still produced with the available content. Requests with no terminal event stay armed for another cut after the same bound. App-origin requests retain the whole render budget. The answer carries `x-dezfil-export-abandoned` with the abandonment count and hosts (`1; hosts=tiles.example`), counting repeated cuts again, and the server log names the abandonment as it happens. | Restart |
| `DEZFIL_EXPORT_RENDER_CONCURRENCY` | `2` | Concurrent server image renders; software-GL rendering is CPU-expensive, so work beyond the cap waits inside the budget. | App (live) or restart |
| `DEZFIL_OPERATION_TIMEOUT_S` | `600` | Execution budget for one operation run, in seconds. Deliberately larger than the query timeout — an operation is not a preview query. It covers execution only: time a run spends waiting for the lane is not charged against it. | App (live) or restart |
| `DEZFIL_OPERATION_CONCURRENCY` | `1` | Operations executing at once. Runs are heavy work on the query engine, whose memory budget is shared, so work beyond the cap queues rather than competing. | App (live) or restart |
| `DEZFIL_OPERATION_QUEUE_MAX` | `20` | Runs that may wait for the lane. A run arriving at a full queue is refused with a coded error instead of joining a queue that will not drain. | App (live) or restart |
| `DEZFIL_OPERATION_HISTORY_PER_SUBJECT` | `20` | Runs kept per subject. The subject's most recent success is preserved inside this depth, so a failed re-run never erases the last good one. | Restart |
| `DEZFIL_TEST_PG_URL` | unset | Test/probe process only: disposable PostGIS fixture URL for live source tests and the full result-budget probe. Never read by the product server. | Restart |
| `DEZFIL_TEST_PUBLICATION_LOG` | unset | Test preload only: NDJSON destination for per-admission published-source state. Required by `scripts/publication-observer.mjs`; no effect without that preload. | Restart |
| `DEZFIL_TEST_DERIVATION_LOG` | unset | Test preload only: NDJSON destination for native derivation starts, completions and admission occupancy. Required by `scripts/derivation-observer.mjs`; no effect without that preload. | Restart |
| `DEZFIL_TEST_EXTENSION_REPOSITORY` | unset | Tests only: a loopback extension repository the engine that runs people's SQL installs from, so a test that lets it install an extension reaches a fixture that records the request, never the internet. Never set in a deployment. | Restart |

Dataset and geometry inspection use the Query time limit. File, archive, link
and object-store imports and refreshes use the Data processing time limit;
[the configuration guide](docs/configuration.md#upload-and-remote-import)
describes the operation families. Upload reception and processing each keep
the limit admitted when reception began. A 60-second body stall answers
`408 upload_stalled`; reception expiry answers `408 data_processing_timeout`. Trusted work shares the configured engine memory and a dedicated
`engine-spill/` allowance of four times that value. A restart clears only that
spill directory. Exhaustion answers `422 engine_memory_exceeded`, naming
memory or scratch and the deployment remedy. A layer render builds its answer
under Bytes drawn per layer: one that would exceed it is refused before it is
complete and answers the errored layer `render_bytes_exceeded`. Dataset map
features, slider previews, Overture, OpenStreetMap and sketch features do not
apply it yet.

JSON admission has fixed outer byte tiers: 65,536 bytes for authentication
entry, Account, Users, instance settings and the three anonymous published POSTs; 16,777,216 for
other JSON, including MCP and workflows; assistant messages retain 131,072.
Excess returns 413 with the operation's documented error. Optional bodies,
escaping and UTF-8 bytes count too. Render selections remain in the small tier
even when their filters satisfy the semantic limits. MCP's base64 envelope
makes a raw upload smaller than 12 MiB; see [the MCP guide](docs/mcp.md).
Multipart uploads stream to disk under the separate file/archive caps.

The fixed `experimental.proxyClientMaxBodySize` in `next.config.ts` is
17 MiB (17,825,792 bytes), allowing the 16 MiB JSON boundary to reach its reader.
Matched paths still drain and copy up to that limit before the gate, including
anonymous callers. A fronting reverse proxy's own request-size limit bounds
that residual copy further. Canonical spellings of `/api/tables` and the public
widget-values, render and extent POST paths bypass the copy and preserve their
handler-side gates. The native door returns an
empty 400 for `TRACE`. See [self-hosting](docs/self-hosting.md) for the wire
behavior and [the API guide](docs/api.md#request-bounds) for exact refusals.

Published API budgets use verified ingress sources, shared across tokens, including
unknown tokens. View reads share one budget; tiles have another. Both together
retain at most 10,000 entries. Traffic sweeps expired windows at most once per
second; between sweeps, a new source at capacity evicts the least recently used
entry. The bound holds either way. Eviction starts a fresh window. Readers behind an
untrusted proxy share its socket budget; trusted chains use the nearest
untrusted hop. Missing or forged provenance refuses with private, no-store
503 `ingress_unavailable` before body work or token resolution. See
[self-hosting](docs/self-hosting.md) for provenance refusals and scope.

Password derivation admission is shared across the server process: two active,
six ordinary plus two reserved protected waiters, and a five-second maximum
wait. FIFO applies within each class. Validated links and signed-in password
checks are protected, with priority for the next slot and at most one active
protected derivation. Ordinary sign-ins can use both slots. Full classes and
deadlines answer private 503 `authentication_busy` with one-second retry advice,
without adding login failures or a lasting lockout. Running work retains its
slot until settlement. These fixed bounds introduce no configuration knob;
actual derivation time depends on the host.

### The secret key

Stored connection credentials (for example PostGIS passwords) are encrypted
at rest with a 32-byte key. Set it explicitly with `DEZFIL_SECRET_KEY`
(64 hex characters). **Left unset, Dezfil generates a key into the data
volume as `secret.key` on first boot** and keeps using it from there.

The consequence of that convenience: secrets written under a generated key
can only ever be read with that same key. Set `DEZFIL_SECRET_KEY` to a
fresh value later, or lose `secret.key` while keeping `metadata.sqlite`,
and the stored credentials cannot be decrypted; the affected connections
must be entered again. To pin the key from day one, set the variable
before the first boot. To move from a generated key to a
pinned one without losing anything, set `DEZFIL_SECRET_KEY` to the hex
string already in `secret.key`.

## API

The whole product is an API the UI merely calls. Human-readable docs are at
`/developer` on a running instance; the machine-readable OpenAPI description is at
`/api/openapi.json`; both require sign-in or an API token. Cookie mutations
require an Origin matching the instance; bearer requests use the token alone.
`scripts/journey.mjs <base-url>` provisions an account on a scratch instance and drives the entire
flow — upload → SQL → layer → style → publish — through that API with no
browser.

## Agents

Claude Code and Codex CLI can install the self-contained
[Dezfil plugin](plugins/dezfil/README.md) from a checkout. It bundles the
MCP connection, a Dezfil skill and compact cartography and DuckDB spatial
references. Choose the instance address when preparing the local package.
Create an API / MCP token in Settings and set `DEZFIL_API_TOKEN` in the
client's environment. The package stores a reference, never the token value.

Two ways to drive Dezfil with AI, both operating that same documented API:

- **MCP** — `/api/mcp` uses Streamable HTTP and derives its tools, input/output
  schemas and consequence facts from OpenAPI. Deliberate exclusions are declared
  in that document. The Developer page supplies Claude Code, Codex and Cursor
  token configurations for the visible instance, marks Claude Desktop's remote
  connector unsupported for this setup, and checks the browser's MCP connection.
  Each client uses an account token and its current privileges. The client brings its model;
  no Dezfil model credential is needed. Confirmation policy, target and
  consequence are advisory listing metadata; the client owns confirmation.
  Structured results add history associations and binary references beside the
  existing text representation. Qualifying edits accept `change_group` for the
  existing per-map undo timeline. The shared MCP journey runs in Vitest;
  `scripts/mcp-journey.mjs <base-url>` runs it by hand, with `--render` selecting
  the separate real-render arm. Point it at an isolated instance on its own
  data directory, so the journey's writes stay out of working data.
- **In-product assistant** — set one of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
  (see Configuration) and the builder gains an assistant that turns plain
  English into SQL, layers, and styles, showing the SQL and explaining each
  step. Without a key the assistant is simply absent — everything else works
  unchanged. The key is a server-side secret; it never reaches the browser or
  a published page. Destructive and publishing actions ask before running.

The model credential is per instance. Signed-in accounts can use the assistant
it powers, with tool calls retaining the caller's current privileges.

Assistant clients reserve with `POST /api/assistant/runs` before sending a new
message with that `runId` to `POST /api/assistant/messages`. Unreserved messages
return `assistant_reservation_required`. The builder sends its map and selected
layer as context. Text deltas arrive during generation; complete message events
remain available. After a lost response, `GET /api/assistant/runs/{id}` reads the
same run, and `GET /api/assistant/pending` recovers open confirmations. Duplicate
submissions return a JSON snapshot without repeating work. Recovery is bounded
in-memory working state; the API documents expiry, release and capacity refusal.
`GET /api/assistant/policy?page=builder|sql|workflow` answers what a run under
that page admits and is offered at the start, and whether it can discover the
rest; the same modules decide for the message route.


## SQL result limits

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

## Develop

```sh
npm ci
npm run dev        # app on http://localhost:3000, data in ./data
npm test           # unit tests
npm run lint
npm run typecheck
```

`npm run dev`, `npm start` and the container launcher install the socket
provenance preload before Next starts. Keep these launch commands: readiness
and sign-in refuse a server launched without the preload. A custom standalone
launch must use `node --import=./scripts/ingress-preload.mjs server.js` and carry
the preload files from the image. Existing `NODE_OPTIONS` observers are preserved.

`npm run journey:browser` runs the **whole browser surface**, every spec
file under `e2e/`, with Playwright against a running instance
(`DEZFIL_BASE_URL` to point it elsewhere, default `localhost:3000`;
first run needs `npx playwright install chromium firefox webkit`).
The pipeline does not run it: it is yours to run, against an instance you
provisioned as below. Third-party hosts
are blocked during the journey, so it needs no internet beyond the
instance itself. Subsets run by area: `npm run e2e:keyboard`,
`e2e:layers`, `e2e:imports`, `e2e:styling`, `e2e:recovery`,
`e2e:lifecycle`, `e2e:states`, `e2e:pixel`, `e2e:smoke`.

The full gate needs provisioning, in two kinds. **Required for a green
run** — without these, real failures, not skips:

- `DEZFIL_RENDER_CAP_FEATURES=2000` on the server — the journey's
  52,001-feature layer must take the tiled road;
- `DEZFIL_EGRESS_ALLOWLIST=127.0.0.1` on the server — the URL-import
  drive fetches a loopback fixture through the documented allowlist, and the
  OSM and Overture drives need it too, since OpenStreetMap queries and the
  Overture release listing go through the same egress check;
- `DEZFIL_OVERPASS_URL=http://127.0.0.1:31877/overpass` on the
  server — the OSM drive runs a recorded Overpass fixture on that port
  and expects its six rows (and later its induced 504) instead of the
  public endpoint;
- `DEZFIL_OVERTURE_S3_ENDPOINT=127.0.0.1:31878` on the server — the
  Overture drive reads a loopback S3 fixture on that port (the suite
  starts it itself) instead of the public bucket;
- `tippecanoe` on the server's PATH (below) — the render cap forces the
  journey's big layer onto the tiled road, which shells out to it.

**Optional — absent, the gated tests skip visibly:**

- `DEZFIL_TEST_PG_URL` (test process) with a running
  `postgis/postgis:16-3.4` container — the live PostGIS drives;
- `DEZFIL_DATA_DIR` (test process, same value as the server's) — the
  real failed-tile-build drive;
- `DEZFIL_E2E_ASSISTANT=1` plus a server-side model key — the
  assistant-confirmation smoke (`npm run e2e:smoke` sets the
  opt-in itself).

Operational recipes for running an instance live in
[docs/runbook.md](docs/runbook.md).

Tiled rendering of large layers shells out to
[tippecanoe](https://github.com/felt/tippecanoe) (`brew install tippecanoe`
on macOS; build from source on Linux). Without it everything else works —
only layers over the render cap report the missing tiler. The Docker image
bakes it in.

## How this project is built

Spec-driven: every feature is specified, planned and broken into tasks
before any code is written. The standards that outlive a feature live in
the checks, not in prose: `npm run lint`, `npm run typecheck`, `npm test`,
and the named gates under `npm run lint:*`.

## License

[Apache-2.0](LICENSE). Code borrowed from permissively licensed projects
(e.g. GeoLibre, kepler.gl, MapStore) keeps its original license header in
the file, with the source noted in [NOTICE](NOTICE).
