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

Allow four minutes after readiness; a passing run takes about one. The driver requires at least 3 GB free on
the host and refuses port 3000. A disk image outside 1–2 GB cannot be filled by
the probe. If `hdiutil` cannot create or attach the image, the result is failed,
not a skipped or passing proof. Run it on a machine allowed to attach images.

The probe uses real requests, real SQLite and DuckDB writes, and real
tippecanoe. All control files sit outside the bounded volume; the hog allocates
blocks until the filesystem itself returns ENOSPC and has no writable block
left. Nothing injects a no-space error or changes an application route.

What is live when recovery fires, and what stays held:

- **The conversion is a real COPY in the engine, not paused.** It computes a sum
  over a range too long to finish, so it has opened its file and writes nothing
  until its one row: that is what lets it stay alive on a volume with no block
  left. The probe measures the server computing while the volume is full,
  requires the COPY to end with the engine's own interruption after the fence
  refuses it, and requires its file to go. It does not prove interruption in the
  middle of a block write. The earlier expanding COPY does run out of volume
  mid-write, with nothing holding it, but it fails by itself before any fence.
- **The tile build is the real tiler process.** The wrapper starts it on the real
  input and holds back the last line, so it has its output open and is blocked
  reading a pipe. The probe requires that pid alive on the full volume and gone
  after the fence, and the scratch it left removed. What it was stopped doing is
  reading, not writing a tile.
- **The receiver is a real server stream.** The client declares a body and stops
  sending. Only the peer is held; the server code is the shipped code.

The refresh runs earlier and has ended by then: it is a real download whose
loopback source declares a large file and stops after the first MB until the
volume is full. It proves that a refused replacement keeps the old bytes, not
that the fence stops a refresh.

The preload only observes: it logs native results, writer events and the server's
CPU, and pauses nothing. With `DEZFIL_PROOF_DISABLE_INTERRUPT=1` it disables the
engine's interruption for a negative control: the proof must then fail with the
fence overdue and "Recovery fence did not settle and reopen". The same control runs on
every pull request against the real engine in
[the fence's engine test](../src/lib/system/storage-fence-engine.test.ts).

The assertions cover:

- Two declared uploads admitted together, each fitting alone, a failing refresh
  of the dataset whose bytes are asserted, and a conversion that expands past
  what the volume has. At zero free blocks all answer 507 `storage_exhausted`,
  leave no partials, candidate generation or ownership records, and keep the
  existing dataset generation byte for byte. After space returns, the same refresh
  replaces those bytes, which is what makes that checksum able to fail.
- A live COPY, a live tiler and a declared receiver at zero. An existing session
  reads and a fresh sign-in succeeds. The recovery fence stops all three with
  `storage_exhausted`, records settlement within 35 seconds, removes scratch and
  keeps the previous archive and evidence byte for byte.
- Dataset deletion, which must remove its file, token revocation, unpublish, map
  deletion and cache clearing, refilling the hog before each action so a prior
  recovery cannot mask it. The publication answers while full and stops answering
  at unpublish, before its map is deleted. Each provider cache holds a seeded answer
  file that the clear must remove; the seed is a file in the cache's place, not one
  a provider answered, because the probe has no provider and no network.
- Account deletion with less than twice the metadata size free. The account's
  file is gone by then. No outside SQLite handle is kept open: the deletion reports
  `needs-retry` with its journal at the compaction stage, then completes after
  space returns, leaving the erased row. The fixture pads the store with an unrelated retained
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
