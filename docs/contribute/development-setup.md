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
  [the runbook](../self-host/backup-and-restore.md#map-picture-proofs) provisions them.

Operational recipes for running an instance live in
[the runbook](../self-host/backup-and-restore.md).

Tiled rendering of large layers shells out to
[tippecanoe](https://github.com/felt/tippecanoe) (`brew install tippecanoe`
on macOS; build from source on Linux). Without it everything else works —
only points layers over the render cap or Bytes drawn per layer report the
missing tiler. The Docker image
bakes it in.
