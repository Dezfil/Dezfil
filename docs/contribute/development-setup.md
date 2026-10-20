---
title: "Development setup"
summary: "Run a checkout for development, run the checks and tests the pipeline runs, and start the instances the browser suite and the scripts need."
read_when:
  - "you set up a checkout to change Dezfil's code"
  - "you want to run the pipeline's checks before you push"
  - "you run the unit tests or the browser suite against an instance of your own"
  - "a test needs DEZFIL_TEST_PG_URL or another test-only variable"
  - "you regenerate the docs index, the design specimen or another generated file"
audience:
  - developer
  - agent
checked: none
order: 1
moved_from:
  - "/docs/develop/checks-and-testing/"
---

Start a development server from a checkout:

```sh title="Terminal"
git clone https://github.com/Dezfil/Dezfil.git
cd Dezfil
nvm install
npm ci
npm run dev
```

- `nvm install` reads `.nvmrc`, which pins Node 24, the version the pipeline runs. With fnm, run `fnm use --install-if-missing`.
- `npm ci` installs the exact package versions `package-lock.json` pins.
- `npm run dev` serves Dezfil on port 3000, keeps its data in `./data` and reloads as you edit.

Check that the server is ready:

```sh title="Terminal"
curl http://localhost:3000/api/health
```

```json title="Output"
{"status":"ready"}
```

Then open <http://localhost:3000> and create the first account, as [Install](../start/install.md) shows.

## Add the programs the container brings

The image installs two programs a checkout lacks. Everything else works without them.

| Program | What needs it | Without it |
|---|---|---|
| `tippecanoe` | Tiles for layers over the render cap, and the unit tests that build tiles | Those layers report a missing tiler, and those tests fail |
| A headless Chromium | Map pictures and image exports made on the server, and the real-render tests | The server makes no pictures or exports; the builder's own image download still works |

::::tabs

:::tab[macOS]

```sh title="Terminal"
brew install tippecanoe
npx playwright install chromium
```

:::

:::tab[Linux]

Build `tippecanoe` 2.79.0 from source, the version the image and the pipeline build:

```sh title="Terminal"
sudo apt-get update
sudo apt-get install -y --no-install-recommends build-essential libsqlite3-dev zlib1g-dev
curl -fsSL https://github.com/felt/tippecanoe/archive/refs/tags/2.79.0.tar.gz | tar -xz -C /tmp
make -C /tmp/tippecanoe-2.79.0 -j"$(nproc)" tippecanoe
sudo install /tmp/tippecanoe-2.79.0/tippecanoe /usr/local/bin/tippecanoe
npx playwright install chromium
```

:::

::::

Dezfil looks for `tippecanoe` on your `PATH` and for Chromium at `/usr/bin/chromium`. To name other files, set `DEZFIL_TIPPECANOE` or `DEZFIL_CHROMIUM_PATH` in `.env.local`, which Next.js reads at start and git ignores:

```sh title=".env.local"
DEZFIL_CHROMIUM_PATH=<PATH_TO_CHROME_HEADLESS_SHELL>
```

The unit tests and the scripts do not read `.env.local`: set the variable in their own environment.

## Run a scratch instance

Give each instance its own data folder and port, so test writes never reach your working data:

```sh title="Terminal"
DEZFIL_DATA_DIR="$(mktemp -d)" PORT=3310 npm run dev
```

For a production build, run `npm run build`, then `npm start` in place of `npm run dev`.

The scripts and specs below write real accounts, maps and links. Point them at a scratch instance on port 3300 or higher.

Some runs want a production build in a detached worktree, apart from the checkout you edit:

```sh title="Terminal"
git worktree add --detach ../dezfil-build HEAD
cd ../dezfil-build
npm ci
npm run build
```

A standalone you start by hand needs what the [Dockerfile](../../Dockerfile)'s last stage copies beside it, such as `public`, `.next/static` and the native packages.

> [!WARNING]
> `npm run dev`, `npm start` and the image load the ingress preload first. Without it, `/api/health` answers 503 and sign-in is refused. Start a standalone with `node --import=./scripts/ingress-preload.mjs server.js`.

## Run the checks

The pipeline runs these on every pull request and every push to `main`. Run them at your branch's tip before you push:

```sh title="Terminal"
npm run lint
NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck
for gate in hygiene citations readme size stage-edge wheelhouse tokens icons class-pairs \
  specimen contract-docs reader-docs plugin docs retired-paths; do
  npm run "lint:$gate" || echo "FAILED: lint:$gate"
done
DEZFIL_DATA_DIR="$(mktemp -d)" npm test
DEZFIL_TRUSTED_PROXIES=127.0.0.1 node --import=./scripts/ingress-preload.mjs scripts/ingress-probe.mjs
node scripts/ingress-probe.mjs --expect-missing
```

- `NODE_OPTIONS` gives the type check 4 GB of heap, as the pipeline does. It needs about 2.5 GB.
- The loop runs every `lint:` gate, in the pipeline's order.
- The last two lines check that the ingress preload tells direct and proxied connections apart, and that a server without it refuses.

You should see no error from ESLint or TypeScript, no `FAILED:` line, no failed test in Vitest's summary, and `PASS: missing preload refuses provenance` last.

| Gate | Fails when |
|---|---|
| `lint` | ESLint finds a problem |
| `typecheck` | TypeScript finds a type error |
| `lint:hygiene` | A tracked text file holds a NUL byte |
| `lint:citations` | A tracked file cites a planning document, tracking row or folder this repository does not carry |
| `lint:readme` | A deployment variable or a stored setting lacks its one row in the settings tables the [Configuration](../self-host/configuration.md) overview links, or a row's place, default, Settings key or timing disagrees with the catalogue in `src/lib/settings/catalogue.ts`; or the code and the [wiring table](#test-and-development-wiring) disagree on a test variable |
| `lint:size` | An oversized module listed in `scripts/check-monster-files.mjs` is above or below its recorded line ceiling |
| `lint:stage-edge` | The map stage's left edge appears as a literal instead of its one custom property |
| `lint:wheelhouse` | A style or component leaves the design vocabulary (font sizes, radii, motion, colours, glyphs, focus rings, cursors, accessible names, surface roles), or `scripts/wheelhouse-inventory.json` lists a violation that is gone |
| `lint:tokens` | A stylesheet uses a `var(--x)` token nothing defines |
| `lint:icons` | A builder component gains an inline `<svg>` past its recorded count |
| `lint:class-pairs` | Two module stylesheets set the same property on one element at equal specificity, or a stylesheet opens a cascade layer out of the order `src/app/globals.css` names |
| `lint:specimen` | The design specimen page would change if regenerated |
| `lint:contract-docs` | The API description, the MCP tools or the error catalogue disagree with each other or with the API pages |
| `lint:reader-docs` | A file on its list (pages, `README.md`, `AGENTS.md`, procedure notes) is missing or holds superseded copy, or an API page's edit-revision example is incomplete |
| `lint:plugin` | The plugin's guidance file or bundled licence differs from its source |
| `lint:docs` | A page breaks the page contract or a writing rule, or the index, a settings table, `docs/api/openapi.json` or the image manifest is out of date |
| `lint:retired-paths` | A tracked file names a docs path that moved or left |

To check your branch's commit messages as a pull request does:

```sh title="Terminal"
git log -z --format=%B --no-merges main..HEAD | node .github/scripts/check-commit-messages.mjs
```

```text title="Output"
Checked 3 commit messages: clean.
```

The secret scan is `gitleaks dir . --no-banner --redact --exit-code 1`.

## Run the unit tests

```sh title="Terminal"
DEZFIL_DATA_DIR="$(mktemp -d)" npm test
```

- Vitest runs every `src/**/*.test.{ts,tsx}` file, allowing each test and each hook 30 seconds.
- `DEZFIL_DATA_DIR` names a fresh scratch folder. The account fixtures refuse to run without one.

Add a path to run one file: `npm test -- <FILE>`. `npm run test:watch` reruns on change, and `npm run test:coverage` writes a report to `coverage/`.

Live tests skip until you point them at a service. For PostGIS, start a throwaway database and name it in `DEZFIL_TEST_PG_URL`:

```sh title="Terminal"
docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test postgis/postgis:16-3.4
DEZFIL_TEST_PG_URL=postgres://postgres:test@127.0.0.1:54329/postgres npx vitest run postgis.live
```

### The real-render tests

The `*.real-render.test.ts` files render in a real headless Chromium, through a production standalone that shares the test's data folder and its signing key. Provision the standalone as [Run a scratch instance](#run-a-scratch-instance) says. Most skip unless `DEZFIL_MAP_LOOK_RENDER` names the standalone's port:

```sh title="Terminal"
export DEZFIL_RENDER_DELEGATION_KEY=$(openssl rand -hex 32)
export DEZFIL_DATA_DIR=$(mktemp -d) DEZFIL_EGRESS_ALLOWLIST=127.0.0.1
export DEZFIL_CHROMIUM_PATH=<PATH_TO_CHROME_HEADLESS_SHELL>
(cd .next/standalone && PORT=3581 HOSTNAME=127.0.0.1 \
  node --import=./scripts/ingress-preload.mjs \
  --import="data:text/javascript,process[Symbol.for('dezfil.session-delegation-key')]=Buffer.from(process.env.DEZFIL_RENDER_DELEGATION_KEY,'hex')" \
  server.js) > render-standalone.log 2>&1 &
# Wait until http://127.0.0.1:3581/api/health answers {"status":"ready"}.
DEZFIL_MAP_LOOK_RENDER=3581 npx vitest run src/lib/export/map-look.real-render.test.ts
```

Each file's header names its other variables. The map pictures test has its own note, [`src/lib/pictures/pictures.real-render.md`](../../src/lib/pictures/pictures.real-render.md).

## Run the browser suite

The Playwright suite under `e2e/` drives an instance you start yourself. The pipeline does not run it.

> [!WARNING]
> Start one Playwright run at a time per worktree: runs from one worktree share `.claude/browser-auth.json` and sign each other out. The assistant's ports 3202 and 3303 are fixed, so run one suite per machine.

### 1. Install the browsers

```sh title="Terminal"
npx playwright install chromium firefox webkit
```

Chromium runs every spec. Firefox and WebKit run only the fallback cases of `e2e/panel-looks.spec.ts`. You should see each download finish.

### 2. Start an instance for the suite

Build, then start the instance on a fresh data folder, with `tippecanoe` on the `PATH` and Chromium where `DEZFIL_CHROMIUM_PATH` points:

```sh title="Terminal"
npm run build
DEZFIL_DATA_DIR="$(mktemp -d)" PORT=3310 \
DEZFIL_RENDER_CAP_FEATURES=2000 \
DEZFIL_EGRESS_ALLOWLIST=127.0.0.1 \
DEZFIL_OVERPASS_URL=http://127.0.0.1:31877/overpass \
DEZFIL_OVERTURE_S3_ENDPOINT=127.0.0.1:31878 \
DEZFIL_AI_PROVIDER=openai OPENAI_API_KEY=scripted-wire \
OPENAI_BASE_URL=http://127.0.0.1:3202/v1 \
DEZFIL_ASSISTANT_AUTO_CHECK=off \
NODE_OPTIONS="--require $PWD/e2e/assistant-self-port.cjs" \
DEZFIL_E2E_LISTEN_PORT=3310 DEZFIL_E2E_SELF_PORT=3303 \
npm start
```

Without one of these, the specs that need it fail rather than skip:

| Variable | Why the suite needs it |
|---|---|
| `DEZFIL_RENDER_CAP_FEATURES=2000` | The 52,001-feature layers cross the cap and take the tiled road |
| `DEZFIL_EGRESS_ALLOWLIST=127.0.0.1` | The link import, OpenStreetMap and Overture specs reach fixtures on loopback |
| `DEZFIL_OVERPASS_URL` | The OpenStreetMap specs read the recorded fixture the suite serves on port 31877 |
| `DEZFIL_OVERTURE_S3_ENDPOINT` | The Overture specs read the object store fixture the suite starts on port 31878 |
| `DEZFIL_AI_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` | The assistant specs answer from a scripted model the suite serves on port 3202 |
| `DEZFIL_ASSISTANT_AUTO_CHECK=off` | With the check on, a turn that changes the map asks the model once more, and the script has no reply for it |
| `NODE_OPTIONS`, `DEZFIL_E2E_LISTEN_PORT`, `DEZFIL_E2E_SELF_PORT` | The assistant's calls to its own instance go through the suite's counting harness on port 3303; `DEZFIL_E2E_LISTEN_PORT` is the instance's own port |

You should see `{"status":"ready"}` from `curl http://127.0.0.1:3310/api/health`.

### 3. Run the suite

In a second terminal:

```sh title="Terminal"
DEZFIL_BASE_URL=http://127.0.0.1:3310 \
  npm run journey:browser -- --grep-invert "assistant-look|assistant-picker|assistant-catalogue|account-deletion|deleted-attribution|card-states|thumbnail-theme"
```

- `DEZFIL_BASE_URL` names the instance. Without it, the suite targets `http://localhost:3000`.
- `--grep-invert` leaves out the specs that need an instance of their own, listed below.

The suite runs one test at a time, without retries, and keeps a trace of each failure. You should see one line per test, then the counts of passed, failed and skipped tests.

Run it on an idle machine and a fresh data folder: the timed cases fail under load. To run one area, use its script, such as `npm run e2e:layers`.

Some specs skip, and say so, until the test process has their variable:

| In the test process | What else it needs | Turns on |
|---|---|---|
| `DEZFIL_TEST_PG_URL` | A running `postgis/postgis:16-3.4` container, as in the unit tests | The live PostGIS imports |
| `DEZFIL_DATA_DIR` | The server's own value | The real failed tile build |
| `DEZFIL_E2E_ASSISTANT=1` | A real model key on the server | The assistant confirmation smoke; `npm run e2e:smoke` sets it |
| `DEZFIL_TEMPLATES_CATALOGUE` | A local catalogue folder of at least nine templates, named on the server too | `e2e/home.spec.ts` |
| `DEZFIL_E2E_PINNED_QUEUE_MAX=<N>` | A second instance started with `DEZFIL_OPERATION_QUEUE_MAX=<N>` | The locked limit in `e2e/settings-page.spec.ts` |
| `DEZFIL_NO_RENDERER_URL` | A second instance whose `DEZFIL_CHROMIUM_PATH` names no file | The no-renderer cases of `e2e/card-states.spec.ts` |
| `DEZFIL_E2E_FIRST_RUN=1` | An instance with no account yet | `e2e/account-entry.spec.ts`, the first-account journey |

These specs need an instance started differently, as each file's header says:

| Spec | Its instance |
|---|---|
| `e2e/assistant-look.spec.ts` | The automatic check on, `e2e/assistant-preloads.cjs` in place of the self-port preload, `DEZFIL_E2E_RENDER_STUB=1` and `DEZFIL_ASSISTANT_LOOK_RETENTION=2` |
| `e2e/assistant-picker.spec.ts` | `DEZFIL_AI_MODELS_OPENAI` naming the three models its header lists |
| `e2e/assistant-catalogue.spec.ts` | Two boots, one per model offer, on a data folder under the worktree's `.claude` folder that the test process names too |
| `e2e/account-deletion.spec.ts`, `e2e/deleted-attribution.spec.ts` | `--import=./scripts/deletion-proof-preload.mjs`, and `DEZFIL_PROOF_CONTROL_DIR` set to the same fresh absolute folder on both sides |
| `e2e/card-states.spec.ts`, `e2e/thumbnail-theme.spec.ts` | The picture instance with the style fixture preload, as [`src/lib/pictures/pictures.real-render.md`](../../src/lib/pictures/pictures.real-render.md) describes |

The pixel baselines are cut on macOS, and most pixel specs skip on other systems.

## Drive the API without a browser

```sh title="Terminal"
node scripts/journey.mjs http://127.0.0.1:3310
```

The journey walks the API from upload, SQL and styling to publishing and an image export. It exits non-zero at the first broken step.

```text title="Output"
Dezfil headless journey → http://127.0.0.1:3310

  ✓ 01 instance reports ready
  ✓ 02 signed in and created an API token before protected work
  ✓ 03 machine-readable API description is served
  ...
Journey complete — <N> steps passed.
```

On a machine without Chromium, add `--http-only`. The journey then skips the image export and says so.

On an empty store the journey creates its own account, and it signs back in to that account on later runs. A store another account set up turns it away.

| Command | What it drives |
|---|---|
| `node scripts/mcp-journey.mjs <BASE_URL>` | The same journey over the MCP endpoint, with no model. `--render` adds a real image render. |
| `node scripts/durability.mjs seed <BASE_URL> <STATE_FILE>`, then `verify` | Maps, sessions and tokens survive a replaced server, and revoked ones stay refused |
| `node scripts/ownership-journey.mjs seed <BASE_URL> <STATE_FILE>`, then `verify` | An admin and two people, each keeping their own work private, over REST, tokens and MCP |
| `node scripts/sharing-journey.mjs seed <BASE_URL> <STATE_FILE>`, then `verify` | A project shared as Viewer and as Editor, a non-member, and leaving a project |
| `npm run journey:recovery` | A server killed during a run and started again on the same data. It needs `npm run build`, a detached worktree and port 3197, or `--port` for another. |

These sign in as the journey does. Run `seed`, replace or restart the server over the same data folder, then run `verify` with the same state file. The state file holds credentials: keep it in scratch storage.

## Build and check the image

```sh title="Terminal"
docker build -t dezfil:ci .
node scripts/check-image-inventory.mjs dezfil:ci
docker run --rm --network=none -v "$PWD/scripts:/scripts:ro" \
  dezfil:ci node /scripts/check-duckdb-extensions-offline.mjs
```

- `check-image-inventory.mjs` fails when `/app` holds anything outside the checked-in allowlist, or repository metadata, data, keys or environment files anywhere.
- `check-duckdb-extensions-offline.mjs` loads every engine extension inside the image with the network off.

```text title="Output"
PASS — <N> paths, all within the allowlist.
ok: spatial
...
PASS — all 7 extensions load offline.
```

The image job runs these on `main`, among many checks of the running container. [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) lists every step. [Architecture](architecture.md) says what the image holds.

## Checks outside the pipeline

Some checks need a production build, a container or a long timed run. Each has its procedure in a note beside its script:

| Note | What it checks |
|---|---|
| [`scripts/sharing-journey.md`](../../scripts/sharing-journey.md) | Leaving a shared project, on a production standalone |
| [`src/lib/pictures/pictures.real-render.md`](../../src/lib/pictures/pictures.real-render.md) | Map card pictures with a real renderer, and the card states without one |
| [`scripts/pictures-capacity.md`](../../scripts/pictures-capacity.md) | How many map pictures the renderer makes, and how fast |
| [`scripts/render-egress-driver.md`](../../scripts/render-egress-driver.md) | Where the image renderer may connect |
| [`scripts/render-paired-driver.md`](../../scripts/render-paired-driver.md) | Private certificate trust, the browser transport and render timing |
| [`scripts/provider-cancel-probe.md`](../../scripts/provider-cancel-probe.md) | Place search and basemap inspection stop their outside calls when the caller leaves |
| [`scripts/transport-probe.md`](../../scripts/transport-probe.md) | Whole uploads and request transport |
| [`scripts/body-probe.md`](../../scripts/body-probe.md) | JSON and MCP request body limits |
| [`scripts/query-result-budget-probe.md`](../../scripts/query-result-budget-probe.md) | The byte budget of a SQL result |
| [`scripts/publication-source-probe.md`](../../scripts/publication-source-probe.md) | How a published link tells visitors apart, direct and behind a proxy |
| [`scripts/derivation-probe.md`](../../scripts/derivation-probe.md) | Password hashing admission and timing |
| [`scripts/credential-cleanup-driver.md`](../../scripts/credential-cleanup-driver.md) | Credential cleanup and sign-in across replaced containers |
| [`scripts/served-contract-proof.md`](../../scripts/served-contract-proof.md) | The served API description and tool list against the API pages |
| [`scripts/settings-probe.md`](../../scripts/settings-probe.md) | Settings kept across a restart |
| [`scripts/gate-journey.md`](../../scripts/gate-journey.md), [`scripts/login-http-probe.md`](../../scripts/login-http-probe.md), [`scripts/published-auth-probe.md`](../../scripts/published-auth-probe.md) | The sign-in gate, the sign-in limits and anonymous access to published maps |
| [`src/lib/ingest/reception.standalone.md`](../../src/lib/ingest/reception.standalone.md) | Upload reception on a production standalone |
| [`src/lib/auth/abandonment.standalone.md`](../../src/lib/auth/abandonment.standalone.md) | A caller who leaves in the middle of a request |
| [`scripts/account-deletion-driver.md`](../../scripts/account-deletion-driver.md), [`scripts/account-deletion-pages-proof.md`](../../scripts/account-deletion-pages-proof.md), [`scripts/account-deletion-parity-proof.md`](../../scripts/account-deletion-parity-proof.md), [`scripts/account-compaction-proof.md`](../../scripts/account-compaction-proof.md) | Account deletion: rows, files, pages, every surface, and the store's compaction |
| [`scripts/account-upgrade-proof.md`](../../scripts/account-upgrade-proof.md), [`scripts/account-identity-proof.md`](../../scripts/account-identity-proof.md) | An upgraded store, and admin recovery after the original account is deleted |

When you add a table, a file or anything else that holds an account's data, add its entry as [`src/lib/auth/account-erasure-inventory.md`](../../src/lib/auth/account-erasure-inventory.md) says.

## Regenerate what is generated

A script writes each of these. Run it and commit what changed, rather than editing the output:

| What | Command | Fails while stale |
|---|---|---|
| The docs index, the settings tables and `docs/api/openapi.json` | `npm run docs:write` | `npm run lint:docs` |
| The docs pictures | `npm run docs:pictures`, in a detached worktree after `npm run build` | `npm run lint:docs`, only when the manifest and the files disagree |
| The design specimen, `design/identity/dezfil-identity.html` | `node scripts/build-specimen.mjs` | `npm run lint:specimen` |
| The look's background sheets in `public/look/` | `node scripts/generate-look-sheets.mjs` | The unit suite runs its `--check` |
| The plugin guidance file and its licence | `node scripts/generate-dezfil-guidance.mjs` | `npm run lint:plugin` |
| A plugin package for one instance | `node scripts/prepare-dezfil-plugin.mjs --output <NEW_FOLDER> --base-url <ORIGIN>` | Not committed: prepare a fresh copy when the instance address changes |

Two kinds are cut by hand:

- **Pixel baselines:** on macOS, against a production build on a fresh data folder, run one spec at a time with `npx playwright test e2e/<SPEC>.spec.ts --update-snapshots=changed`. Compare each rewritten picture with the old one before you commit it.
- **The assistant baselines:** the captures under `test-support/assistant-baselines/` have no script. When the unit suite says one moved, confirm the change is meant, then update the capture by hand.

## Test and development wiring

The unit tests, the browser specs, the helper scripts and the server's test seams read these variables. None is a setting: never set one on an instance people use.

<!-- test-wiring:start -->

| Variable | Default | What it does |
|---|---|---|
| `DEZFIL_TEST_PG_URL` | unset | Disposable PostGIS fixture URL for probes. |
| `DEZFIL_TEST_PUBLICATION_LOG` | unset | Publication observer output destination. |
| `DEZFIL_TEST_DERIVATION_LOG` | unset | Password derivation observer output destination. |
| `DEZFIL_TEST_EXTENSION_REPOSITORY` | unset | Loopback extension repository for the engine's installs under test. |
| `DEZFIL_OVERTURE_S3_ENDPOINT` | unset, the public bucket | S3-compatible override for the public Overture bucket. |

<!-- test-wiring:end -->

`npm run lint:readme` holds this table to the catalogue and to what the code reads, in both directions. A `DEZFIL_TEST_` variable only test files read stays local to them.

The tests and scripts also read these names, among others, which no check holds:

| Variable | What reads it |
|---|---|
| `DEZFIL_BASE_URL` | The browser suite and the journey scripts, for the instance they drive |
| `DEZFIL_E2E_FIRST_RUN`, `DEZFIL_E2E_ASSISTANT`, `DEZFIL_E2E_LISTEN_PORT`, `DEZFIL_E2E_SELF_PORT`, `DEZFIL_E2E_RENDER_STUB`, `DEZFIL_DEBUG_PNG` | The browser suite's switches |
| `DEZFIL_TEST_PG_TLS_URL`, `DEZFIL_TEST_OVERTURE`, `DEZFIL_TEST_TILER_LOG`, `DEZFIL_TEST_TILER_RELEASE`, `DEZFIL_TEST_TILER_STARTED` | Fixture addresses and stubs of the unit tests |
| `DEZFIL_ASSISTANT_LIVE`, `DEZFIL_RESTART_CHILD`, `DEZFIL_STREAM_EVIDENCE`, `DEZFIL_GEOMETRY_TILER_RELEASE`, `DEZFIL_GEOMETRY_TILER_STARTED` | Opt-in arms and seams inside single unit test files |
| `DEZFIL_MCP_PROBE_LOG`, `DEZFIL_PLUGIN_RENDER_LOG` | Log files of the scripts that drive the agent surfaces |

A new setting gets its row from the catalogue: add it to `src/lib/settings/catalogue.ts`, give it an area in `scripts/settings-tables.mjs`, then run `npm run docs:write`.

## Variables the platform sets

The runtime or the image sets these. They are not settings, and `npm run lint:readme` leaves them out by name.

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

## Troubleshooting

**`/api/health` answers 503, and the log says "The ingress preload is required".** The server started without the preload. Start it with `npm run dev`, `npm start`, or `node --import=./scripts/ingress-preload.mjs server.js`.

**A test run pauses, or an import fails on a missing extension.** The engine is fetching its extensions from the network. Install them once with `node scripts/install-duckdb-extensions.mjs "$PWD/duckdb-extensions"`, then set `DUCKDB_EXTENSION_DIR` to that folder.

**Browser specs fail instead of skipping.** A variable of [step 2](#2-start-an-instance-for-the-suite) is missing on the server, `tippecanoe` is not on its `PATH`, or it has no Chromium. Check the server process's environment, not the test process's.

**A journey refuses with "use an isolated loopback port, never 3000".** Start the scratch instance on `127.0.0.1` or `localhost`, on a port of 3300 or higher.

**`npm run journey:recovery` stops with "Evidence worktree is detached".** It runs only from a detached worktree. Make one as in [Run a scratch instance](#run-a-scratch-instance).

## Next steps

- [How this is built](how-this-is-built.md): take a change from an idea to a merged pull request.
- [Architecture](architecture.md): where each part of the container lives in the source.
- [Contributing](../../CONTRIBUTING.md): sign-off, commit messages and licensing.
