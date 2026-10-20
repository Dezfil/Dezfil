# Picture capacity and measurement

Run these proofs on a separately built production instance, under the same
exclusive test lock as the browser battery. Use the real headless browser and
default two image slots. The basemap is the raster tile server in
`scripts/loopback-basemap.mjs`, also used by
`src/lib/export/map-look.real-render.test.ts`. Start it with
`scripts/loopback-basemap-serve.mjs` in a separate terminal and keep it
running through every application restart:

```sh
fnm exec --using=24 node scripts/loopback-basemap-serve.mjs 3582
```

It serves a light style at `http://127.0.0.1:3582/style.json`, light and dark
variants at `/light/style.json` and `/dark/style.json`, and PNG tiles over
loopback. Every map has a small point layer at its saved centre. Singles use
the loopback style directly. Pairs keep Auto: the test-only style preload
redirects the built-in light and dark styles to the loopback variants, so
both appearances fetch tiles and draw data without public network requests.
The fixture presents the loopback destination to the egress gate as well, so
style admission needs no public DNS lookup.

The offline seeder refuses an existing database; the runner refuses port 3000. Each workload
gets its own stopped instance and fresh `pictures-` data directory. Its owner
token is written with mode 0600 beside the manifest and is never printed.

First seed twenty maps without pictures, ten singles and ten pairs:

```sh
export DEZFIL_PICTURE_BASEMAP_URL=http://127.0.0.1:3582/style.json
export DEZFIL_PICTURE_STYLE_FIXTURE=1
export DEZFIL_EGRESS_ALLOWLIST=127.0.0.1
export DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/scratch/pictures-measure-XXXXXXXX")
fnm exec --using=24 node scripts/pictures-capacity.mjs seed-first .claude/scratch/pictures-first.fixture.json
export DEZFIL_PICTURE_METRICS="$PWD/.claude/scratch/pictures-first.events.jsonl"
export DEZFIL_PICTURE_TEST_URL=http://127.0.0.1:3581
# Start the separate production server with this store and PORT=3581.
# Preserve the environment above and add both preloads to its launch:
# --import=./scripts/pictures-browser-fixture-preload.mjs
# --import=./scripts/pictures-metrics-preload.mjs
# restart-isolated-server is an executable that replaces only that instance,
# preserves its store, metrics path and environment, then returns.
fnm exec --using=24 node scripts/pictures-capacity.mjs run \
  .claude/scratch/pictures-first.fixture.json .claude/scratch/pictures-first-run.json unused \
  -- ./restart-isolated-server
```

Supply `DEZFIL_STANDALONE_DIR` when the standalone instance owns the matching
native modules in a different module tree. Copy both preloads into that
instance's `scripts/` directory, beside its module tree, as in the browser
recipe above. The seed, server and runner must share the basemap address.
Start the runner promptly after the server, before the first fifth of its
backlog drains.

The restart executable must stop **only the listening process**, wait for it
to exit, and relaunch that instance with the same store, event file, preloads
and environment. Identify it with `lsof -ti tcp:3581 -sTCP:LISTEN` (substitute
the isolated instance's port). Never kill every process on the port with
`lsof -ti tcp:3581`: that also lists the runner's client connections and kills
the measurement. Keep the loopback tile server running on its separate port.
For the mixed workload, the restart must interrupt a background render while
it still holds its slot. Do not gracefully drain it: the event oracle rejects
a render that finishes before the replacement process boots.

The metrics preload records admission, physical slot release and successful
publication, covering both appearances and reduction. The report keeps the raw events,
machine and runtime information, per-attempt timings, median and 90th
percentile, and browser-process peak RSS sampled every 250 ms. The sample peak
is not an instantaneous allocation maximum. Idle foreground export admission
and check response are reference observations only. At two slots it takes five
samples each of export admission and check response while one background render
is in flight, proving from events that the same render still holds its slot
when the foreground request is admitted. Each foreground limit is its 90th
percentile times 1.5. The run refuses a margin as large as the shortest measured
picture render; it never silently widens that margin. At one slot, a separate
assertion requires actual interruption and export admission within one picture's
budget. It also measures startup and restart overhead, and freezes the 300-map
ceiling at 300 times the measured 90th percentile times 1.5 plus startup and
restart overhead. Foreground ceilings
are frozen before the proof workloads; older idle-based reports are refused.

Then seed and start fresh instances for each capacity workload. Use fresh
manifest and event filenames for each. Pass the successful first-run report
unchanged as the fourth argument:

Re-seed the mixed fixture with the current seeder and a new stopped store.
Older manifests lack `drawingChangedAt` for recency ordering and
`oldPictureSha256` for checking the served bytes; do not reuse them or fill
those fields by hand. The frozen first-run limits stay unchanged.

```sh
# With a new stopped instance/store and matching fresh metrics path:
fnm exec --using=24 node scripts/pictures-capacity.mjs seed-missing .claude/scratch/pictures-missing.fixture.json
# Start the isolated server, then:
fnm exec --using=24 node scripts/pictures-capacity.mjs run \
  .claude/scratch/pictures-missing.fixture.json .claude/scratch/pictures-missing-run.json \
  .claude/scratch/pictures-first-run.json
# Repeat the provisioning with another fresh store:
fnm exec --using=24 node scripts/pictures-capacity.mjs seed-mixed .claude/scratch/pictures-mixed.fixture.json
# Start the isolated server, then:
fnm exec --using=24 node scripts/pictures-capacity.mjs run \
  .claude/scratch/pictures-mixed.fixture.json .claude/scratch/pictures-mixed-run.json \
  .claude/scratch/pictures-first-run.json -- ./restart-isolated-server
```

The mixed fixture has 100 missing, 100 old-road and 100 current pictures.
Its restart occurs halfway through the pending work, with an unpublished
background render in flight. Independent publication
events reject a repeated remake, missing work, a current map being rendered,
an old picture overtaking a missing one, or recency order broken within either
pending cohort. During backfill, four readers repeatedly fetch both themes of
every old-road map: the seeded bytes must stay served until publication, and
each replacement must then be read. Readers drain before the intentional
downtime and resume after the restart.

The mixed report adds `oldPictureReads`, recording each map and theme, HTTP
status, byte count, SHA-256, request and answer times, event cursors, classified
phase and any read error. `restartSample` records the publication count,
admission index and event cursor at the restart request;
`restartAfterPublications` records its position in the workload.
`restartInterruption` identifies the interrupted map, old and new process IDs,
admission index and replacement boot index. The raw events must show its
resumed admission and exactly one publication on the replacement process.

Each run takes five export and five
check samples, one of each in every fifth of the pending publications. Before
each request it waits for a background render in flight; a sample without
overlap is refused. Every sample must meet its frozen limit, and every sample
is retained in the report, including one that fails. Both runs require a saved
camera change to reach a new picture within a minute for a single and a pair.
Nonzero exit or `result: failed` is
failure; keep its raw report. A passing unit fixture does not demonstrate
renderer throughput. Stop the isolated instance and the loopback server and
remove the store, token and temporary files after collecting the proof artifacts.
