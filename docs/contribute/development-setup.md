---
title: "Checks and testing"
summary: "How to run a checkout for development, the unit and browser suites, and what a full browser run needs provisioned."
read_when:
  - "you set up a checkout to change the code"
  - "you run the browser suite against an instance of your own"
audience:
  - developer
checked: none
moved_from:
  - "/docs/develop/checks-and-testing/"
---

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
  opt-in itself);
- `DEZFIL_NO_RENDERER_URL` (test process) at a second isolated instance
  without an image renderer — the card states with no renderer, as
  [the runbook](../../src/lib/pictures/pictures.real-render.md) provisions them.

Operational recipes for running an instance live in
[the runbook](../self-host/backup-and-restore.md).

Tiled rendering of large layers shells out to
[tippecanoe](https://github.com/felt/tippecanoe) (`brew install tippecanoe`
on macOS; build from source on Linux). Without it everything else works —
only points layers over the render cap or Bytes drawn per layer report the
missing tiler. The Docker image
bakes it in.

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

`npm run lint:readme` holds this table to the settings catalogue and to what
the code reads, in both directions: a `DEZFIL_TEST_*` variable a helper script
or the server reads outside a test file has a row here, and a row here names
one still read.

Other names the tests, the browser suite and the helper scripts read are not
in the table:

- `DEZFIL_BASE_URL`: the target address for the browser test runner and the
  headless journey scripts.
- `DEZFIL_E2E_FIRST_RUN=1`: leaves account setup to the first-run browser
  journey on an empty scratch store instead of provisioning a signed-in
  fixture.
- `DEZFIL_TEST_PG_TLS_URL`, `DEZFIL_TEST_OVERTURE`, `DEZFIL_TEST_TILER_LOG`,
  `DEZFIL_TEST_TILER_RELEASE`, `DEZFIL_TEST_TILER_STARTED`: fixture
  endpoints and stub seams for the unit suites.
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
that reads them and are not part of the settings surface. The configuration
check does not see them, because it scans non-test source files under `src`
and only `DEZFIL_TEST_*` reads in helper scripts and in those source files.

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
