# Dezfil

Self-hosted spatial SQL and map publishing, powered by DuckDB and files.
Upload geospatial data, query it with SQL, style it on a map, publish a
shareable view, from one container.

This file is the brief for coding agents working in this repository: the
constraints that hold across every change. Before you touch a page under
`docs/` or a behavior a page describes, read the documentation index,
[docs/README.md](docs/README.md): every page with its summary and the
situations it is written for. To write or rewrite a page, follow
[docs/contribute/write-docs.md](docs/contribute/write-docs.md): the writing
rules and the checks that hold them. What the product does is in
[README.md](README.md), how to run it in
[docs/start/install.md](docs/start/install.md), and how to run the checks,
the tests and the instances they need in
[docs/contribute/development-setup.md](docs/contribute/development-setup.md).

## The product

- **Licensed Apache-2.0** ([LICENSE](LICENSE)). Third-party credits live in
  [NOTICE](NOTICE) and are a condition of shipping, not a courtesy. Do not
  edit a credit line to tidy prose.
- **One container.** A single image runs the whole product against one data
  directory. Anything that needs a second service to be correct is the wrong
  shape here, and that includes the metadata store: map metadata is an
  embedded SQLite database inside the data directory.
- **Files are the durable artifacts.** Tables are GeoParquet, large tilesets
  are PMTiles. A user's data stays readable without this application.

## The stack, and the rules that come with it

- **Rendering** is deck.gl over a MapLibre GL basemap. The builder is ours,
  a thin layer on deck.gl rather than an embedded third-party workspace.
- **The query engine is DuckDB with its spatial extension, server-side
  only.** There is no browser or WASM query path, and introducing one is not
  a local decision: the client calls the API. Working past browser memory is
  the reason the engine sits on the server.
- **User SQL runs on a separate hardened, read-only instance**, with
  extension autoload off; the trusted instance is for ingest and inspection.
  Never widen the hardened instance to make a feature easier.
- **SQL is the source of truth for a layer.** A layer is its SQL, a name and
  a style. Style is presentation over that query and never becomes a second,
  hidden query path.
- **Formats:** GeoParquet for tables, PMTiles for large tilesets, H3 for
  index-based workflows and widgets. The visual hexbin is a planar
  tessellation at any cell size, so it takes a cell size and not an H3
  resolution.
- **App shell:** Next.js and React. The repositories keep portable SQL, so
  the metadata store can be swapped without a rewrite.

## Agent-ready by construction

Every capability ships as an API the UI merely calls. The MCP tool set, with
its input and output schemas and its consequence metadata, is **generated
from the OpenAPI description**, and a test holds the two in parity. A
capability that exists only in the UI is therefore a defect, not a
simplification, and a feature a person can do but an agent cannot is not
finished.

What follows from that:

- New behavior starts as a documented operation with a route behind it; the
  UI then calls it like any other client.
- The OpenAPI description is a published contract. A renamed path, field or
  error code is a breaking change and is written up as one.
- If an agent using the API would need a warning not to do something, change
  the API until the mistake is impossible or harmless. Do not ship the
  warning instead.

## Working in this repository

```sh
npm ci                                   # install exactly what the lockfile pins
npm run dev                              # the app on port 3000, data in ./data
DEZFIL_DATA_DIR="$(mktemp -d)" npm test  # the unit and integration suite, on a scratch data folder
npm run lint                             # eslint
npm run typecheck                        # tsc, no emit
npm run build                            # the production build
npx playwright test                      # the browser suite, against a running instance
```

Past lint and types there are named gates, each its own script, each holding
something review keeps missing: `lint:hygiene` (no NUL bytes in tracked
source), `lint:readme` (the settings tables cover every
deployment variable and stored instance setting once, both directions), `lint:size` (the oversized modules below),
`lint:stage-edge` (the builder stage's left edge stays one custom
property), `lint:wheelhouse`, `lint:tokens` and `lint:icons` (the design
language), `lint:class-pairs` (no element's look left to the order two
stylesheets load in), `lint:specimen` (the specimen still matches its sources),
`lint:plugin` (the generated plugin guidance is current), `lint:contract-docs`
(the error schema, the derived tools, the change authors and the reader
counts match the contract), `lint:reader-docs`
(no superseded guidance or missing revision examples), `lint:docs` (every
page under `docs/` holds the page contract and, unless it waits on the list
of pages not yet rewritten, the writing rules; its links and pictures
resolve, so do those of the procedure notes under `scripts/` and `src/`, and
the index, the API description file, the settings tables and the image
manifest are current) and
`lint:retired-paths` (no tracked file names a documentation
path that moved or left). Run the ones a change can plausibly break, and all of them before
calling it done.

[The pipeline](.github/workflows/ci.yml) is the definition of green: it runs
those checks and the suite on a pull request, then builds the container image
and drives the documented API through it after a merge. The browser suite is
not in it: run it yourself, on an instance you provisioned for it. The
required and optional variables are listed in
[Development setup](docs/contribute/development-setup.md#run-the-browser-suite).

**A change ships with its tests.** Prefer a test that fails before the
change and passes after it. A test that cannot fail is worse than no test:
it converts an unexamined assumption into a green tick.

**A claim is backed by a run.** Do not report a gate as passing unless the
command ran in this working tree and you read its output. If something was
not run, say so plainly rather than describing what it would have done.

## Conventions

- **Commits** follow Conventional Commits, `type(scope): subject`, and carry
  a `Signed-off-by:` trailer under the Developer Certificate of Origin
  (`git commit -s`). A substantial change earns a body: what changed, why,
  and how it was validated, including what the validation did not cover.
- **No internal citations in the tree.** No ticket-shaped numbers from a
  private tracker, no references to documents this repository does not
  carry, no model or tool names in narrative prose. That holds for code
  comments, commit messages and user-facing strings alike. Write the reason,
  not the reference.
- **UI copy is not documentation.** A hint exists only to name a surprise: an
  inert control, a silent conversion, something that will not be published, a
  value about to be discarded. If the control's own label, icon or thumbnail
  already says it, delete the hint rather than shortening it. No em dashes in
  user-facing copy; use a period, colon, comma or a middle dot.
- **Docs mirror the implementation.** Where a document disagrees with
  working code, the document is what is stale. Fix it in the same change.
- **Borrowed code keeps its header.** Code copied from a permissively
  licensed project keeps its original copyright and licence header, and the
  project is added to [NOTICE](NOTICE). A comment that names where an
  inherited value came from is attribution and stays. Code under a copyleft
  licence is reference only, never copied in.
- **Oversized modules shrink at the feature that touches them.**
  `src/components/builder/MapBuilder.tsx`,
  `src/components/map/MapCanvas.tsx`, `src/lib/layer-service.ts` and
  `src/components/builder/StylePanel.tsx` are the largest; each sits at a
  recorded line ceiling that `npm run lint:size` pins in both directions, so
  growth fails until the ceiling is raised deliberately and a shrink fails
  until it is lowered. New logic starts in a new module; a change that
  touches one of these extracts the piece it worked on.
- **The design language is Wheelhouse.** Its living specimen is
  [design/identity/dezfil-identity.html](design/identity/dezfil-identity.html),
  and parts of it are enforced by `lint:wheelhouse`, `lint:tokens` and
  `lint:icons`.

## Saying what you verified

Every verification claim carries one of four labels, and "verified" on its
own is not one of them:

- **confirmed**: the code path or artifact directly demonstrates the claim.
- **confirmed mechanism, unmeasured impact**: deterministic in code, but the
  user-facing magnitude needs a profile or a reproduction.
- **plausible**: credible from reading the code; needs a concurrency,
  failure-injection or browser test before it is confirmed.
- **comparative judgment**: depends on user expectation or on another
  product's behavior, and is never "verified".

An untested branch is not verified, however convincing the code reads and
however green its sibling is. Preserving the uncertainty is the point: a
finding dropped for being merely plausible is a finding someone relearns.

## Out of scope for now

Local accounts, private ownership and project sharing are shipped. Maps and
workflows use edit revisions: stale saves are refused, unsaved work stays visible,
and Reload offers text copying before discarding it. There is no automatic merge.

- **Organizations, SSO, audit logs and finer grants.** Sharing is through a
  project's Viewer or Editor role. Administration does not grant private content
  access. Individual resource grants and organization-wide permissions are outside
  this model.
- **Warehouse connectors.** The engine is DuckDB over files, plus the
  PostGIS connections the ingest path already documents.

Both are deliberate boundaries rather than gaps waiting to be filled. If a
change seems to need one of them, that is the thing to raise, not to build.
