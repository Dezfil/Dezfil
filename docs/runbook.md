# Runbook

Operational recipes for running a self hosted instance: the things an owner
does around the container rather than inside the app. Each section stands on
its own and names the settings it touches. More recipes are added here as
they are written down.

## Running an instance locally

Node.js 24 or newer is required. Run `npm install`, then `npm run dev`: the
app serves on `http://localhost:3000`. For another port use
`PORT=3210 npm run dev` or `npm run dev -- --port 3210`. For a
production-shaped run: `npm run build`, then `PORT=3210 npm start`.

All durable state lives in one directory. `DEZFIL_DATA_DIR` names it;
unset, it defaults to `./data` under the working directory, and the image
sets `/data`. Nothing the instance needs lives outside it, so a backup is a
copy of that directory with the instance stopped.

What appears inside it as the instance is used: `metadata.sqlite` (maps,
layers, styles, published links, connections), `tables/` (the GeoParquet
artifacts), `thumbnails/`, `tmp/` (scratch for imports, exports and tile
builds), `cache/overpass/` once an OSM import runs, and `secret.key` on
first boot unless `DEZFIL_SECRET_KEY` was set first. An optional
`assistant-models.json` placed there by hand is read as described below.

## Upgrading ownership storage

Stop the instance and back up the complete data directory before upgrading,
including SQLite journal files, artifacts and `secret.key`. Preserve any
externally configured encryption key as well. Rehearse the upgrade on a copy.

The upgrade assigns existing maps, datasets, workflows, connections, projects
and operation job records to the recorded original account, even when another
account is now admin or the original account is deactivated. An installation
without accounts keeps these records pending until first-account setup. Setup
adopts them in the same transaction as the account, preferences and session.
Failed adoption rolls back and can be retried. Existing identities, SQL,
public links, credentials, memberships and artifact paths are preserved.
New resources take their owner from the authenticated creator; request fields
cannot assign a different owner. Dataset and connection names are unique within
that owner; two accounts may use the same names and keep distinct identities.
After duplicate names exist across accounts, an older build with global name
constraints cannot read that store safely. Restore its matching backup as well.

Restore the matching old application and the complete pre-upgrade backup to
roll back. An older build cannot safely write the upgraded metadata schema.
Account for work written after the backup before restoring it.

Named SQL runs against connection-local temporary views for its owner. Existing
`main.table`, `memory.table`, `memory.main.table` and computed dynamic named
references remain valid without editing saved SQL. A warm artifact metadata
cache does not retain dataset views between evaluations. Publication queries
retain their owner's scope even when that account is deactivated. See
[the SQL boundary](api.md#the-read-only-sql-instance) for the execution rules.

## A second isolated instance

Two instances must not share a port or a data directory. Give the second one
both of its own and leave the first untouched:

```sh
DEZFIL_DATA_DIR=/tmp/dezfil-scratch PORT=3210 npm run dev
```

The standard dev, start and container commands install the ingress preload
before Next starts. It records the socket peer and normalizes forwarding
headers. A standalone launch uses
`node --import=./scripts/ingress-preload.mjs server.js`; include
`scripts/preload-options.mjs` and `src/lib/auth/ingress.mjs` too. Readiness and
authentication entry refuse a missing preload. Existing observer preloads in
`NODE_OPTIONS` continue to run, including in Next's development child.

Behind a reverse proxy, set `DEZFIL_TRUSTED_PROXIES` to its socket addresses
or CIDRs. The proxy must append the actual client to the source chain and
replace host, protocol and port forwarding fields. Both `Forwarded` and the
four `X-Forwarded-*` fields are normalized to one view; conflicting trusted
fields are refused. Untrusted peers' forwarding fields are discarded.

The same shape works against a built tree with `npm start`. Point every
drive script and browser run at the new address: those scripts write real
tables, maps and published links, and a scratch data directory keeps those
writes out of working data. Setting `DUCKDB_EXTENSION_DIR` to a shared
directory stops each instance fetching its own extensions.

## The checks

`npm run lint` runs ESLint over the repository. Each named gate holds one
rule:

- `npm run lint:hygiene` rejects a NUL byte in any tracked text file, which
  makes git and grep treat a source file as binary.
- `npm run lint:readme` compares the settings the server reads from the
  environment with the configuration table in `README.md`, both directions.
- `npm run lint:size` holds the line-count ceilings of the oversized
  modules: growing one fails until the ceiling is raised in the same change,
  shrinking one until it is lowered to match.
- `npm run lint:stage-edge` fails when the map stage's left edge reappears
  as a literal instead of the single custom property.
- `npm run lint:wheelhouse` holds the design vocabulary against the token
  set: off-ramp font sizes, radii outside the closed family, motion beats,
  raw colour literals in component styles, banned glyph classes,
  focus-outline suppression and stray arrow cursors.
- `npm run lint:tokens` fails on a `var(--x)` reference with no definition
  in an authored stylesheet or a credited TypeScript one. A fallback value
  does not excuse an undefined token.
- `npm run lint:icons` fails when a builder component grows an inline
  `<svg>` past its inventoried count, or a new file gains one.
- `npm run lint:specimen` fails when the design specimen page would change
  if regenerated, which a shipped token, stylesheet or palette makes happen.
- `npm run lint:plugin` fails when the plugin package's guidance file or its
  bundled licence drifts from the canonical source they are rendered from.

Types: `npm run typecheck`. Unit suite: `npm test` (Vitest, over
`src/**/*.test.{ts,tsx}`), with 30-second per-test and per-hook timeouts
because a couple of engine-seeding cases dominate the run on a two-core
machine. Some unit tests build real tiles, so keep `tippecanoe` on `PATH`;
`npm run test:watch` reruns on change.

## The browser suite

Browser and HTTP journeys target an isolated scratch instance. Shared fixtures
create the first account (or sign back into that fixture account) and mint a
user token before protected work. Browser setup saves its cookie session in
`.claude/browser-auth.json`; API fixtures supply the instance Origin on mutations.
Readiness polls and published readers remain anonymous. To run the separate
first-account UI journey on an empty store, use `DEZFIL_E2E_FIRST_RUN=1` with
`npx playwright test e2e/account-entry.spec.ts`; global setup then leaves setup
to that journey. Run the rest against a fresh scratch store with this flag unset.

`npm run journey:browser` runs every spec under `e2e/` with Playwright
against an already running instance: one worker, no retries, a 240-second
per-test bound, traces retained on failure. The target comes from
`DEZFIL_BASE_URL`, default `http://localhost:3000`. The first run on a
machine needs `npx playwright install chromium`. The suite runs on your own
machine only: the pipeline has no browser job, so nothing runs it for you.
On a hosted runner it did not reliably finish inside the available time
bound, the standalone build, the browser download, the tiler build and the
extension install all landing before the first test started, so there is no
job to fix rather than a job that times out.

Subsets run by area: `npm run e2e:keyboard`, `e2e:layers`, `e2e:imports`,
`e2e:sqlbridge`, `e2e:sqlconsole`, `e2e:draw`, `e2e:styling`,
`e2e:recovery`, `e2e:lifecycle`, `e2e:theme`, `e2e:states`, `e2e:pixel`,
`e2e:statepixels`, `e2e:wheelhousepixels`, `e2e:a11y-pixels`,
`e2e:primitives`, `e2e:smoke`.

Required on the server for a green full run. Without these the affected
tests fail rather than skip:

- `DEZFIL_RENDER_CAP_FEATURES=2000`, so the 52,001-feature layer tiles;
- `DEZFIL_EGRESS_ALLOWLIST=127.0.0.1`, for the URL-import loopback fixture;
- `DEZFIL_OVERPASS_URL=http://127.0.0.1:31877/overpass`, the recorded OSM
  fixture the suite serves itself on that port;
- `DEZFIL_OVERTURE_S3_ENDPOINT=127.0.0.1:31878`, the loopback object-store
  fixture the suite starts itself;
- `tippecanoe` on the server's `PATH`, since the lowered cap tiles that
  layer.

Optional; absent, the gated tests skip visibly:

- `DEZFIL_TEST_PG_URL` in the test process with a running
  `postgis/postgis:16-3.4` container, for the live PostGIS drives;
- `DEZFIL_DATA_DIR` in the test process, the server's own value, for the
  real failed-tile-build drive;
- `DEZFIL_E2E_ASSISTANT=1` plus a server-side model key, for the assistant
  confirmation smoke (`npm run e2e:smoke` sets that opt-in itself).

The suite blocks third-party hosts, so it needs no internet beyond the
instance itself.

## Driving the API without a browser

`node scripts/journey.mjs <base-url>` walks the documented API end to end:
readiness, the machine-readable description, upload, SQL, layer, style,
publish, exiting non-zero on the first broken step.

On a runner without a browser, append `--http-only` to the API journey. It
prints the omitted image-render step explicitly; the default journey and CI
still require the real image-export proof.

The authentication probes run against an already running scratch instance:

- `npm run probe:gate -- <base-url>` checks protected operations and anonymous
  exceptions. Start it on an empty store so it can check setup before provisioning.
- `npm run probe:login -- <port>` checks socket-based sign-in limits and waits
  for recovery at the real retry deadline (about fifteen minutes). Use a fresh store
  and a dual-stack listener with `DEZFIL_TRUSTED_PROXIES=127.0.0.1`; `--no-wait`
  omits only the recovery check.
- `npm run probe:published-auth -- <base-url>` checks anonymous published data,
  widgets and real tiles. Set `DEZFIL_RENDER_CAP_FEATURES=2000` on the server and
  keep `tippecanoe` on its `PATH`.

`node scripts/account-upgrade-proof.mjs [port]` runs only in a detached linked
worktree after a production build. It creates a synthetic old-schema store
under `.claude/`, upgrades a copy, exercises the old data through authenticated
HTTP, restarts the server, and restores a separate copy from the unchanged
seed. Its evidence records file hashes and distinguishes copied credential
usability from an unexecuted live external PostGIS connection. It never takes
an operator data-directory argument.

`node scripts/mcp-journey.mjs <base-url>` runs the same journey over the MCP
endpoint with no model involved; `--render` adds the real-render arm, which
needs the instance's own Chromium. Run it in the instance's network
namespace with loopback egress allowed.

`npm run journey:recovery` needs `npm run build` first. It starts a server,
gets a run executing, kills the process outright, restarts on the same data
directory and asks the API what became of the run. It defaults to port 3197;
`node scripts/recovery-journey.mjs --port 3199` chooses another.

`node scripts/durability.mjs seed <base-url> <scratch-state-file>`, then the same script with
`verify <base-url> <scratch-state-file>` after the container is replaced against the same volume,
proves resource and session/token survival, plus refusal of revoked credentials.
The seed writes credentials and resource identifiers in a mode-0600 state file
(default `durability-state.json`)
in the working directory. `node scripts/big-data.mjs <base-url>
[approx-rows]` drives a dataset beyond browser-memory scale. Point all of
these at a scratch instance on its own data directory.

## The container image

```sh
docker build -t dezfil .
docker run -d --name dezfil -p 3000:3000 -v dezfil-data:/data dezfil
```

Readiness is `GET /api/health`, expected within 30 seconds of the container
starting; the pipeline polls for exactly that long and fails otherwise. The
image carries what the source tree does not:

- `tippecanoe`, compiled from source in its own build stage, so tiled
  rendering works without a host install;
- Chromium plus a certificate bundle and fallback fonts, driven through
  software GL by the server-side image export (`DEZFIL_CHROMIUM_PATH`);
- the DuckDB extension bundle, baked at build time into
  `/app/duckdb-extensions`, so a running instance needs no network;
- the native packages the standalone tracer misses, copied in whole;
- `public/`, `LICENSE`, `NOTICE` and the model catalogue file at its
  source-relative path, copied explicitly.

It runs as the unprivileged `node` user, exposes 3000 and declares `/data`
as its volume. Two checks belong to the image, not the source tree:

```sh
node scripts/check-image-inventory.mjs dezfil:ci
docker run --rm --network=none -v "$PWD/scripts:/scripts:ro" \
  dezfil:ci node /scripts/check-duckdb-extensions-offline.mjs
```

The first fails when `/app` holds anything outside the checked-in
allowlist, or when repository metadata, a data directory, database or key
material, or environment files appear anywhere. The second proves every
supported extension loads with the network disabled.

## Regenerating what is generated

**The design specimen.** `node scripts/build-specimen.mjs` rewrites the fed
sections of the specimen page from the shipped sources: the light and dark
token blocks, every component stylesheet in the UI kit, and the palette
ramps. `--check` on the same script is what `npm run lint:specimen` runs.
Re-run it whenever a token, a kit stylesheet or a palette changes.

**The plugin guidance file.** `node scripts/generate-dezfil-guidance.mjs`
rewrites the skill's analysis document and its bundled licence from the one
canonical source; `--check` is `npm run lint:plugin`. Re-run on any change
to that source.

**The plugin package.** `node scripts/prepare-dezfil-plugin.mjs --output
<new-directory> --base-url <origin>` writes a self-contained copy carrying
the chosen endpoint and the local catalogs for both clients. Omitting
`--base-url` selects `http://localhost:3000`; an occupied destination is
refused. Prepare a fresh copy whenever the instance address changes.

**Pixel baselines.** The snapshots live beside their specs in the
`*.spec.ts-snapshots` directories. Regenerate against a provisioned instance
one spec at a time so no unrelated shot is rewritten:

```sh
npx playwright test e2e/pixel-regressions.spec.ts --update-snapshots
```

Baselines are platform-specific: shots generated on one operating system do
not match another, so a pixel spec run on a machine unlike the one that
recorded its baseline skips rather than reporting a difference. Only
regenerate when the change to the rendered surface is intended.

**The API description.** There is no emit step: the document is built at
request time and served at `/api/openapi.json`, with human-readable pages at
`/developer`. The API journey asserts it is served and well formed.

**The frozen assistant baselines.** The committed captures under
`test-support/assistant-baselines/` are read back whole by the unit suite
and compared against fresh derivations from the product's own builders. No
script regenerates them, deliberately: a failure means a surface the
comparison exists to hold has moved, so confirm the change is intended, then
refresh the captures by hand.

## The spatial engine extensions

The engine needs several DuckDB extensions: spatial, h3, httpfs, json,
postgres, azure and aws. One exported list is shared by the installer and
the offline check, so the bundle cannot drift from what the product needs.

```sh
node scripts/install-duckdb-extensions.mjs "$PWD/duckdb-extensions"
```

That downloads and caches them into the named directory; point the instance
at it with `DUCKDB_EXTENSION_DIR`. The image runs the same script at build
time, which is why a container needs no network for them.

An empty or stale cache shows up as an import or query failing on a missing
extension, or a test run pausing mid-suite while the engine fetches from the
public extension host. Either way: run the installer again against the
directory, then restart the instance. With no outbound network the installer
cannot fill an empty cache; copy a populated directory in from a machine
that could, or use the image.

## Troubleshooting

**The extension install fails on a TLS error.** A slim base image ships no
certificate authority bundle and the extensions come over HTTPS: install
`ca-certificates` before running the installer there.

**A layer over the render cap reports a missing tiler.** `tippecanoe` is
not on `PATH`. Install it or set `DEZFIL_TIPPECANOE`. Everything below the
cap keeps working without it.

**A browser run fails instead of skipping.** Check the required provisioning
on the server process, not the test process: a missing render cap override,
loopback allowlist entry or tiler each turns a drive into a real failure.

**The image export fails while health stays green.** The headless browser
is missing or unreachable at `DEZFIL_CHROMIUM_PATH`. That split is
deliberate: removing the browser leaves readiness alone.

**Stored connection credentials stop decrypting.** They are encrypted with
`DEZFIL_SECRET_KEY`, or the `secret.key` generated into the data directory
on first boot. Changing that variable later, or losing `secret.key` while
keeping `metadata.sqlite`, makes them unreadable and those connections must
be entered again. To pin the key without loss, set `DEZFIL_SECRET_KEY` to
the hex string already in `secret.key`.

**The model catalogue silently falls back.** An instance
`assistant-models.json` is rejected whole on any invalid entry and the
shipped catalogue applies instead; `GET /api/assistant` says which.

**A script collides with the development server.** These scripts write real
state and bind real ports: give them their own port and `DEZFIL_DATA_DIR`,
never the port the development server holds.

## The model catalogue file

The maintained model names and per-model effort levels live in
`src/lib/assistant/model-catalogue.json`, shipped at
`/app/src/lib/assistant/model-catalogue.json` in the runtime image.
An optional `assistant-models.json` directly in `DEZFIL_DATA_DIR` adds and
overrides entries for that instance. There is no separate path setting.

For example, this instance file overrides one shipped entry and adds one local
identity under each provider. The local identities illustrate the shape; they
are not claims that either provider serves a model by those names.

```json
{
  "openai": [
    { "id": "gpt-6-astra", "name": "Astra", "efforts": ["low", "medium", "high", "xhigh"] },
    { "id": "local-openai-model", "name": "Local OpenAI", "efforts": [] }
  ],
  "anthropic": [
    { "id": "claude-opus-5", "name": "Opus 5", "efforts": ["low", "medium", "high", "xhigh", "max"] },
    { "id": "local-anthropic-model", "name": "Local Anthropic", "efforts": ["low", "high"] }
  ]
}
```

The top level is an object whose only fields are `openai` and `anthropic`, each
an ordered list. Both lists are required in the shipped copy; either may be
omitted from the instance copy. A model has exactly `id`, `name` and `efforts`:
a nonblank identity and display name, and a list of distinct effort words.
OpenAI words are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`;
Anthropic words are `low`, `medium`, `high`, `xhigh`, `max`. Empty effort lists
are valid. Do not author `default`: Dezfil supplies it first for every model,
with the fixed labels `Default`, `None`, `Minimal`, `Low`, `Medium`, `High`,
`XHigh` and `Max`. Levels state supported choices, not equivalent amounts of
work across models.

Identity is scoped to its provider. An instance entry replaces the whole
shipped entry with that identity, keeping its shipped position. New identities
append in instance-file order. Omitted entries, omitted providers and empty
lists hide nothing. An instance override wins over the shipped copy.

Each file is limited to **256 KiB (262,144 bytes)**. Invalid JSON, an unknown
field or provider, an invalid shape, duplicate identities within a provider,
missing or blank names/identities, invalid or repeated efforts, an unreadable
file or an oversized file rejects the whole instance copy. A bad entry under
the other provider also rejects it. Nothing is partially applied and no older
valid instance copy is retained: the shipped catalogue applies instead. Keep
the shipped copy valid; the instance fallback is not recovery for a broken
installation's shipped file.

`GET /api/assistant` reports `catalogue` when enabled:

| `source` | `instance` | Meaning |
|---|---|---|
| `shipped` | `absent` | No instance file. This is normal. |
| `merged` | `applied` | A valid instance file applied, including a valid empty copy. |
| `shipped` | `rejected` | The instance file was rejected. `reason` identifies the field or read failure without file contents. |

Only `rejected` carries `reason`. These fields describe the same snapshot as
the response's offered models. The disabled read retains its enablement
explanation and offers no models. Catalogue reads make no provider calls.

With the resolved provider's model-list environment variable unset, the whole
effective catalogue is offered in order. `DEZFIL_AI_MODELS_OPENAI` and
`DEZFIL_AI_MODELS_ANTHROPIC` narrow and order that offer: trim entries, ignore
blanks, keep the first occurrence, and prepend the instance default only if
missing. A set empty or separators-only list offers the default alone. Naming
only `gpt-5.6-terra` for OpenAI or `claude-opus-5` for Anthropic explicitly
reaches the one-model state, unless `DEZFIL_AI_MODEL` sets a different
default. Unknown listed identities and unknown defaults remain requestable,
named by identity with only `default` effort. Listing a model does not establish
provider availability, and a catalogue never enables a missing credential.

To replace a catalogue by hand or by an owner-managed job, write a complete
replacement beside the target, then rename it into place on the same filesystem.
For example, prepare `assistant-models.json.next` in `DEZFIL_DATA_DIR`, then:

```sh
mv "$DEZFIL_DATA_DIR/assistant-models.json.next" "$DEZFIL_DATA_DIR/assistant-models.json"
```

A read then sees the old complete file or the new complete file. Direct
in-place edits can expose partial JSON and trigger rejection during the edit.
A replacement completed before a read begins is visible to the next enabled
status read and new message admission, without a restart. Removing the file
restores shipped knowledge; repairing it applies on the next read. Editing a
source checkout's shipped file also takes effect on its next read, but does
not change the copy baked into an already built image. Use the data-directory
copy for normal production updates.

An open pane keeps the status it read at mount. File replacement and a choice
refusal do not refresh that pane. A stale choice is refused before binding;
the message is preserved. Remounting reads the new offer and reconciles the
remembered model and effort. Already bound turns and their continuations keep
their original pair.

**Replacing the instance file loses manual edits to that file.** An owner-managed
job must merge those entries into its replacement, or the owner keeps them in
the repository's shipped copy and ships that copy with the instance. An
instance override still wins for the same identity. Dezfil supplies no cron
setup, refresh job or provider discovery. Effort levels remain manually
maintained.
