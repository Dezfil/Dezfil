# Accepted deletion admission proofs

Run these only outside the implementing sandbox, from a detached candidate
checkout after its production build. Every command supplies a new empty scratch
store. No deletion operation is exposed by these proofs.

```sh
mkdir -p .claude/test-data
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/pages-XXXXXX") \
  node scripts/account-deletion-pages-proof.mjs --standalone "$PWD/.next/standalone" --port 3395
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/pages-red-XXXXXX") \
  node scripts/account-deletion-pages-proof.mjs --standalone "$PWD/.next/standalone" --port 3395 --seed module-local
```

The driver starts `server.js` **inside the standalone folder**. This matters:
the seed preload must wrap the same native SQLite module the server uses. It
warms a member's workspace page and anonymous published/embedded pages, changes
only its scratch target to deleting, then requests all pages again. Independent
owner pages remain readable. Green prints `PASS: confirmed built workspace...`.
The seeded module cache replays pre-acceptance metadata reads in the server and
must fail `accepted owner must be absent from built page`. This seed is separate
from row-only erasure. Both runs should take under a minute after the build;
actual elapsed time is printed. The server is stopped and its log retained in
the scratch directory on success or failure.

Socket-free tests separately hold native evaluation and anonymous assembly
across acceptance, require one earlier completion, refuse fresh/cached admission,
and require the account drain to wait for the actual read end. A page proof does
not measure stream drainage or byte erasure.

## Restart and continuation

This earlier restart proof injects the coordinator through parent/child IPC in a production standalone;
production startup and HTTP admission use the built bundles.
The [operation proof](account-deletion-surfaces.md) separately drives the now-public
confirmation and continuation routes. The proof-only source
loader loads the checkout's matching coordinator revision and resolves native
packages from the standalone's module tree. It starts `server.js` **inside the
standalone folder**. Use a standalone built from this exact checkout revision.

```sh
mkdir -p .claude/test-data
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/restart-XXXXXX") \
  node scripts/account-deletion-restart-proof.mjs --standalone "$PWD/.next/standalone" --port 3396
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/restart-red-XXXXXX") \
  node scripts/account-deletion-restart-proof.mjs --standalone "$PWD/.next/standalone" --port 3396 --seed lost-journal
```

Allow about two minutes for five fresh-store arms and ten standalone boots.
Each arm kills with SIGKILL after acceptance, row/dissolution cleanup, file
cleanup, before compaction, or after compaction before journal removal. Before
calling any coordinator code after restart, the parent checks that production
startup retained the same journal identifier and made it `needs-retry`. It then
checks public refusal and an independent owner's live HTTP read, finishes the same
identifier through private IPC, and checks that surviving document revisions were
not advanced twice. Green is five named PASS lines and exit 0. The seeded run
removes journals before startup and must exit 1 at `restart retains the accepted
deletion identifier`. A readiness or loader failure is a harness failure, not a
successful red. All exits stop the child; server logs stay in the scratch folder.
The proof is authored here; its HTTP/process observations require an outside run.
