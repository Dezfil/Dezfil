# Runbook

Operational recipes for running a self hosted instance: the things an owner
does around the container rather than inside the app. Each section stands on
its own and names the settings it touches. More recipes are added here as
they are written down.

## Running an instance locally

Node.js 24 or newer is required. Run `npm ci`, then `npm run dev`: the
app serves on `http://localhost:3000`. For another port use
`PORT=3210 npm run dev` or `npm run dev -- --port 3210`. For a
production-shaped run: `npm run build`, then `PORT=3210 npm start`.

All durable state lives in one directory. `DEZFIL_DATA_DIR` names it;
unset, it defaults to `./data` under the working directory, and the image
sets `/data`. Back up that directory with the instance stopped and preserve any
externally supplied encryption key.

What appears inside it as the instance is used: `metadata.sqlite` (maps,
layers, styles, published links, connections, accounts, sessions, token records,
workflows and runs), `tables/` (the GeoParquet
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
Other accounts start with their own empty space. An admin flag does not grant
access to the original account's content or a way to reassign it: only an
owner can transfer their project, map or workflow, to someone it is already
shared with. Deactivation freezes private work; reactivation restores access to
the same records. Existing published links keep their read-only projection.
New resources take their owner from the authenticated creator; request fields
cannot assign a different owner. Dataset and connection names are unique within
that owner; two accounts may use the same names and keep distinct identities.
After duplicate names exist across accounts, an older build with global name
constraints cannot read that store safely. Restore its matching backup as well.

Restore the matching old application and the complete pre-upgrade backup to
roll back. A build predating ownership or sharing cannot safely write those upgraded stores.
The later edit-revision additions alone remain compatible with the immediately
preceding writers. That compatibility does not replace a rollback backup.
Account for work written after the backup before restoring it.

The project-sharing storage upgrade takes the same backup. It gives every
account a SQL name, derived from the display name (else the email's local
part, else `user`, with a number added on a collision or on a name the query
engine reserves) and fixed from then on. It marks each map and workflow with
its owner's space as its SQL home, and records which account started each
workflow run and produced each step output. Nothing is shared by it: every
project keeps its owner and has no members. An installation still awaiting
first-account setup receives the homes and run records in the setup
transaction. The upgrade is one transaction: a failure leaves the store as it
was, and the next start tries again.

Named SQL runs against connection-local temporary views for its owner. Existing
`main.table`, `memory.table`, `memory.main.table` and computed dynamic named
references remain valid without editing saved SQL. A warm artifact metadata
cache does not retain dataset views between evaluations. Publication queries
retain their owner's scope even when that account is deactivated.

**Breaking SQL change:** user file readers and engine path discovery are refused
even for an owned file or an existing path. File-referencing PROJ definitions
(including computed CRS values, initialization files, grids and models) are
also refused. EPSG identifiers and inline definitions without files still work.
Saved SQL and publication tokens survive unchanged; an affected query or published layer fails until its owner
changes the SQL to refer to an uploaded dataset by name. Review saved queries
for file readers, file-relation shorthand and metadata definition/path access
before upgrading. See
[the SQL boundary](api.md#the-read-only-sql-instance) for the execution rules.

Unlabelled browser SQL drafts and history from older releases cannot be
attributed to an account and are discarded when the private workspace first
opens. Copy any draft you need before upgrading. Once labelled, same-account
reloads retain drafts; sign-out or an account change clears private browser
memory, including assistant recovery locators and prepared download state.
Saved layer and workflow SQL in the data directory is unaffected by this
browser cleanup.

## Full backup and restore

Stop every process using the directory before copying it. For a checkout managed
by a service, stop that service first. With absolute paths chosen for your host:

```sh
store=/srv/dezfil/data
backup=/srv/backups/dezfil-stopped
# Stop the instance before this copy. The destination must not already exist.
test ! -e "$backup"
cp -a "$store" "$backup"
```

Keep the application version and deployment configuration with the backup. Include
`secret.key` if generated; store the exact externally supplied `DEZFIL_SECRET_KEY`
securely if you use one. Preserve SQLite journal/WAL files and all artifacts,
account/session/token records, model catalogue, caches and thumbnails.

Restore with the instance stopped, keeping the displaced directory for inspection:

```sh
store=/srv/dezfil/data
backup=/srv/backups/dezfil-stopped
test ! -e "$store.before-restore"
mv "$store" "$store.before-restore"
cp -a "$backup" "$store"
# Start the matching application version with the matching encryption key.
```

For the named Docker volume in the README, use your installed image to copy the
stopped volume. Choose an empty backup directory and keep its contents private:

```sh
docker stop dezfil
mkdir -m 700 "$PWD/dezfil-backup"
docker run --rm --user root --entrypoint sh \
  -v dezfil-data:/data:ro -v "$PWD/dezfil-backup:/backup" dezfil \
  -c 'cp -a /data/. /backup/'
```

Restore into a new volume so the current copy remains available:

```sh
docker volume create dezfil-restored
docker run --rm --user root --entrypoint sh \
  -v dezfil-restored:/data -v "$PWD/dezfil-backup:/backup:ro" dezfil \
  -c 'cp -a /backup/. /data/ && chown -R node:node /data'
docker run -d --name dezfil-restored -p 127.0.0.1:3210:3000 \
  -v dezfil-restored:/data dezfil
```

Use the backed-up image version and supply the original external encryption key,
if any, through your deployment's secret mechanism. Check sign-in, datasets, maps,
workflows and published links on the isolated restore before routing traffic to it.
Token secrets cannot be read back. Restored credentials keep their backed-up
validity and expiry; revocations made after the backup are absent. Review access
before exposing the restore. No restoration can recover later writes.

To rehearse an upgrade, start the new image against a separate copy of this stopped
backup on an isolated port. Check readiness, sign-in and representative saved work,
then stop the rehearsal. Only then start the new image on the original directory.
An upgrade from a release without accounts still needs first-admin setup under
restricted access. Existing last changers and history authors start unknown; new
changes record their own actors. Legacy runs keep their stored or adopted initiator. See
[self-hosting](self-hosting.md#upgrading) for the attribution limits.

## Admin account recovery

Run these in a terminal, using the application version matching the existing
store. The origin is the address the recipient will open, with no path, query,
credentials or fragment. `--email` matches a normalized exact email; omit it only
when there is exactly one active admin.

Checkout:

```sh
npm run admin:recover -- --data-dir /srv/dezfil/data \
  --origin https://maps.example.com --email admin@example.com
```

Running container:

```sh
docker exec -it dezfil node scripts/admin-recover.mjs \
  --data-dir /data --origin https://maps.example.com --email admin@example.com
```

One-off container against the stopped volume, without starting the server:

```sh
docker run --rm -it -v dezfil-data:/data dezfil \
  node scripts/admin-recover.mjs --data-dir /data \
  --origin https://maps.example.com --email admin@example.com
```

The last two commands allocate a TTY because the link is terminal-only. Do not
pipe it to a log. The command selects an active admin in a setup-complete compatible
store; it never initializes, upgrades, promotes or reactivates an account. A busy
store is retried for at most five seconds and then refused without changes.
Successful issuance revokes that account's password, earlier links, sessions and
API/MCP tokens and prints one fragment link with account and expiry. Open it
within fifteen minutes and choose a password. Other accounts are unaffected.
This is not compromise cleanup; see the [limits](self-hosting.md#recovering-an-admin-account).

`admin:recover` restores account entry. `journey:recovery` is a separate test of
workflow-run recovery after a server restart; it is not an account command.

## Headless clients

Create an API / MCP token in Settings, copy the secret once and supply it as
`DEZFIL_API_TOKEN` through your client's secret storage. It grants the same current
permissions as that account, including project roles, with no admin content bypass.
The following shell example requires `curl` and `jq`. It creates a private map,
reads it and chains two accepted writes before printing the resulting revision:

```sh
set -eu
base=https://maps.example.com
: "${DEZFIL_API_TOKEN:?Supply an account token}"
request() { curl --fail-with-body -sS -H "Authorization: Bearer $DEZFIL_API_TOKEN" "$@"; }
created=$(request -X POST "$base/api/maps" -H 'Content-Type: application/json' -d '{"name":"Field notes"}')
id=$(printf '%s' "$created" | jq -er '.id')
current=$(request "$base/api/maps/$id")
revision=$(printf '%s' "$current" | jq -er '.editRevision')
changed=$(request -X PATCH "$base/api/maps/$id" -H 'Content-Type: application/json' \
  -H "X-Edit-Revision: $revision" -d '{"name":"Survey map"}')
revision=$(printf '%s' "$changed" | jq -er '.editRevision')
changed=$(request -X PATCH "$base/api/maps/$id" -H 'Content-Type: application/json' \
  -H "X-Edit-Revision: $revision" -d '{"basemap":"light"}')
printf '%s' "$changed" | jq -er '.editRevision'
```

A 409 `stale_revision` stops the example. Inspect a fresh read and deliberately
compose a new edit; do not attach its token to the refused payload and replay it.
A 400 `invalid_request` for a missing revision means the client must implement the
read/write contract. Child writes use the parent's revision. See the
[API](api.md#editing-with-revisions) and [MCP](mcp.md#editing-with-revisions)
guides for compound filing, run starts, exceptions and executable examples.

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

- `npm run lint:contract-docs` compares the API and MCP guides’ reader-facing
  counts and complete error catalogue with the served contract and derived tools.
- `npm run lint:reader-docs` rejects superseded account/configuration copy and
  revision examples missing their preconditions or accepted-result chain. The
  unit suite also executes those examples and seeds missing/stale revisions.

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
an operator data-directory argument. Owner stamps, histories, memberships,
lineage and standalone jobs must survive adoption and restart; another admin
must still receive the same refusal as for missing private work.

`node scripts/ownership-journey.mjs seed <base-url> <scratch-state-file>`
provisions an admin and two ordinary accounts on an empty scratch instance.
Each imports the same SQL name and completes a map, workflow, publication and
export loop. The journey compares hidden and missing resources through REST
sessions, tokens and MCP, checks compound-write rollback, concurrent queries
and anonymous publication scope. Replace the server against the same store,
then run `verify <base-url> <scratch-state-file>` to repeat those assertions
with the saved sessions and tokens. Use an owned loopback port of 3300 or
higher. The state file is created exclusively with mode 0600.

`node scripts/sharing-journey.mjs seed <base-url> <scratch-state-file>`
provisions an admin and four ordinary accounts on an empty scratch instance:
an owner who shares a project once as Viewer and once as Editor, and a
non-member. The seed walks the sharing rules end to end: the Viewer's writes
refused alike with nothing changed, the Editor's edit, run, filing and
qualified layer, the Editor's refused SQL and publication changes, a dataset
removed from the project, the published link with a catalogue probe, both
transfers and both deactivations. `verify <base-url> <scratch-state-file>`
repeats the read-side assertions with the saved credentials after the server
is replaced: listings and the project export telling two people's `roads`
apart, the right rows through the console and MCP, hidden equal to missing
for the non-member, and same-named SQL evaluated concurrently. Both print
every refusal body they compared. With `--assistant-wire=<port>` they also
read through the assistant's tool path over a scripted model wire the script
serves on that loopback port; start the instance for that with
`DEZFIL_AI_PROVIDER=openai`, any `OPENAI_API_KEY` and
`OPENAI_BASE_URL=http://127.0.0.1:<port>/v1`, and run the script where the
instance can reach the port (in a container, in its network namespace). Use
an owned loopback port of 3300 or higher.

The pipeline's image job runs both journeys after every merge this way: each
on a fresh volume of its own, seeded, the container replaced over that
volume, then verified, driven from the MCP probe client image in the
instance's network namespace, the sharing one over its scripted wire.

The ownership and sharing journeys' route-handler tests also run without a
listening socket (the sharing one serves its scripted model wire on an
ephemeral loopback port). Their SQLite reopen and engine reset do not establish process or
container restart behavior; run the HTTP commands for that evidence.

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
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data dezfil
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

## Request transport probe

Run the whole-body probe on a production standalone built in an isolated checkout,
with the native ingress preload and a fresh scratch store. The client must see the
same data directory and server log; it observes upload scratch growth while still
sending. Do not run it against a user's store. For example, from the isolated
build checkout (ports 3391 and 3392 must be free):

```sh
transport_data=$(mktemp -d "$PWD/.tmp-transport-XXXXXX")
DEZFIL_DATA_DIR="$transport_data" DEZFIL_UPLOAD_MAX_MB=257 HOSTNAME=127.0.0.1 PORT=3391 \
  node --import=./scripts/ingress-preload.mjs .next/standalone/server.js \
  > "$transport_data/server.log" 2>&1 &
transport_pid=$!
# Wait for GET http://127.0.0.1:3391/api/health to return 200.
DEZFIL_DATA_DIR="$transport_data" DEZFIL_UPLOAD_MAX_MB=257 \
  npm run probe:transport -- http://127.0.0.1:3391 --server-log "$transport_data/server.log"
kill "$transport_pid"
```

Repeat with a **new** scratch directory, `DEZFIL_UPLOAD_MAX_MB=1`, `PORT=3392`,
and the client command below to test the configured multipart file boundary:

```sh
DEZFIL_DATA_DIR="$transport_data" DEZFIL_UPLOAD_MAX_MB=1 \
  npm run probe:transport -- http://127.0.0.1:3392 --server-log "$transport_data/server.log" --file-limit-only
```

For the container, run each arm in a fresh container. The image job uses these
commands for the main arm, then repeats with port 3392, cap 1 and
`--file-limit-only`. The preload is the same as the image's default command;
redirection makes its log visible to the probe within the network namespace.

```sh
docker run -d --rm --name dezfil-transport --network=none \
  -e PORT=3391 -e DEZFIL_DATA_DIR=/data -e DEZFIL_UPLOAD_MAX_MB=257 \
  -v "$PWD/scripts:/probes:ro" dezfil:ci \
  sh -c 'exec node --import=./scripts/ingress-preload.mjs server.js > /data/transport-server.log 2>&1'
# Wait for health from inside this container.
docker exec dezfil-transport node /probes/transport-probe.mjs \
  http://127.0.0.1:3391 --server-log /data/transport-server.log
docker stop dezfil-transport
```

Green prints JSON with `"label": "confirmed"`, elapsed seconds, exact file sizes
and independently counted rows, growing scratch samples, workflow validation
answers, public refusal byte counts, and empty TRACE answers. Declared public
excess writes zero body bytes; a paced 4 MiB chunked sender must receive 413 by
81,920 bytes (65,536 plus fixed 16,384-byte scheduling slack). Red prints
`"label": "failed"` and the failing assertion, then exits 1. A missing response
times out. Missing rows, scratch growth only after sending, and any framework
truncation warning fail independently. The file-limit arm preserves the receiver's
existing boundary: one byte below the configured cap succeeds; exact and above
answer `upload_too_large` without a table or scratch file.

Run `npm run probe:gate -- http://127.0.0.1:3391` separately against another fresh
preloaded store for the unchanged complete native refusal matrix. These probes
assert behavior, not an RSS or latency improvement; compare the image job's total
duration separately when assessing its added cost.

### JSON body and MCP admission probe

Use an isolated production standalone or container, never a working data store.
The full probe includes the large-upload and paced anonymous transport arms,
then drives every documented JSON reader at minus-one, exact and plus-one
bytes with declared and chunked UTF-8 and escaped input. It exercises maximal
sketch, icon, export and viewer fixtures, compares resource state after
refusals, and counts all rows in the stock MCP client's near-ceiling upload.
It prints each fixture's bytes, MCP envelope overhead, check counts and elapsed
seconds. Keep the separate 1 MiB upload-limit arm.

The server must preload ingress, use `DEZFIL_UPLOAD_MAX_MB=257`, and enable
the assistant with `DEZFIL_AI_PROVIDER=openai OPENAI_API_KEY=scripted-wire`.
The assistant controls refuse in validation, before any provider call. The
workstation server also needs `DEZFIL_CHROMIUM_PATH` pointing to its headless
browser and `DEZFIL_EGRESS_ALLOWLIST=127.0.0.1`, as in the journeys, for the
export control. Without the browser it answers 503 and stops the probe. The
container supplies the browser and needs no extra export configuration. The
client's `DEZFIL_DATA_DIR` must point at the server's isolated data directory
so it can observe upload scratch growth. Use port 3391 for the full arm and
3392 for the 1 MiB arm. The client install needs the lockfile's stock MCP
client; the separate probe image supplies it without adding it to production.

Against an already running production standalone on port 3391:

```sh
DEZFIL_DATA_DIR="$PWD/.claude/test-data/body-server" npm run probe:body -- http://127.0.0.1:3391 --server-log "$PWD/.claude/logs/body-server.log"
```

Against a container named `dezfil-body`, with its log at
`/data/body-server.log`, use the separately built `dezfil-mcp-probe:ci` image:

```sh
docker run --rm --network=container:dezfil-body --volumes-from dezfil-body -e DEZFIL_DATA_DIR=/data -v "$PWD/scripts:/probe/scripts:ro" dezfil-mcp-probe:ci node /probe/scripts/body-probe.mjs http://127.0.0.1:3391 --server-log /data/body-server.log
```

On a separate instance configured with `DEZFIL_UPLOAD_MAX_MB=1`:

```sh
DEZFIL_DATA_DIR="$PWD/.claude/test-data/file-limit-server" DEZFIL_UPLOAD_MAX_MB=1 npm run probe:transport -- http://127.0.0.1:3392 --server-log "$PWD/.claude/logs/file-limit-server.log" --file-limit-only
```

Green exits zero with `"label":"confirmed"`, 63 JSON operations and 756
boundary checks, the measured fixture bytes, and a counted MCP upload. A red
exits nonzero with `"label":"failed"` and the failed assertion. Truncation, a
swallowed refusal, an unbounded MCP handoff, changed resource state, missing
rows, an unavailable renderer, or missing evidence all fail the probe. The
route-level unit uses the same probe with an injected transport and image
renderer; it does not establish real-socket or framework-copy behavior.

### Publication source and state probe

Use four fresh standalone processes or four sequential containers, one per arm:
`direct` on 3393, `trusted` on 3394, `untrusted` on 3395, and `missing` on 3396.
Every server uses `DEZFIL_DATA_DIR` pointing to its own empty scratch directory,
`DEZFIL_PUBLIC_RATE_LIMIT=4` and `DEZFIL_PUBLIC_TILE_RATE_LIMIT=2`. Only `trusted`
sets `DEZFIL_TRUSTED_PROXIES=127.0.0.1`; all other arms explicitly leave it empty.
These are controlled proxy requests over a real loopback socket. Direct traffic
binds the client's local address to 127.0.0.1 and 127.0.0.2; the workstation must
have both available. On macOS, the direct arm needs a loopback alias for
127.0.0.2 or must run in the container. Linux routes the whole loopback network;
the IPv4-only image uses these same two addresses.

Start the standalone from its isolated build directory (substitute the checkout's
absolute `scripts` path for `$PROBES` and a fresh directory for `$SCRATCH`):

```sh
PORT=3393 HOSTNAME=127.0.0.1 DEZFIL_DATA_DIR="$SCRATCH" DEZFIL_PUBLIC_RATE_LIMIT=4 DEZFIL_PUBLIC_TILE_RATE_LIMIT=2 DEZFIL_TRUSTED_PROXIES='' DEZFIL_TEST_PUBLICATION_LOG="$SCRATCH/publication.ndjson" node --import=./scripts/ingress-preload.mjs --import="$PROBES/publication-observer.mjs" server.js
```

For each other arm change the port, store and proxy setting above. `missing`
omits the ingress preload. The observer is test-process-only and records every
limiter insertion; it adds no diagnostic HTTP endpoint or production setting.
Against each already running standalone, run (change mode and port together):

```sh
DEZFIL_DATA_DIR="$SCRATCH" node "$PROBES/publication-source-probe.mjs" http://127.0.0.1:3393 direct --state-log "$SCRATCH/publication.ndjson"
```

On the fresh trusted standalone, explicitly include the served capacity proof:

```sh
DEZFIL_DATA_DIR="$SCRATCH" node "$PROBES/publication-source-probe.mjs" http://127.0.0.1:3394 trusted --state-log "$SCRATCH/publication.ndjson" --capacity
```

For a container, the direct arm is exactly:

```sh
docker run -d --rm --name dezfil-publication --network=none -e PORT=3393 -e DEZFIL_DATA_DIR=/data -e DEZFIL_PUBLIC_RATE_LIMIT=4 -e DEZFIL_PUBLIC_TILE_RATE_LIMIT=2 -e DEZFIL_TRUSTED_PROXIES='' -e DEZFIL_TEST_PUBLICATION_LOG=/data/publication.ndjson -v "$PWD/scripts:/probes:ro" dezfil:ci node --import=./scripts/ingress-preload.mjs --import=/probes/publication-observer.mjs server.js
docker exec dezfil-publication node /probes/publication-source-probe.mjs http://127.0.0.1:3393 direct --state-log /data/publication.ndjson
docker stop dezfil-publication
```

Repeat on fresh containers for `trusted`/3394 with proxies `127.0.0.1`,
`untrusted`/3395 with empty proxies, and `missing`/3396 with empty proxies and
no ingress preload. Four server containers total, no sidecars or published ports.
For the local trusted container, replace the probe command with:

```sh
docker exec dezfil-publication node /probes/publication-source-probe.mjs http://127.0.0.1:3394 trusted --state-log /data/publication.ndjson --capacity
```

The image job runs all four modes without `--capacity`: hosted runners cannot
fill the state inside one ten-second window. It proves direct/proxy source
separation and sharing, refusals, expiry and the missing-ingress answer, and
makes no capacity claim. The missing arm accepts an unready health response as
evidence that the deliberately unpreloaded server is listening.

Green exits zero with `label: confirmed` and per-arm check counts: independent
direct sockets, shared view budgets across valid/unknown tokens, separate tiles,
trusted-chain separation and mapped equivalence, untrusted sharing despite
forged headers, ten-second recovery and expiry on ordinary reads. The missing arm pins
the exact private 503 on all five operations, with and without forged provenance.
Red exits nonzero with `label: failed`: a shared direct key, accepted forged
provenance, changed refusal or absent expiry observation fails.

Only `trusted --capacity` sends the additional 10,050 distinct sources across
both buckets and asserts every observed size stays at most 10,000, reaches
10,000, and retains that size after further admissions. This requires 10,050
requests inside ten seconds, about 1,005 requests per second through the served
stack with the observer attached. `capacity arm never reached the bound; expiry
may have hidden eviction` means the probe did not fill the state before entries
could expire; it cannot prove eviction and fails. It is not a capacity pass on
a slower host. This explicit arm is the served proof of the bound on a machine
that can reach it. Without the flag, there are no capacity assertions or capacity
evidence. Deterministic unit tests with a controlled clock prove the exact bound,
expiry before eviction and renewal at capacity independently of host throughput.
`--capacity` is refused for other modes. No IPv6
rotation, throughput, latency or memory improvement is claimed.

### Derivation admission and timing probe

Use one fresh production standalone or one fresh container on port 3397. Set
`DEZFIL_TRUSTED_PROXIES=127.0.0.1` for this isolated test instance: the probe
sends distinct controlled forwarded sources over loopback, so the twenty-attempt
source budget cannot masquerade as derivation capacity. Do not disable login
limits, change work factors or increase admission capacity. The only observer
setting below belongs to the test preload, not to the production configuration.

Start from the isolated standalone directory, with `$PROBES` the checkout's
absolute `scripts` directory and `$SCRATCH` a fresh data directory:

```sh
PORT=3397 HOSTNAME=127.0.0.1 DEZFIL_DATA_DIR="$SCRATCH" DEZFIL_TRUSTED_PROXIES=127.0.0.1 DEZFIL_TEST_DERIVATION_LOG="$SCRATCH/derivations.ndjson" node --import=./scripts/ingress-preload.mjs --import="$PROBES/derivation-observer.mjs" server.js
```

From the checkout, against that running standalone:

```sh
DEZFIL_DATA_DIR="$SCRATCH" node scripts/derivation-probe.mjs http://127.0.0.1:3397 --state-log "$SCRATCH/derivations.ndjson"
```

The server's standalone tree needs the packaged `src/lib/auth/ingress.mjs` and
preload scripts, as in the transport recipe. The client uses the checkout's
recovery implementation; the container client uses the packaged implementation.
For the image, one server container and no sidecar or published port:

```sh
docker run -d --rm --name dezfil-derivation --network=none -e PORT=3397 -e DEZFIL_DATA_DIR=/data -e DEZFIL_TRUSTED_PROXIES=127.0.0.1 -e DEZFIL_TEST_DERIVATION_LOG=/data/derivations.ndjson -v "$PWD/scripts:/probes:ro" dezfil:ci node --import=./scripts/ingress-preload.mjs --import=/probes/derivation-observer.mjs server.js
docker exec dezfil-derivation node /probes/derivation-probe.mjs http://127.0.0.1:3397 --state-log /data/derivations.ndjson
docker stop dezfil-derivation
```

Green exits zero with `label: confirmed`, measured single and paired native
scrypt durations, observed peaks, busy count, and successful post-drain retries.
It covers setup contention, known and dummy sign-ins, signed-in checks, link
redemption, both password-change derivations and packaged recovery redemption.
The assertions require at most two actual native jobs, at most one protected
active job, at most six ordinary and two protected waiters, exact private busy
answers, and recovery after drain. Saturation never asserts an exact served
count. Busy sign-ins retry from their original sources without a fifteen-minute
wait; busy links remain redeemable. The observer wraps native callbacks and
records shared queue state; it neither holds work nor adds a production endpoint.

The timing report compares three ordinary queue waves and up to six waves under
protected competition against the five-second waiting deadline. Those wave
figures extrapolate the measured paired duration; they are not measured queue
latency or a promise that all waiters succeed on slower hosts. The isolated
`derivation-timing.test.ts` records local native timing in its scratch directory
when run alone; full-suite timings include contention from other tests.

Red exits nonzero with `label: failed` for a cross-route admission bypass, excess
native or protected concurrency, queue overflow, a missing or malformed busy
answer, login-limit interference, missing observations, or failed recovery.
The route-level probe test substitutes short native work and transport; it
confirms fixture and assertion coverage, not delivery or performance. Measure
these five additional server runs (four publication arms plus this arm) with the
existing 256 MiB and body probes when recording the image job's added minutes.
The earlier roughly six-minute image duration is a historical reference; no
candidate image duration is inferred from unit runs.


### Credential cleanup and restart probe

Run from the checkout against an already built isolated standalone, with its
native dependencies and ingress preload present. The driver owns port 3398;
choose another unused port with `--port` if needed. Never use the operator's
store or its development build. Each invocation requires an empty, absolute
scratch `DEZFIL_DATA_DIR` and creates no production setting:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/cleanup-XXXXXX") node scripts/credential-cleanup-driver.mjs --standalone /absolute/isolated-build/.next/standalone --port 3398
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/cleanup-XXXXXX") node scripts/credential-cleanup-driver.mjs --container dezfil:ci --port 3398
```

The container command is the image job's command. It needs the built `dezfil:ci`
image and Docker, no client image or sidecar. It creates one fresh named volume
and three successive server containers, each with `--network=none`,
`DEZFIL_DATA_DIR=/data`, `PORT=3398` and empty `DEZFIL_TRUSTED_PROXIES`. Clients
run inside each server's namespace with `docker exec`. The standalone likewise
uses three replacement processes over the same scratch store. The driver removes
its containers and volume even after failure; it leaves `cleanup-evidence.json`
and `cleanup-server.log` in the host scratch directory. Standalone mode also
leaves the isolated fixture store and its private credential manifest there.

The first launch provisions the fixture through HTTP, counts six repeated
sign-ins, and seeds 1,201 expired rows per credential kind alongside live and
retained controls. The second launch snapshots rows before credential traffic:
boot must remove between one and 500 old rows per kind. Continued cookie/token
access must drain the rest without an hourly wait. Every retained row survives,
recent revoked-token history stays visible, removed identifiers answer with the
exact unknown-token refusal, and live ordinary/recovery links redeem. Eleven
more old rows per kind are seeded for the third launch, which proves cleanup
runs again after replacement and live and redeemed credentials still work.

Green exits zero with `label: confirmed`, three launches, per-phase row counts
and checks. Red exits nonzero with `label: failed`: absent cleanup, a batch above
500 deletions, premature removal, stale history, changed refusals, failed live
use or a reused process/container identity fails. Unit fixtures seed missing
cleanup and premature removal independently and run the same probe through real
handlers. Those units do not establish socket, packaged boot or image behavior;
the driver does. Exact retention boundaries, 500 examined rows (including
live rows), hourly cadence and renewal races remain deterministic unit proofs.


### Provider cancellation and caller recovery

The [provider cancellation recipe](provider-cancellation.md) runs place search
and advisory custom-basemap checks against an owned held provider and a separate
production instance on port 3217. It includes route disconnects, queued and
pre-aborted calls, unchanged timeouts, completed-call controls, browser
supersession/departure and named defects with restoration instructions. Run it
outside environments that forbid listeners or browsers. It creates no container
or network and adds no image-job step; record its observations separately from
renderer proofs.

### Render destination gate and outside comparison

Run the [three-arm destination gate](render-egress-probes.md#image-job-step)
against the named built image. It runs both victim variants with three helpers,
two internal networks and no host ports, fails on missing evidence, and removes
its owned containers/networks on every ordinary exit. Expect about 30 added
image-job seconds against the outside 27–29 second measurements; record the
actual elapsed time. The same guide gives the wider dependency/compatibility
matrix, socket/lifetime proofs and cleanup recipes.

The [TLS and paired comparison guide](render-comparison-probes.md) gives exact
host OpenSSL/NSS prerequisites and trust mounts, positive and negative certificate
arms, per-claim supplementary browser labels, two warmups then ten interleaved
exports per version, independent guarded tile counts, retained voids, medians,
delta/ratio and each named seed. Those probes stay outside CI. Do not interpret a
configuration flag or an unpaired baseline as a browser or performance result.

### Image job probe order

After building and recording the `dezfil:ci` image, the image job runs these
checks in order. The stock `dezfil-mcp-probe:ci` client image is built after the
inventory and render destination checks, before the SQL byte-budget probe; it
is a test client, not a shipped service.

| Order | Check | Containers required |
|---|---|---|
| 1 | `check-image-inventory.mjs` | Disposable `dezfil:ci` inspection containers. |
| 2 | `render-egress-driver.mjs --image dezfil:ci` | One app and three helpers using the built image, recreated per arm; two internal networks, unconditional owned cleanup. |
| 3 | `result-budget-image.sh dezfil:ci --quick` | Two fresh `dezfil-budget-small-<pid>` and `dezfil-budget-normal-<pid>` servers with 32 MiB and 512 MiB engine budgets, no source container or network; owned containers and anonymous volumes removed on exit. |
| 4 | `body-probe.mjs` (includes transport, 11/256 MiB uploads, 12 MiB workflow and paced public POSTs), then `transport-probe.mjs --file-limit-only` | Two fresh `dezfil-transport-ci` servers in sequence, 257 MiB then 1 MiB upload caps; stock MCP client beside the first server. |
| 5 | `publication-source-probe.mjs`: direct, trusted, untrusted, missing, without `--capacity` | Four fresh `dezfil-publication-ci` servers in sequence; only the trusted arm trusts loopback and only the missing arm omits ingress. |
| 6 | `derivation-probe.mjs` | One `dezfil-derivation-ci` server with trusted loopback and the test observer. |
| 7 | `credential-cleanup-driver.mjs` | Three replacement `dezfil:ci` servers over one fresh named volume, no sidecar. |
| 8 | `ingress-probe.mjs`, then `--expect-missing` | Two disposable `dezfil:ci` containers, with and without ingress preload. |
| 9 | `check-duckdb-extensions-offline.mjs` | One disposable `dezfil:ci` container without networking. |
| 10 | Thirty-second cold start, `journey.mjs`, then `durability.mjs seed` and `verify` | `dezfil-ci`, then its replacement on `dezfil-ci-data`. |
| 11 | `ownership-journey.mjs seed` and `verify` | Two successive `dezfil-ownership-ci` servers on their own volume, each driven by the stock MCP client. |
| 12 | `sharing-journey.mjs seed` and `verify` | Two successive `dezfil-sharing-ci` servers on their own volume, each driven by the stock MCP client and its scripted assistant wire. |
| 13 | `mcp-process-driver.mjs` | Two replacement `dezfil:ci` servers over a fresh volume plus stock MCP clients. |
| 14 | `dezfil-plugin-container.mjs` HTTP journey | One `dezfil-plugin-ci` server plus stock MCP client with mounted plugin files. Keep this server for the final check. |
| 15 | `offline-export-probe.mjs --tiled` | One `dezfil-offline` server without networking. |
| 16 | `offline-export-probe.mjs --expect-unavailable` | One `dezfil-nobrowser` server from the image with Chromium removed. |
| 17 | `dezfil-plugin-container.mjs --render --render-log ...` | The retained `dezfil-plugin-ci` server and a stock MCP client. |

Cleanup steps stop remaining journey/plugin containers. The separate native gate,
account-upgrade, login-window and admin-recovery recipes remain outside this
image job; run them as described above when preparing a release.

## SQL result byte budget

The claim is **bounded at 32 MiB per result on the covered reads**. These
probes do not establish a process-memory bound. Native chunks, engine
allocations, JavaScript object overhead and transport duplication remain
separate. Run against disposable stores and a disposable PostGIS source.

### Local regressions

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) npx vitest run \
  src/lib/query/result-budget.test.ts src/lib/table-result-budget.test.ts \
  src/lib/geometry/result-budget.test.ts src/lib/postgis/result-budget.test.ts \
  src/lib/postgis/preview-owner.test.ts src/lib/query/result-budget-scope.test.ts \
  src/lib/query/result-budget-probe.test.ts src/lib/mcp/result-budget-parity.test.ts \
  src/lib/api/result-budget-contract.test.ts src/lib/query/result-budget-image.test.ts \
  src/lib/query/result-budget-quick.test.ts
```

Expect roughly 15-45 seconds. These run the real route and native client
inside the test process. They are not served HTTP observations. Stock MCP
client calls and a deterministic assistant provider relay the actual SQL
route refusal. MCP text, structured content and error flag, and the
assistant event/provider outcome retain the code and exact sentence. A
17-million-character fitting REST result succeeds even when its two MCP
copies exceed 32 MiB.

Client-boundary spies count decoded values and fetched chunks independently
of the budget accountant. The scope control forbids any accountant call on
layer renders, dataset map features, sliders, Overture previews, published
views, statistics, classification, widgets and value search. Overture's
remote source is substituted with native fixture SQL in that control.

Driver tests cover socket-only startup, TCP restart, readiness exhaustion,
mode selection and cleanup on probe failure. The quick probe also runs through
real routes in-process and checks every included reader. These tests do not
establish container readiness or the image job's elapsed time.

The decimal geometry latency control reads a stored LineString with varying
coordinates and compares it exactly with `JSON.parse(ST_AsGeoJSON)`. After one
full-query warm-up, it prints elapsed query time, geometry bytes and engine
memory budget. Fixture creation and expected-value conversion are outside the
timed query:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) DEZFIL_QUERY_MEMORY_MB=512 \
  npx vitest run src/lib/query/geometry-latency.test.ts --maxWorkers=1
```

Use the same self-contained test source and native dependencies for comparisons.
It imports no result-budget helpers and can be copied unchanged to the baseline
checkout. Alternate quiet baseline and candidate runs on the same host, with
the same engine budget, at least three times each, and retain every printed
value. This measures the complete query path, including table access and engine
projection, rather than the JavaScript decoder in isolation.

The engine-budget control reads a stored geometry whose compact GeoJSON is
exactly 10,151,576 bytes. Its normal test checks admission at 512 MB. Report
mode searches configured budgets from 1 to 512 MB on fresh query instances,
then rechecks the smallest admitted budget and the immediately lower refusal:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) DEZFIL_TEST_GEOMETRY_BUDGET_REPORT=1 \
  npx vitest run src/lib/query/geometry-engine-budget.test.ts --maxWorkers=1
```

Copy this self-contained test unchanged to each comparison checkout and keep
the native dependencies and host the same. Run it alone and retain every
attempt plus the final `geometry-engine-budget-floor` line. The binary search
assumes admission is monotonic in the configured budget; a failed neighbor
recheck, an unexpected error or a changed geometry fails the report. The floor
has 1 MB resolution and describes this isolated control, not process memory
or concurrent-query capacity. Result byte ceilings do not guarantee admission
under a smaller engine budget: execution and projection also use engine memory.

### Served standalone probe

Build and provision two instances on unused ports. Do not use an existing operator data directory.

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-build-XXXXXX) npm run build
PORT=3401 DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-small-XXXXXX) \
  DEZFIL_QUERY_MEMORY_MB=32 npm run start -- --hostname 127.0.0.1 --port 3401
PORT=3402 DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-normal-XXXXXX) \
  DEZFIL_QUERY_MEMORY_MB=512 DEZFIL_EGRESS_ALLOWLIST=127.0.0.1 \
  npm run start -- --hostname 127.0.0.1 --port 3402
```

Run each server command in its own terminal. Supply `DEZFIL_TEST_PG_URL`
pointing to the disposable PostGIS source allowed by the second instance's
egress policy. The source account must be able to create and drop its owned
schema; the product connection remains read-only. The pinned native client
and Postgres extension must be available in the invoking checkout.

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) \
  npm run probe:query-result-budget -- http://127.0.0.1:3401 standalone --refused
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) \
  npm run probe:query-result-budget -- http://127.0.0.1:3402 standalone --full
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) \
  npm run probe:query-result-budget -- http://127.0.0.1:3402 standalone --admitted
```

The default mode is `--refused`, for compatibility with the baseline probe.
Expect 1-10 seconds for refusal and 10-60 seconds for admitted calibration.
For the full control set, the built-image run below measured 47 seconds;
standalone runtimes also depend on the host and source. Each run prints its
actual sizes; full/admitted runs print elapsed seconds. A missing PostGIS URL
in `--full` fails, never skips.

The full probe checks both ceilings at minus one, equality and plus one on
all four reader families. SQL runs both WKT and GeoJSON. Boundary payloads
use nested cells so geometry-choice excerpts do not defeat the control.
Expected totals come from fitting response bytes, including current metadata;
SQL runtime digit changes are re-fitted. Inability to land fails the run.

Valid native multipoints use decimal coordinates and have compact GeoJSON sizes 10,151,576, 6,138,709 and
267,502 bytes. The 258-row control totals 12,395,238 bytes with a 1,573,724-byte
largest geometry. Large shapes come first within each reader's row window.
Multipoints survive preview simplification, so emitted geometry above 2 MiB
is exercised too. Printed WKT/GeoJSON and envelope sizes are independent
response measurements. Wide schemas, escaped/multibyte text, nulls, JSON,
nested cells and coordinate text accompany them. Geometry overflow refuses
the complete result. All three file exports are consumed to EOF and their
row count, payload bytes and Content-Length are checked above both ceilings.

Green: all assertions pass; fitting boundaries return 200 at 33,554,431 and
33,554,432 bytes; excess returns only 422 `query_result_too_large` with the
catalogue sentence, below 1 KiB. Red on an unbounded build: the forty-row
case returns its large successful body instead of that error. Lost cell or
result ceilings, an unbounded reader, wrong geometry identity, or a boundary
that cannot be fitted all exit nonzero. No partial answer is accepted.
The probe prints Content-Encoding, Content-Length and Transfer-Encoding
separately; its counted bytes are the uncompressed entity, not HTTP framing.
Owned tables, connection, source schema, map and issued token are cleaned up
on assertion failure as well as success. A supplied `DEZFIL_PROBE_TOKEN`
remains caller-owned.

### Request markers

The `--refused` mode prints separate WKT and GeoJSON requests and their response
bytes. The `--admitted` mode labels calibration separately from each
`admitted-at-ceiling` attempt and fails unless one returns exactly 33,554,432
bytes. A whole probe run includes calibration and multiple large requests.

For an explicit pause around each labelled request, append
`--observation-dir /tmp/budget-markers-new` to `--refused` or `--admitted`.
Calibration creates no markers. Each request creates a fresh subdirectory,
prints its path and writes `ready.json`; create its `release` file within two
minutes to proceed. `started.json` and `done.json` bracket the request, with
status and bytes in the latter. Re-fitting an admitted request creates a new
numbered subdirectory; only the attempt with 200 and 33,554,432 bytes is the
at-ceiling result. Existing marker subdirectories cause failure.

### Built image

The image must already be built. Run from the checkout root. The pipeline form
is also the driver's default when no mode is supplied:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-image-XXXXXX) \
  sh scripts/result-budget-image.sh dezfil:ci --quick
```

Measured driver time was **7 seconds**, including both app starts, excluding the build.
The workflow gives this step a three-minute timeout. It starts isolated 32 MB and
512 MB app instances, with no outside source or database image pull, and runs:

- The refused forty-row case under the 32 MB engine budget.
- Non-geometry cell minus-one/exact/plus-one boundaries for SQL in both geometry
  encodings, dataset inspection and geometry-choice preview.
- A successful SQL answer of exactly 33,554,432 bytes, fitted from measured
  response bytes, with re-fitting when runtime metadata changes size.

The complete result-boundary matrix, every PostGIS arm, the large
native geometry and representation controls, and complete exports require the
complete matrix:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-image-XXXXXX) \
  sh scripts/result-budget-image.sh dezfil:ci --full
```

Measured driver time was **47 seconds**, excluding the build and a cold PostGIS image
pull. This runs the forty-row refusal, the complete four-reader matrix and
exports, then the separately labelled at-ceiling admission observation. It
adds a disposable PostGIS fixture in the normal app's network namespace.
Source readiness requires three consecutive TCP successes at 127.0.0.1:5432,
the address used by the app. The socket-only initialization server cannot
satisfy it; a failed TCP check resets the streak, and exhaustion fails the run.

Both forms own their container names. An unconditional trap removes containers
and anonymous volumes on success, readiness failure or assertion failure. Both
print actual elapsed seconds before container cleanup; time the whole command
as well when recording pipeline cost. The 7-second and 47-second measurements
are host-specific observations, not runtime guarantees. The script does not sample memory.

Green: exit zero, a forty-row 422 with the exact catalogue refusal below 1 KiB,
and a 200 answer at exactly 33,554,432 bytes. Quick mode also reports all cell
boundaries; full mode reports every reader's result boundaries at minus-one,
equality and plus-one, complete controls and all three complete exports.
The driver finishes with a `confirmed: result-budget image` line and elapsed
seconds. Red: any wrong status, size, code or sentence, an unlandable boundary,
or failed TCP readiness exits nonzero. A quick run exceeding three minutes also
fails the workflow allowance. Cleanup still runs; neither form skips a missing arm.

### Browser flow

Use a provisioned instance with the normal engine budget:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-browser-XXXXXX) \
  DEZFIL_BASE_URL=http://127.0.0.1:3402 npm run e2e:result-budget
```

Expect 30-120 seconds. The console uses a real refused query, finds code and
sentence in its existing error note, checks that busy ends and SQL remains,
then runs a narrower successful query. A real oversized dataset inspection
shows the sentence, with no detail/set-geometry content. Add data receives
the exact real-route refusal through its browser fixture and displays it in
its existing geometry preview error place. That last arm proves UI
propagation; the served probe proves the geometry reader itself. No new
controls, styling or layout are needed.

Failure controls, each expected to exit nonzero:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-browser-XXXXXX) \
  DEZFIL_BASE_URL=http://127.0.0.1:3402 DEZFIL_RESULT_BUDGET_BROWSER_SEED=wrong-copy \
  npm run e2e:result-budget -- --grep 'console refusal'
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-browser-XXXXXX) \
  DEZFIL_BASE_URL=http://127.0.0.1:3402 DEZFIL_RESULT_BUDGET_BROWSER_SEED=stale-busy \
  npm run e2e:result-budget -- --grep 'console refusal'
```

Wrong-copy replaces the received error sentence. Stale-busy receives the
real 422 but holds completion of the browser fetch. Neither changes the
server or source files. Unset the seed and rerun for green.

The complete battery also runs `npm test` without socket exclusions,
the production build, all lint gates and the API/durability/ownership/sharing
and MCP journeys described above. The result probe supplements
those existing gates; it does not replace them.

### Companion commands

Keep the runbook's renderer, tiler and loopback fixture prerequisites. These
are unchanged checks, each on its own disposable instance/store; do not run
ownership/sharing seeds against a store another journey already provisioned.
Expected durations are 2-5 minutes for build, 15-30 minutes for the complete
battery, 1-5 minutes per API/MCP journey and 1-3 minutes per seed/verify arm.
Actual runtimes depend on the host.

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) npm test -- --maxWorkers=2
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/journey.mjs http://127.0.0.1:3403
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/mcp-journey.mjs http://127.0.0.1:3403 --render
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/durability.mjs seed http://127.0.0.1:3403 .claude/budget-durability.json
# Replace the 3403 server over the same store before verify.
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/durability.mjs verify http://127.0.0.1:3403 .claude/budget-durability.json
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/ownership-journey.mjs seed http://127.0.0.1:3404 .claude/budget-ownership.json
# Replace the 3404 server over its store.
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/ownership-journey.mjs verify http://127.0.0.1:3404 .claude/budget-ownership.json
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/sharing-journey.mjs seed http://127.0.0.1:3405 .claude/budget-sharing.json --assistant-wire=3406
# Replace the 3405 server over its store.
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/sharing-journey.mjs verify http://127.0.0.1:3405 .claude/budget-sharing.json --assistant-wire=3406
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) npx vitest run src/lib/postgis/preview.live.test.ts
```

The sharing instance needs `DEZFIL_AI_PROVIDER=openai`, a synthetic
`OPENAI_API_KEY` and `OPENAI_BASE_URL=http://127.0.0.1:3406/v1`. The held-source
suite needs `DEZFIL_TEST_PG_URL` and takes about 60-90 seconds: green means
both timeout and departed-caller cases drain owned backends within their
existing bounds, retain source health and permit a sibling read. Any failed
assertion is red. No real-provider key or request is needed.
