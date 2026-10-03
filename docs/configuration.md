# Configuration

Deployment settings come from environment variables read when the process or
container starts. Change those values and restart to apply them. Their defaults
allow a local instance to start without deployment configuration.

Other settings persist at runtime. Settings saves **account preferences** such as
the display name and view choices, and **instance preferences** such as the
admin-managed instance name, in SQLite. Accounts, sessions and API token records
also persist there. Saved palettes are shared instance data. These are not
environment variables.

The optional `assistant-models.json` in the data directory supplies the model
catalogue; environment model lists narrow its offer. It is a file, not an account
preference. Its reload and validation rules are in
[the runbook](runbook.md#the-model-catalogue-file). Edit revisions and stale-save
recovery need no deployment switch.

Two conventions run through the whole surface:

- A numeric setting that is unset, non-numeric, or not greater than zero
  falls back to its default rather than failing the boot
  (`src/lib/limits.ts`). Two settings treat zero as a real value, the two
  provider pacing intervals, so that "no gap at all" can be expressed.
- Sizes are megabytes, durations are seconds unless the name ends in `_MS`
  or `_HOURS`.

## What the README already documents

The table in the **Configuration** section of [README.md](../README.md) is the
checked environment surface. It is checked in
both directions by `scripts/check-readme-config.mjs` (run as `npm run
lint:readme`), which scans `src/` for names and compares the set with the
table's rows. Undocumented and stale rows both fail the check.

The checker pins the row format: a line starting with `` | `NAME` `` followed
by the default and the effect. Anything added to that table has to match it,
and anything the server starts reading has to be added. This page groups and
expands on the same variables; the table stays the source the check reads.

Two classes are deliberately outside the check: test wiring (`DEZFIL_TEST_*`
and `DEZFIL_BASE_URL`) and platform plumbing (`NODE_ENV`, `PORT`, `HOSTNAME`,
`NEXT_RUNTIME`, `TZ`, `CI`, `DUCKDB_EXTENSION_DIR`). Both are listed at the
end of this page.

## Storage

| Variable | Default | Effect |
|---|---|---|
| `DEZFIL_DATA_DIR` | `./data`, `/data` in the container | The single durable directory. Back up the complete stopped directory and any external encryption key. `src/lib/config.ts` falls back to `data` under the working directory; the image sets `/data` and declares it a volume. |
| `DEZFIL_SECRET_KEY` | generated | 64 hex characters (32 bytes), the at-rest encryption key for stored connection credentials. Unset, a key is generated into the data directory as `secret.key` on first boot and reused from there (`src/lib/secrets.ts`). A wrong or lost key makes stored credentials unreadable. |

## Trusted proxies

| Variable | Default | Effect |
|---|---|---|
| `DEZFIL_TRUSTED_PROXIES` | unset | Comma-separated IP addresses or CIDRs of reverse proxy socket peers. Only these peers may supply forwarding information. Configure proxies to replace host/protocol/port forwarding fields and append the actual client address; direct clients' forwarding headers are discarded. |

## Upload and remote import

| Variable | Default | Effect |
|---|---|---|
| `DEZFIL_UPLOAD_MAX_MB` | `5120` | Size cap for one uploaded file. |
| `DEZFIL_REMOTE_MAX_MB` | `2048` | Size cap for one remote import (URL or object store). Deliberately below the upload cap: remote fetches run unattended. |
| `DEZFIL_REMOTE_TIMEOUT_S` | `300` | Time bound for one whole remote fetch, redirects and body included. |
| `DEZFIL_EGRESS_ALLOWLIST` | unset | Comma-separated hosts, IPs, or CIDRs the server may fetch for a user despite the egress policy. By default loopback, private-network, link-local, and cloud-metadata destinations are refused on URL imports and database connections (`src/lib/net/egress.ts`). |
| `DEZFIL_OBJECT_STORE_CREDENTIALS` | off | `1`, `true`, or `yes` signs `s3://`, `gs://`, and `az://` imports with the instance's own credential chain. Off, object-store reads are anonymous, so a user can only read what the public can (`src/lib/ingest/remote.ts`). |
| `DEZFIL_S3_ENDPOINT` | AWS | S3-compatible endpoint for anonymous `s3://` imports, addressed path-style. |

## Open data providers

| Variable | Default | Effect |
|---|---|---|
| `DEZFIL_OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Overpass endpoint for OpenStreetMap imports. Point it at your own instance to escape the public per-IP limits (`src/lib/osm/overpass.ts`). |
| `DEZFIL_OVERPASS_TIMEOUT_S` | `60` | Time budget sent with each Overpass query. |
| `DEZFIL_OVERPASS_MAXSIZE_MB` | `512` | Response budget sent with each Overpass query; a response over twice this is aborted locally. |
| `DEZFIL_OVERPASS_CACHE_MB` | `2048` | Overpass response-cache budget, evicted oldest first. |
| `DEZFIL_OVERPASS_CACHE_H` | `24` | How long a cached Overpass response stays fresh. |
| `DEZFIL_OSM_MAX_KM2` | `10000` | Area budget for one OpenStreetMap import. |
| `DEZFIL_OVERTURE_MAX_KM2` | `25000` | Area budget for the Overture places theme; other themes scale from it by density. |
| `DEZFIL_OVERTURE_S3_ENDPOINT` | unset, the public bucket | S3-compatible endpoint override for Overture reads, path-style. Fits a private mirror of the bucket (`src/lib/overture/releases.ts`). |

## Query engine

| Variable | Default | Effect |
|---|---|---|
| `DEZFIL_QUERY_TIMEOUT_S` | `60` | Timeout for any evaluation of user SQL: the SQL workspace, layer rendering, and published views alike. |
| `DEZFIL_QUERY_MEMORY_MB` | `2048` | Memory budget of the hardened read-only engine instance, shared by every query on it. A query past it fails with a coded error and the instance keeps serving. |
| `DEZFIL_PREVIEW_ROWS` | `1000` | Rows returned in a query or preview result. |
| `DEZFIL_SLIDER_PREVIEW_ROWS` | `50000` | Source points transferred for an interactive slider preview. |

## Rendering and tiles

| Variable | Default | Effect |
|---|---|---|
| `DEZFIL_RENDER_CAP_FEATURES` | `250000` | Features a single layer renders before the API asks for a limit or an aggregation instead. |
| `DEZFIL_TILE_BUILD_TIMEOUT_S` | `600` | Timeout for each stage of a background tile build. |
| `DEZFIL_TIPPECANOE` | `tippecanoe` | Path to the tile-building binary (`src/lib/tiles/tiler.ts`). The image installs it on the path. |
| `DEZFIL_BASEMAP_URL` | built-in styles | A MapLibre style URL that replaces the built-in basemap and pins it in both themes, for instances with no internet access (`src/lib/basemap.ts`). |

## Publishing

| Variable | Default | Effect |
|---|---|---|
| `DEZFIL_PUBLISH_FRESHNESS_S` | `30` | How stale a published view may be, which is its cache window. |
| `DEZFIL_PUBLIC_RATE_LIMIT` | `60` | Anonymous published-view requests per ten-second window, per client. |
| `DEZFIL_PUBLIC_TILE_RATE_LIMIT` | `600` | Anonymous tile requests per ten-second window, per client. One pan is dozens of tiles, so tiles get their own, larger bucket (`src/lib/publish/rate-limit.ts`). |

Published API budgets use verified ingress sources, shared across tokens, including
unknown tokens. View reads share one budget; tiles have another. Both together
retain at most 10,000 entries, expiring on traffic then evicting least recently
used entries at capacity. Eviction starts a fresh window. Readers behind an
untrusted proxy share its socket budget; trusted chains use the nearest
untrusted hop. See [self-hosting](self-hosting.md) for provenance refusals and scope.

## Image export

Server-side image export drives the application's own client bundle in a
headless browser inside the container.

| Variable | Default | Effect |
|---|---|---|
| `DEZFIL_CHROMIUM_PATH` | `/usr/bin/chromium` | The headless browser binary. The image bakes one in and sets this variable. |
| `DEZFIL_EXPORT_RENDER_TIMEOUT_S` | `90` | Budget for one render, queue wait included. |
| `DEZFIL_EXPORT_REQUEST_TIMEOUT_S` | `20` | Bound on any single request the render page makes. A slower one is abandoned, the image is still produced, and the response reports how many were dropped and from which hosts. |
| `DEZFIL_EXPORT_RENDER_CONCURRENCY` | `2` | Concurrent renders. Software rendering is CPU-expensive, so work past the cap waits inside the budget. |

## Geocoding

| Variable | Default | Effect |
|---|---|---|
| `DEZFIL_GEOCODER_URL` | unset | A Nominatim-compatible `/search` endpoint, used by place search in the builder and by the batch geocoding operation. Unset, search still answers layers, values, and coordinates, and the geocode operation is not offered. The URL stays server-side, so it may carry a key. |
| `DEZFIL_GEOCODE_PACE_MS` | `1000` | Minimum gap between two requests to that endpoint, enforced across the whole instance with one request in flight at a time. `0` means no gap. |
| `DEZFIL_GEOCODE_REQUEST_TIMEOUT_S` | `10` | Deadline for one geocoding exchange. A batch row costs the pace or this, whichever is longer, so both bound the batch size the operation accepts. |
| `DEZFIL_GEOCODE_MATCH_CACHE_HOURS` | `720` | How long a matched address is kept. |
| `DEZFIL_GEOCODE_NO_MATCH_CACHE_HOURS` | `24` | How long a no-match is kept, shorter because that is what improves when provider data does. |
| `DEZFIL_GEOCODE_CACHE_MB` | `64` | Size budget for the geocode answer cache, evicted oldest first. |

## Travel-time areas

| Variable | Default | Effect |
|---|---|---|
| `DEZFIL_ISOCHRONE_URL` | unset | A Valhalla-compatible `/isochrone` endpoint. Unset, the operation stays visible and refuses with a sentence naming this setting (`src/lib/isochrone/endpoint.ts`). |
| `DEZFIL_ISOCHRONE_PACE_MS` | `1000` | Milliseconds between isochrone requests, one exchange in flight at a time. |
| `DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S` | `20` | Whole-exchange deadline for one request. Routing answers slower than geocoding. |
| `DEZFIL_ISOCHRONE_CACHE_HOURS` | `168` | How long a fully answered isochrone is kept. Only complete answers are cached. |
| `DEZFIL_ISOCHRONE_CACHE_MB` | `64` | Size budget for that cache, evicted oldest first. |

## Operations, the background run lane

| Variable | Default | Effect |
|---|---|---|
| `DEZFIL_OPERATION_TIMEOUT_S` | `600` | Execution budget for one operation run. Time spent waiting for the lane is not charged against it. |
| `DEZFIL_OPERATION_CONCURRENCY` | `1` | Operations executing at once. They are heavy work on the shared engine, so work past the cap queues. |
| `DEZFIL_OPERATION_QUEUE_MAX` | `20` | Runs that may wait for the lane. A run arriving at a full queue is refused with a coded error. |
| `DEZFIL_OPERATION_HISTORY_PER_SUBJECT` | `20` | Runs kept per subject. The subject's most recent success is preserved inside that depth. |

## The assistant

The in-product assistant is off until a model credential is set. Without one
the surface is simply absent and everything else works unchanged
(`src/lib/assistant/config.ts`).

| Variable | Default | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Enables the assistant with Anthropic. |
| `OPENAI_API_KEY` | unset | Enables the assistant with OpenAI. |
| `DEZFIL_AI_PROVIDER` | the first key set | `anthropic` or `openai`, when both keys are present. An unknown value leaves the assistant disabled with an explanatory reason. |
| `DEZFIL_AI_MODEL` | provider default | Overrides the model. Defaults are `claude-opus-5` for Anthropic and `gpt-5.6-terra` for OpenAI. |
| `DEZFIL_AI_MODELS_ANTHROPIC` | unset | Comma-separated model identities narrowing and ordering what a person may choose. Unset offers the effective catalogue. The instance default is always present exactly once. Only the resolved provider's list applies. |
| `DEZFIL_AI_MODELS_OPENAI` | unset | The same, for OpenAI. |
| `DEZFIL_ASSISTANT_STEP_BUDGET` | `20` | Maximum model and tool steps one assistant request may take. |
| `DEZFIL_ASSISTANT_OFFER` | `subset` | Which operations a page's run is offered at the start: `subset` (that page's operations plus the grounding reads, the rest reachable through a discovery tool) or `full` (every operation the page admits, no discovery tool). Any other value reads as `subset` (`src/lib/assistant/offer.ts`). |
| `DEZFIL_ASSISTANT_AUTO_CHECK` | on | Whether the assistant looks at the rendered map by itself after a turn that changed it. `0`, `false`, or `off` turns it off; an explicit check stays available. |
| `DEZFIL_ASSISTANT_LOOK_TIMEOUT_S` | `30` | Budget for that map check, request to response. |
| `DEZFIL_ASSISTANT_LOOK_RETENTION` | `256` | Renders of the map check kept in process for the transcript, full images and thumbnails counted together, oldest evicted first. They are gone when the process restarts. |
| `DEZFIL_ASSISTANT_LOOK_RETENTION_MB` | `96` | Byte budget for those retained renders. |
| `DEZFIL_TOOL_ATTACHMENT_MAX_MB` | `32` | Cap on a download answered to an agent tool. Past it the tool gets a coded error instead. |

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
for a tunable.

- `DEZFIL_BASE_URL`: the target address for the browser test runner and the
  headless journey scripts.
- `DEZFIL_E2E_FIRST_RUN=1`: leaves account setup to the first-run browser
  journey on an empty scratch store instead of provisioning a signed-in fixture.
- `DEZFIL_TEST_PG_URL`, `DEZFIL_TEST_PG_TLS_URL`, `DEZFIL_TEST_OVERTURE`,
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
does not see them, because it scans only non-test source files under `src`.
