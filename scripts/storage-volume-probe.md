# Full-volume recovery proof

This probe runs against a production standalone on an owned loopback port, with
its data on a fixed 1.5 GB disk image. It never uses the development instance.
The driver owns the image, mount and server, stops the server, detaches the image
and removes it. Logs and the JSON result stay in the scratch directory, outside
the full volume. It starts no browser.

Build the standalone first, then run on macOS with Node 24 and tippecanoe:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/storage-volume-XXXXXX") \
  fnm exec --using=24 node scripts/storage-volume-driver.mjs \
  --standalone "$PWD/.next/standalone" --port 3409
```

The image job on `main` runs the same probe with a bounded `tmpfs`:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/storage-image-XXXXXX") \
  fnm exec --using=24 node scripts/storage-volume-driver.mjs \
  --container dezfil:ci --port 3409
```

The container has no external network, no published host port and runs as the
image's unprivileged user. `/data` is a 1.5 GB tmpfs; `/proof` is a separate
64 MB tmpfs. The scripts are mounted read-only. The driver copies evidence out
before removing its exact container and volumes, including on failure. HFS+
and tmpfs may fail at different byte counts; assertions concern outcomes.

Allow four minutes after readiness. The driver requires at least 3 GB free on
the host and refuses port 3000. A disk image outside 1–2 GB cannot be filled by
the probe. If `hdiutil` cannot create or attach the image, the result is failed,
not a skipped or passing proof. Run it on a machine allowed to attach images.

The probe uses real requests, real SQLite and DuckDB writes, and real
tippecanoe. Its preload pauses a conversion before native COPY. Its tiler
wrapper pauses a real build before running the original binary. A declared
multipart body stays open after its first MB. These timing controls inject no
no-space errors and change no application route. All control files sit outside
the bounded volume; the hog allocates blocks until the filesystem itself
returns ENOSPC and has no writable block left.

The assertions cover:

- Two declared uploads admitted together, each fitting alone, and an expanding
  conversion. At zero free blocks all answer 507 `storage_exhausted`, leave no
  partials or ownership records, and keep the existing dataset generation.
- A conversion, a tile process and a declared receiver live at zero. An existing
  session reads and a fresh sign-in succeeds. The recovery fence stops all three
  with `storage_exhausted`, records settlement within 35 seconds, removes scratch,
  ends the tiler and keeps the previous archive and evidence byte for byte.
- Dataset deletion, token revocation, unpublish, map deletion and cache clearing,
  refilling the hog before each action so a prior recovery cannot mask it.
- Account deletion with less than twice the metadata size free. No outside
  SQLite handle is kept open: compaction reports `needs-retry`, then completes
  after space returns. The fixture pads the store with an unrelated retained
  row so a recovery slice cannot accidentally satisfy compaction.
- Reserve replenishment, a new upload and a fresh tile build after space returns,
  and alternating full/available transition logs.

The probe and driver each emit one JSON result line and exit nonzero on any
failed assertion. A successful result has `label: confirmed`, the outcomes and
measured fence-to-settlement times. Preserve that result and the server log when
reporting a run. Helper tests do not establish recovery on a real full volume:

```sh
fnm exec --using=24 node --test scripts/storage-volume.test.mjs
```

Those tests also demonstrate failing controls: an ENOSPC claim with free blocks
remaining, a 500 or wrong-code response, an unbounded volume and port 3000.
