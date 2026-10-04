# Account store compaction proof

Account erasure's internal metadata stages have no public deletion route yet.
The compaction primitive performs in-place VACUUM and checks both the truncating
checkpoint result and the live WAL length. It throws if it cannot finish; it
never declares an account deletion complete. The eventual coordinator must drain
admitted work before entering this synchronous maintenance interval.

The proof uses the current migrated schema, a real open SQLite store and the
production compaction module in a dedicated HTTP process. A separate process
probes its health every 100 ms. It is a compaction proof, not a built application
page, confirmation, fencing, restart or full account-deletion journey.

Run outside a restricted sandbox, from the candidate checkout with dependencies
installed and its candidate image built. The image's native SQLite dependency is
used in the container; the candidate source and proof scripts are mounted read-only.
Every invocation needs a fresh empty scratch directory. Port 3394 belongs to this
proof, not to a product server. No existing store is accepted.

```sh
IMAGE=dezfil:account-departures
mkdir -p .claude/test-data
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/compaction-XXXXXX") \
  node scripts/account-compaction-proof.mjs --container "$IMAGE" --port 3394
```

This one command runs on the host and in the image. Each measures three fresh-copy
trials at 64 MiB, 256 MiB and 1 GiB, with 24–26% of pages reclaimable (the 25% fixture
allows whole-page rounding). It prints actual size, reclaimable pages, outside
health latency/gap, in-process interval, maximum pause and sampled peak free-space
use on the data and temporary filesystems for every trial. It records candidate,
image identity, host, SQLite options and mount/filesystem information. It fails
on **any** pause above **5.0 seconds**, without averaging. A breach prints
`DECISION REQUIRED` and must be resolved before shipping this approach.

The live-byte arm plants current and former profile/hash values, stored encrypted
connection envelopes and content. Former values must be found immediately after
change in the same open store, or fixture setup fails. All files under that scratch
store, including the database, WAL and shared-memory file, are searched before
closing the store. Other-account controls remain. A real outside reader must leave
cleanup unfinished; releasing it permits a retry on the same open store.

The container space arm uses a separate data volume and a 64 MiB tmpfs at
`/sqlite-vacuum-tmp`, selected by `SQLITE_TMPDIR`. Real written filler consumes
capacity until VACUUM returns `SQLITE_FULL`. The outside sampler must observe
SQLite's open `etilqs_` file on that mount. Removing the filler must permit a
same-open-store retry with intact metadata and a zero-length WAL. Normal container
measurements use a 2 GiB tmpfs at that path; both mount choices are explicit in
the evidence. Allow several GiB of scratch disk and about 2 GiB of spare memory.

Red controls exit nonzero. Run each with a new scratch directory:

```sh
for seed in row-only former-missing busy-success pause; do
  DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/compaction-red-XXXXXX") \
    node scripts/account-compaction-proof.mjs --port 3394 --seed "$seed"
done
for seed in row-only former-missing busy-success space-success pause; do
  DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/compaction-container-red-XXXXXX") \
    node scripts/account-compaction-proof.mjs --container "$IMAGE" --container-only \
      --port 3394 --seed "$seed"
done
```

`row-only` must fail the live-byte absence assertion; `former-missing` must fail
fixture setup; `busy-success` and `space-success` must fail the unfinished-result
assertion; `pause` must exceed the pause bound. Seeds affect only proof processes.
The green command is expected to take minutes, byte/reader reds seconds, and the
space red up to a few minutes including container setup. These are estimates until
observed on the candidate machine; each run prints its actual total duration.

Reports and worker/container logs remain in the supplied scratch directory.
Temporary containers and volumes are removed by the driver. The other erasure
stages, issued-copy lifetimes, retained-memory cleanup and physical disk remanence
are outside this proof. Row cleanup is tested separately against the independent
fixture ledger in the normal unit suite.

SQLite describes the temporary-copy/free-space requirements in its
[VACUUM reference](https://www.sqlite.org/lang_vacuum.html), and the result and
busy semantics in its [checkpoint reference](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint).
