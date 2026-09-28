# Dezfil

Self-hosted spatial SQL and map publishing, powered by DuckDB and files.
Upload geospatial data, query it with SQL, style it on a map, publish a
shareable view — from one container.

> Status: pre-release, under active development.

## Run it

For development, with live reload:

```sh
npm install
npm run dev
```

Open <http://localhost:3000>.

With Docker installed:

```sh
docker build -t dezfil .
docker run -d --name dezfil -p 3000:3000 -v dezfil-data:/data dezfil
```

Open <http://localhost:3000>. The instance reports readiness at
`/api/health`.

Everything Dezfil stores — tables, maps, layers, styles, published links —
lives in the `/data` volume (`dezfil-data` above). Back up by copying that
volume with the container stopped; move to a new container by mounting the
same volume. To move to another machine, stop the container and copy the
whole directory: nothing Dezfil needs lives outside it. Running without
the volume works, but state then lasts only for that container's lifetime.

The published-link URL is the entire access model: anyone who can reach the
instance can edit everything, and anyone with a published link can view it.
There are no accounts in this release — run it behind your own network
controls.

## Configuration

Every setting is optional; the defaults below are production-sane. Pass them
as `-e NAME=value` on `docker run`.

| Setting | Default | What it controls |
|---|---|---|
| `DEZFIL_DATA_DIR` | `/data` | Durable data directory (the mounted volume), including the optional `assistant-models.json` [model catalogue](docs/runbook.md#the-model-catalogue-file). |
| `DEZFIL_TRUSTED_PROXIES` | *(none)* | Comma-separated IP addresses or CIDRs of reverse proxy socket peers. Only these peers may supply forwarding information. Configure proxies to replace host/protocol/port forwarding fields and append the actual client address. Direct clients' forwarding headers are discarded. |
| `DEZFIL_UPLOAD_MAX_MB` | `5120` | Upload size cap, in MB. |
| `DEZFIL_EGRESS_ALLOWLIST` | — | Hosts, IPs, or CIDRs the server may fetch for a user despite the egress policy. By default, loopback, private-network, link-local, and cloud-metadata destinations are blocked on URL imports and PostGIS connections. |
| `DEZFIL_REMOTE_TIMEOUT_S` | `300` | Time bound for one whole remote fetch (URL and object-store imports), redirects and body included. |
| `DEZFIL_REMOTE_MAX_MB` | `2048` | Size cap for one remote import (URL and object-store), in MB. |
| `DEZFIL_OBJECT_STORE_CREDENTIALS` | off | Opt-in (`true`): sign `s3://`/`gs://`/`az://` imports with the instance's own credential chain. Off, object-store reads are anonymous — users can only read what the public can. |
| `DEZFIL_S3_ENDPOINT` | AWS | Custom S3-compatible endpoint (MinIO and friends) for anonymous `s3://` imports, addressed path-style. |
| `DEZFIL_OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Overpass endpoint for OSM imports. Point it at your own instance to escape the public per-IP limits. |
| `DEZFIL_OVERTURE_S3_ENDPOINT` | *(unset — public Overture bucket)* | S3-compatible endpoint override for Overture reads (path-style, plain http). The test seam behind the browser suite's Overture drive; also fits a private mirror of the bucket. |
| `DEZFIL_OVERPASS_TIMEOUT_S` | `60` | Server-side time budget passed with each Overpass query. |
| `DEZFIL_OVERPASS_MAXSIZE_MB` | `512` | Response budget passed with each Overpass query; a response over twice this aborts locally. |
| `DEZFIL_OVERPASS_CACHE_MB` | `2048` | Overpass response-cache budget; oldest entries are evicted past it, expired ones on sight. |
| `DEZFIL_OVERPASS_CACHE_H` | `24` | How long a cached Overpass response stays fresh, in hours. |
| `DEZFIL_OSM_MAX_KM2` | `10000` | OSM import area budget, in km². |
| `DEZFIL_OVERTURE_MAX_KM2` | `25000` | Overture import area budget for the places theme, in km²; the other themes scale from it. |
| `DEZFIL_QUERY_TIMEOUT_S` | `60` | Read-only query timeout, in seconds. It bounds every evaluation of user SQL — builder and published views alike — not just the SQL workspace. |
| `DEZFIL_QUERY_MEMORY_MB` | `2048` | Engine memory budget for user SQL, shared by all queries on the hardened instance. A query pushed over it fails with a coded error; the instance keeps serving. |
| `DEZFIL_PREVIEW_ROWS` | `1000` | Rows returned in a query/preview result. |
| `DEZFIL_RENDER_CAP_FEATURES` | `250000` | Max features a single layer renders before asking for a LIMIT or aggregation. |
| `DEZFIL_SLIDER_PREVIEW_ROWS` | `50000` | Max source points transferred for an interactive slider preview. |
| `DEZFIL_PUBLISH_FRESHNESS_S` | `30` | How stale a published view may be — its cache window. |
| `DEZFIL_TILE_BUILD_TIMEOUT_S` | `600` | Timeout for each stage of a background tile build. |
| `DEZFIL_PUBLIC_RATE_LIMIT` | `60` | Anonymous published-view requests per 10s window, per client. |
| `DEZFIL_PUBLIC_TILE_RATE_LIMIT` | `600` | Anonymous tile requests per 10s window, per client (one map pan is dozens of tiles). |
| `DEZFIL_TIPPECANOE` | `tippecanoe` | Path to the tippecanoe binary used for tile builds. |
| `DEZFIL_BASEMAP_URL` | OpenFreeMap dark | MapLibre style URL for the basemap. |
| `DEZFIL_BASEMAP_ATTRIBUTION` | — | Credit line shown on maps that use `DEZFIL_BASEMAP_URL`. Unset, no credit is shown for the override: the built-in credit would name a provider that is not serving the tiles. |
| `DEZFIL_SATELLITE_URL` | — | Raster tile URL template (`{z}/{y}/{x}`) for satellite imagery, with your own key or token. No imagery ships with the app; unset, no imagery basemap is offered at all. |
| `DEZFIL_SATELLITE_ATTRIBUTION` | — | Credit line the imagery provider requires, shown on every map using it and stored with anything published from one. |
| `DEZFIL_GEOCODER_URL` | — | Nominatim-compatible `/search` endpoint for place search in the builder **and for the batch geocoding operation** (key query parameters travel with it, server-side only). Unset, search still answers layers, values, and coordinates, and the geocode operation is not offered. Public Nominatim expects at most one request per second; see `DEZFIL_GEOCODE_PACE_MS`. |
| `DEZFIL_ISOCHRONE_URL` | — | Valhalla-compatible `/isochrone` endpoint for the travel-time-area operation (key query parameters travel with it, server-side only). Unset, the verb stays visible and refuses with a sentence naming this setting. |
| `DEZFIL_ISOCHRONE_PACE_MS` | `1000` | Milliseconds between isochrone requests — one exchange in flight at a time, this endpoint's own pace. |
| `DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S` | `20` | Whole-exchange deadline for one isochrone request; routing answers slower than geocoding. |
| `DEZFIL_ISOCHRONE_CACHE_HOURS` | `168` | How long a fully answered isochrone keeps; only complete answers are cached. |
| `DEZFIL_ISOCHRONE_CACHE_MB` | `64` | The isochrone answer cache's size budget, oldest evicted first. |
| `DEZFIL_GEOCODE_PACE_MS` | `1000` | Minimum gap between two requests to that endpoint, in milliseconds — enforced across the whole instance, so a batch and the builder's own search share one pace, and only one request is ever in flight. The public-Nominatim recipe requires one second. Lowering it against your own geocoder raises the batch size the operation accepts; `0` means no gap at all. |
| `DEZFIL_GEOCODE_REQUEST_TIMEOUT_S` | `10` | Deadline for one geocoding exchange. A batch's row costs the pace or this, whichever is longer, so lowering it raises the batch size the operation accepts — the bound is derived from both, not from the pace alone. |
| `DEZFIL_GEOCODE_MATCH_CACHE_HOURS` | `720` | How long a matched address is kept. Thirty days: an address that resolved rarely moves. |
| `DEZFIL_GEOCODE_NO_MATCH_CACHE_HOURS` | `24` | How long a no-match is kept. Shorter, because an address that did not resolve is what improves when the provider's data does. |
| `DEZFIL_GEOCODE_CACHE_MB` | `64` | Size budget for the geocode answer cache; oldest entries are evicted first. |
| `DEZFIL_SECRET_KEY` | generated | 64 hex characters (32 bytes) — the at-rest encryption key for stored credentials. See below before relying on the default. |
| `ANTHROPIC_API_KEY` | — | Enables the assistant with Anthropic. Bring your own key. |
| `OPENAI_API_KEY` | — | Enables the assistant with OpenAI. Bring your own key. |
| `DEZFIL_AI_PROVIDER` | first key set | `anthropic` or `openai` — which provider to use when both keys are set. |
| `DEZFIL_AI_MODEL` | provider default | Override the model (defaults: `claude-opus-5`, `gpt-5.6-terra`; OpenAI uses the Responses API). `DEZFIL_AI_MODEL=gpt-6-astra` restores the earlier OpenAI default. |
| `DEZFIL_AI_MODELS_ANTHROPIC` | Unset | Comma-separated Anthropic model identities, narrowing and ordering the offer. Unset offers the full effective [catalogue](docs/runbook.md#the-model-catalogue-file) and shows the picker. A set empty list or a list naming only the default offers that model alone. The default stays where listed or is prepended once; only the resolved provider's list applies. |
| `DEZFIL_AI_MODELS_OPENAI` | Unset | The same catalogue and narrowing rules for OpenAI, for example `gpt-5.6-terra,gpt-6-astra`. Use `gpt-5.6-terra` alone for the default one-model state. See the [catalogue instructions](docs/runbook.md#the-model-catalogue-file). |
| `DEZFIL_ASSISTANT_STEP_BUDGET` | `20` | Max model+tool steps one assistant request may take. |
| `DEZFIL_ASSISTANT_AUTO_CHECK` | `1` | Whether the assistant checks the map by itself after a turn that changed it: a bounded rendered image read back by the model, one line in the transcript saying what it saw. `0`, `false` or `off` turns it off; an explicit check stays available. `GET /api/assistant` reports the setting. |
| `DEZFIL_ASSISTANT_LOOK_TIMEOUT_S` | `30` | The map check's budget, request to response: queue wait, render and image preparation. Past it the check answers `render_timeout` and the note says the picture could not be taken in time. |
| `DEZFIL_ASSISTANT_LOOK_RETENTION` | `256` | Renders of the map check kept in process for the transcript's thumbnails and `GET /api/maps/look/{renderId}`, full images and thumbnails counted together, oldest evicted first; gone with the process. |
| `DEZFIL_ASSISTANT_LOOK_RETENTION_MB` | `96` | The retained renders' byte budget. |
| `DEZFIL_ASSISTANT_OFFER` | `subset` | Which operations a page's assistant run is offered at the start: `subset` (the page's own operations and the grounding reads, the rest reachable through the run's discovery tool; the measured default) or `full` (every operation the page admits, with no discovery tool, the offer every page had before the subset was measured). `GET /api/assistant/policy?page=` reports the current answer per page. |
| `DEZFIL_TOOL_ATTACHMENT_MAX_MB` | `32` | Cap on a download answered to an agent tool (the base64 attachment envelope). Over the cap the tool gets a coded error instead. |
| `DEZFIL_CHROMIUM_PATH` | `/usr/bin/chromium` | The headless browser the server image export drives (baked into the container). Runs with `--no-sandbox` — the container is rootless without the user namespaces chromium's sandbox wants, and the only pages rendered are this instance's own origin. |
| `DEZFIL_EXPORT_RENDER_TIMEOUT_S` | `90` | Server image-render budget, queue wait included. A render past it dies with a coded error. |
| `DEZFIL_EXPORT_REQUEST_TIMEOUT_S` | `20` | The bound on any one request the render page makes. A request past it is abandoned, the image is still produced, the answer carries `x-dezfil-export-abandoned` with the count and the hosts (`1; hosts=tiles.example`), and the server log names the abandonment as it happens. |
| `DEZFIL_EXPORT_RENDER_CONCURRENCY` | `2` | Concurrent server image renders; software-GL rendering is CPU-expensive, so work beyond the cap waits inside the budget. |
| `DEZFIL_OPERATION_TIMEOUT_S` | `600` | Execution budget for one operation run, in seconds. Deliberately larger than the query timeout — an operation is not a preview query. It covers execution only: time a run spends waiting for the lane is not charged against it. |
| `DEZFIL_OPERATION_CONCURRENCY` | `1` | Operations executing at once. Runs are heavy work on the query engine, whose memory budget is shared, so work beyond the cap queues rather than competing. |
| `DEZFIL_OPERATION_QUEUE_MAX` | `20` | Runs that may wait for the lane. A run arriving at a full queue is refused with a coded error instead of joining a queue that will not drain. |
| `DEZFIL_OPERATION_HISTORY_PER_SUBJECT` | `20` | Runs kept per subject. The subject's most recent success is preserved inside this depth, so a failed re-run never erases the last good one. |

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
`/api/openapi.json`. `scripts/journey.mjs <base-url>` drives the entire
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


## Develop

```sh
npm install
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
first run needs `npx playwright install chromium`).
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
  drive fetches a loopback fixture through the documented allowlist;
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
