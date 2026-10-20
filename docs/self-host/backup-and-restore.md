---
title: "Runbook"
summary: "Recipes for the work around an instance: running it locally, backups, upgrades, account recovery, the checks and the outside probes."
read_when:
  - "you back up, restore or upgrade an instance"
  - "you recover an admin account"
  - "you run the checks, the browser suite or a probe on an instance of your own"
audience:
  - operator
  - developer
checked: none
moved_from:
  - "/docs/operate/runbook/"
---

Operational recipes for running a self hosted instance: the things an owner
does around the container rather than inside the app. Each section stands on
its own and names the settings it touches. More recipes are added here as
they are written down.

## Running an instance locally

Node.js 24 or newer is required. Run `npm ci`, then `npm run dev`: the
app serves on `http://localhost:3000`. For another port use
`PORT=3210 npm run dev` or `npm run dev -- --port 3210`. For a
production-shaped run: `npm run build`, then `PORT=3210 npm start`.
The development server makes map pictures and image exports as well, with
the headless browser `DEZFIL_CHROMIUM_PATH` names; its render pages hide the
development tools badge, so the images do not carry it.

All durable state lives in one directory. `DEZFIL_DATA_DIR` names it;
unset, it defaults to `./data` under the working directory, and the image
sets `/data`. Back up that directory with the instance stopped and preserve any
externally supplied encryption key.

What appears inside it as the instance is used: `metadata.sqlite` (maps,
layers, styles, published links, connections, accounts, sessions, token records,
workflows and runs), `tables/` (the GeoParquet
artifacts), `thumbnails/`, `tmp/` (scratch for imports, exports and tile
builds), `cache/overpass/` once an OSM import runs, and `secret.key` on
first boot unless `DEZFIL_SECRET_KEY` was set first. It also holds `tiles/`
(one PMTiles archive per tiled layer), `exports/` (project exports being
assembled), the provider caches `cache/geocode/` and `cache/isochrone/`, and
`artifact-inputs/` (what each tile archive and map card picture drew). An optional
`assistant-models.json` placed there by hand is read as
[Set up the assistant](assistant.md#offer-other-models) describes.

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
[the SQL boundary](../api/http-api.md#the-read-only-sql-instance) for the execution rules.

Unlabelled browser SQL drafts and history from older releases cannot be
attributed to an account and are discarded when the private workspace first
opens. Copy any draft you need before upgrading. Once labelled, same-account
reloads retain drafts; sign-out or an account change clears private browser
memory, including assistant recovery locators and prepared download state.
Saved layer and workflow SQL in the data directory is unaffected by this
browser cleanup.

## Finishing account deletion

Users lists pending and needs-retry deletions separately from accounts. Finish
deleting resumes the same record and is safe to retry after restart. Never remove
its journal or edit its identity rows manually. An active admin uses the same
status and continuation operations through the [API](../api/http-api.md) or [MCP](../api/mcp.md).
A long-lived outside reader, such as a replication sidecar, can keep deletion unfinished until it releases the database; release it, then use Finish deleting.

Check free space on both the data volume and SQLite's temporary filesystem. The
whole metadata-store rewrite pauses every response, including health. Across two
runs on one machine, the 1 GiB observations ranged from 3.4 to 13.2 seconds in the
container (nine trials) and 9 to 38 seconds on the host. The repeat run observed up
to 1.55 seconds at 64 MiB and 3.07 seconds at 256 MiB. These observations set no
bound and promise no maximum pause. A slow or nearly full disk and a host short of
memory make it longer. The [host guide](what-leaves-the-instance.md#leaving-and-deleting-accounts)
states space planning, cache purge and exact copy limits. A failed compaction stays
unfinished and can be retried.

The [upgrade and packaged recovery proof](../../scripts/account-upgrade-proof.md)
and [built-image deletion journey](../../scripts/account-deletion-driver.md) exercise
original-profile removal and remaining-admin recovery on disposable stores. The
[served contract proof](../../scripts/served-contract-proof.md) compares published
counts, errors, actors, generated tools and installed guidance.

## Retained account identity upgrade

Stop the instance and verify a whole-data-directory backup, including `secret.key`,
before starting this version. Rehearse on a separate scratch copy first. The account
constraint rebuild preserves every row, SQL home, index and trigger. It disables
foreign-key enforcement outside its transaction, checks the complete foreign-key
and database integrity before commit, and restores enforcement on success or failure.
A failed rebuild rolls back; opening again retries it.

Deleted identities reserve their SQL name permanently. Their profile fields are
absent; the original-account adoption marker still prevents setup from reopening.
The immediately preceding application
can read and write this migrated schema **only while no account is deleting or
deleted**. This is not recovery-command compatibility: local recovery requires this
version's command and its matching schema pin. Rollback restores the matched old
application and the complete stopped backup, never a down-migration of the live file.

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

For the named Docker volume of [Install](../start/install.md), use your installed image to copy the
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
[self-hosting](what-leaves-the-instance.md#upgrading) for the attribution limits.

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
This is not compromise cleanup; see the [limits](what-leaves-the-instance.md#recovering-an-admin-account).

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
[API](../api/http-api.md#editing-with-revisions) and [MCP](../api/mcp.md#editing-with-revisions)
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
machine needs `npx playwright install chromium firefox webkit`: Firefox and
WebKit run only the Panels looks' fallback cases (their own projects in the
Playwright config), and the WebKit project is left out where its build is
not installed. The suite runs on your own
machine only: the pipeline has no browser job, so nothing runs it for you.
On a hosted runner it did not reliably finish inside the available time
bound, the standalone build, the browser download, the tiler build and the
extension install all landing before the first test started, so there is no
job to fix rather than a job that times out.

A whole-set run, or any run whose result is kept as evidence, needs more
than the variables give it. A fresh scratch store: a store grown over a
night of runs makes small loads miss their comparison bounds. The
assistant wiring below: the assistant specs answer from the scripted
model the suite serves itself and count calls through its tool harness,
so an instance with a placeholder key alone fails about ninety cases
rather than skipping them, and `assistant-look` needs an instance of its
own; `assistant-catalogue` needs the store under the worktree's `.claude`
directory, with `DEZFIL_DATA_DIR` naming it in the test process too. Two more boots serve the model offer cases: `assistant-picker` with
`DEZFIL_AI_MODELS_OPENAI` naming its three models, and
`assistant-catalogue`'s one-model cases with it naming one (their headers
say which), since one instance cannot offer both lists. The
deletion proof host's control directory for `account-deletion` and
`deleted-attribution`: boot the instance with
`--import=./scripts/deletion-proof-preload.mjs` from the checkout's root and
`DEZFIL_PROOF_CONTROL_DIR` set to a fresh absolute directory, and set the
same variable in the test process. An otherwise idle machine: the cases
that measure time fail under load and are then recorded as flakes. And one
Playwright run at a time per worktree: every run from a worktree shares
its `.claude/browser-auth.json`, and cookies ignore ports, so two runs
against two instances sign each other out. The pixel baselines were cut
on a production standalone; cut and compare them there. A whole-set run
is therefore several Playwright runs: the main one against the harness
instance with the model-offer cases left out (`--grep-invert` over
`assistant-look`, `assistant-picker` and `assistant-catalogue`), then
`assistant-look` against its own instance, then `assistant-picker` and
`assistant-catalogue`'s offer cases each against the boot its header
names, selected with `--grep`; `assistant-catalogue` asserts the default
list in one boot and a one-model list in another.

Subsets run by area: `npm run e2e:keyboard`, `e2e:layers`, `e2e:imports`,
`e2e:sqlbridge`, `e2e:sqlconsole`, `e2e:draw`, `e2e:styling`,
`e2e:recovery`, `e2e:lifecycle`, `e2e:theme`, `e2e:states`, `e2e:pixel`,
`e2e:statepixels`, `e2e:wheelhousepixels`, `e2e:a11y-pixels`,
`e2e:primitives`, `e2e:smoke`, `e2e:look` (the Appearance tab, an image
keeping the default look, and the Panels looks on every kind of surface;
`DEZFIL_PANEL_LOOKS_SEED` set to `typed-liquid`, `preview-lens`,
`late-look` or `late-sheets` turns the steps its header names red),
`e2e:surfaces` (the surface
roles' computed values on every screen, both themes, and the blur drawn
under the map card's glass; `DEZFIL_SURFACE_ROLES_SEED` set to
`typed-shadow`, `typed-member`, `scope-forgets` or `light-tones` turns the
steps its header names red).

Required on the server for a green full run. Without these the affected
tests fail rather than skip:

- `DEZFIL_RENDER_CAP_FEATURES=2000`, so the 52,001-feature layer tiles;
- `DEZFIL_EGRESS_ALLOWLIST=127.0.0.1`, for the URL-import loopback fixture and
  for the two below: OpenStreetMap queries and the Overture release listing
  go through the egress check, so a loopback Overpass or object store needs
  the allowlist as well;
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
- `DEZFIL_TEMPLATES_CATALOGUE` naming a local catalogue folder of at least
  nine templates, in both the server's environment and the test process's,
  for the Home journey (`npx playwright test e2e/home.spec.ts`), which
  reads the folder's index, asks the server to read the catalogue, and makes
  two accounts of its own.
- `DEZFIL_E2E_PINNED_QUEUE_MAX=<n>` in the test process, against a second
  instance started with `DEZFIL_OPERATION_QUEUE_MAX=<n>`, for the Settings
  journey that draws a pinned limit locked
  (`npx playwright test e2e/settings-page.spec.ts`); on that instance the
  journey that steps the same limit skips instead.

The suite blocks third-party hosts, so it needs no internet beyond the
instance itself.

The assistant specs (`e2e/assistant-*.spec.ts` and the pane cases in
`e2e/pane-replacement.spec.ts`) answer from a scripted model the suite
serves itself on `127.0.0.1:3202`, and count the assistant's own calls to
the instance through a tool harness on `127.0.0.1:3303`. Without the
instance pointed at both they fail rather than skip. Boot their instance
like this, alongside the variables above, with the instance's own port in
`PORT` and `DEZFIL_E2E_LISTEN_PORT`:

```sh
DEZFIL_DATA_DIR=/tmp/dezfil-scratch PORT=3210 \
DEZFIL_AI_PROVIDER=openai OPENAI_API_KEY=scripted-wire \
OPENAI_BASE_URL=http://127.0.0.1:3202/v1 \
DEZFIL_ASSISTANT_AUTO_CHECK=off \
NODE_OPTIONS="--require $PWD/e2e/assistant-self-port.cjs" \
DEZFIL_E2E_LISTEN_PORT=3210 DEZFIL_E2E_SELF_PORT=3303 \
npm start
```

The automatic check is off because, with it on, a turn that changes the
map renders it and asks the model once more, a call the scripted replies
do not provide for. `e2e/assistant-look.spec.ts` is about that check: its
instance keeps the check on and loads `e2e/assistant-preloads.cjs` in place
of the self-port preload, with `DEZFIL_E2E_RENDER_STUB=1` and
`DEZFIL_ASSISTANT_LOOK_RETENTION=2`. Ports 3202 and 3303 are fixed, so one
such run at a time per machine.

## Driving the API without a browser

`node scripts/journey.mjs <base-url>` walks the documented API end to end:
readiness, the machine-readable description, upload, SQL, layer, style,
publish, exiting non-zero on the first broken step.

On a runner without a browser, append `--http-only` to the API journey. It
prints the omitted image-render step explicitly; the default journey and CI
still require the real image-export proof.

The [upgrade and packaged recovery proofs](../../scripts/account-upgrade-proof.md)
cover pre-account adoption, original-account deletion, fixed homes, remaining-admin
redemption and scratch restoration in checkout and container modes.

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

Every sharing verification also provisions three fresh departure actors and
exercises Leave as Viewer and Editor, with live and frozen project owners,
through sessions, tokens, MCP and (when configured) the assistant. MCP decline
and assistant decline leave the grant intact. Approval ends exclusive reach
on both held credentials, preserves independent grants and owned filings,
changes no document facts, and permits ordinary re-addition and withdrawal by
identity. This part intentionally mutates its fresh fixture on each verify.

For held reads and output commits, start the scratch server with the test-only
`scripts/sharing-leave-observer.mjs` preload and pass
`--leave-hold=<server-data-directory>/.leave-probe` to the journey. The observer
pauses marked real engine work after the read, before returning or committing;
the client leaves, checks new-request refusal, then releases it. It asserts an
admitted read completes once, a lost input refuses a late output, and an input
still reached through another grant yields a private output with no workflow
association. No product route or deployment setting enables this test hold.
Without the option the report explicitly says that the held arm was not run.

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
  software GL by server-side image exports, appearance checks and map card pictures (`DEZFIL_CHROMIUM_PATH`);
- the DuckDB extension bundle, baked at build time into
  `/app/duckdb-extensions`, so a running instance needs no network;
- the native packages the standalone tracer misses, copied in whole;
- `public/`, `LICENSE`, `NOTICE` and the model catalogue file at its
  source-relative path, copied explicitly.

Without the renderer, map listings report `pictureState: unavailable`,
refresh answers `outcome: unavailable`, and existing pictures stay served.
The admin System read, `GET /api/instance/settings`, reports this as
`parts.image_renderer.available`; `found` separately reports file presence.
The System tab's Image renderer row reads Not found without the program and
Could not start after a launch refusal, and every page of map cards tells
administrators so in one line at its foot. Install or restore the configured
executable; the hourly look discovers recovery without an edit. A launch refusal
also holds picture work unavailable until that look, even if the file exists.
Map pictures are made on the server even when nobody opens their builder.

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
token blocks, the surface roles' block and the plate drawn from it, every
component stylesheet in the UI kit, and the palette ramps. `--check` on the
same script is what `npm run lint:specimen` runs. Re-run it whenever a
token, a surface role, a kit stylesheet or a palette changes. A new surface
role needs its words in the script's role notes, or the feed stops.

**The look's background sheets.** `node scripts/generate-look-sheets.mjs`
rewrites `public/look/`: the Atlantic chart in every other Color and theme,
derived from the two shipped sheets by swapping their inks, and the
Graticule and Hex lattice tiles per Color and theme. `--check` reports a
stale, missing or stray file, and the unit suite runs it. Re-run it when a
shipped sheet or the script's ink table changes; never edit those files by
hand.

**The plugin guidance file.** `node scripts/generate-dezfil-guidance.mjs`
rewrites the skill's analysis document and its bundled licence from the one
canonical source; `--check` is `npm run lint:plugin`. Re-run on any change
to that source.

**The plugin package.** `node scripts/prepare-dezfil-plugin.mjs --output
<new-directory> --base-url <origin>` writes a self-contained copy carrying
the chosen endpoint and the local catalogs for both clients. Omitting
`--base-url` selects `http://localhost:3000`; an occupied destination is
refused. Prepare a fresh copy whenever the instance address changes.

**The documentation's pictures.** `npm run docs:pictures` takes every
scene in the script's scene list (`scripts/docs-pictures-scenes.mjs`) from a
real instance and writes the changed files under `docs/images/` with the
manifest beside them. Run it from a checkout that holds a production build
and no `.env` files, such as a detached worktree after `npm ci` and
`npm run build`; it needs the Chromium and the ffmpeg Playwright installs
(`npx playwright install chromium ffmpeg`). It starts
`next start` from that checkout on a free loopback port (`--port` to choose
one) over a scratch folder it creates in the system's temporary folder and
removes at the end, with that folder as the data directory and as the
template catalogue, written from the shipped templates. It takes the scenes
that need no account first, then seeds through the API (the first account
through setup, a second invited account, a project they share, the three
shipped templates copied, the fixtures under `e2e/fixtures/` uploaded) and
takes the rest, signed in as the first account. Every scene is taken at
1440 × 900 CSS pixels and two pixels per CSS pixel with reduced motion and a
fixed clock, twice from the same instance state: in the light theme, then in
the dark theme. The theme is the app's own: the dark take's browser starts
with the choice the header's theme switch stores, which the app applies
before first paint, and the run fails when a page is drawn in the other
theme or a dark take comes out the same as its light take. The dark take is
written beside the light one with `.dark` before the extension
(`templates.webp` and `templates.dark.webp`), shows the same frame or crop,
and has a manifest row of its own carrying its theme. Pages and the README
name the light take; the dark take is found by that name. The README sets
each picture as the image of a `<picture>` whose source for
`(prefers-color-scheme: dark)` names the dark take, so GitHub shows the
take of the reader's theme. A recording is not filmed in real time: each of its steps is done, the page settles, and
the frame is held for the step's number of frames at ten a second, so its
length is its frame count (eight seconds at most). The frames go to Playwright's own ffmpeg, which
encodes a muted VP8 WebM single-threaded with bit-exact settings, so the
same frames give the same bytes; each take's first frame is its poster, so
a recording's dark take has a dark poster of its own. A recording
over 1,500,000 bytes fails the run: hold fewer frames or declare a crop,
never a smaller scale. The run fails, writing nothing, when the
server opened a request to any host but itself (an observer in its preload
chain writes each one down; `--keep-requests <file>` keeps its file), when a
page asked for an address off the instance, or when a file is over its
bound. A scene that shows a map says so (`map: true`) and is the one scene
that may reach the built-in basemap; it is taken once every map on the page
is at rest with its tiles loaded, a basemap request that fails fails the run,
and the run lists the basemap's styles and tile sets it drew. How to prove a
run is in [the pictures' procedure note](../../scripts/docs-pictures.md). A file is replaced only when its bytes changed, and its
manifest row's version and date move with it, so a second run on the same
build changes nothing. `--only <scene>,<scene>` takes some scenes and keeps
the others' rows. After changing a surface a scene shows, run it and commit
what changed; when the manifest is new, `npm run docs:write` lists it in the
index.

**Pixel baselines.** The snapshots live beside their specs in the
`*.spec.ts-snapshots` directories. They are cut on one environment, and a
re-cut names it in its commit: macOS on Apple silicon, the Chromium headless
shell the pinned Playwright installs, and a production build
(`npm run build`, then `npm start`) on a fresh data directory, provisioned
as [the browser suite](#the-browser-suite) describes. A store that earlier
runs have filled is not that environment: lists, counts and relative times
in a shot follow what the store holds. Regenerate one spec at a time, so no
unrelated shot is rewritten, and only the shots that no longer match:

```sh
npx playwright test e2e/pixel-regressions.spec.ts --update-snapshots=changed
```

Then compare every rewritten file with the one it replaces before
committing it. In this mode a shot that still differs when its comparison
times out is written as it stands, so a surface that had not finished
loading, a live tile server's pixels or a value that depends on the store
would become the baseline; each of those is a defect in the shot, not a
new baseline.

Baselines are platform-specific: shots generated on one operating system do
not match another, so a pixel spec run on a machine unlike the one that
recorded its baseline skips rather than reporting a difference. Only
regenerate when the change to the rendered surface is intended, or when the
renderer moved under an unchanged surface.

**The API description.** The server builds the document at request time and
serves it at `/api/openapi.json`, with the human-readable API reference at
`/developer`; the API journey asserts it is served and well formed. A
generated copy is committed at `docs/api/openapi.json` for the
documentation site and for agents reading the checkout: `npm run docs:write`
rewrites it with the index, and `npm run lint:docs` fails while it differs
from what the source builds.

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

**A layer over the render cap or Bytes drawn per layer reports a missing
tiler.** `tippecanoe` is not on `PATH`. Install it or set `DEZFIL_TIPPECANOE`.
Everything within both limits keeps working without it.

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
shipped catalogue applies instead; `GET /api/assistant` says which
([Offer other models](assistant.md#offer-other-models)).

**A script collides with the development server.** These scripts write real
state and bind real ports: give them their own port and `DEZFIL_DATA_DIR`,
never the port the development server holds.

## Shipping a template release

From a release checkout with dependencies and DuckDB extensions available, run
`npm run templates:install -- archive.zip --sha256 RELEASE_SHA256 --size RELEASE_BYTES`
(or use an HTTP(S) archive URL). Take the checksum and byte count from the
release; `--target folder` selects a destination instead of `templates/`.
The command uses the product's transfer verification, archive and dataset
readers, binding checks and shipped-set validation in a temporary instance,
then publishes the complete `<id>/<version>/` folder and `index.json` together.
A newer version replaces that id's shipped version; an older one replaces it
only with `--allow-downgrade`. Installing the same version again is refused
because released versions are immutable. A refused install leaves the existing
set unchanged. Remote transfers are bounded by `DEZFIL_REMOTE_TIMEOUT_S`
(300 seconds by default). URL requests use
`Dezfil-templates/1.0 (+https://dezfil.io)` and carry no account credentials.
