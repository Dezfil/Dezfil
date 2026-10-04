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
