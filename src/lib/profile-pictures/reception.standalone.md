# Production picture reception check

| Probe | Port variable | Meaning |
|---|---|---|
| Picture reception | `DEZFIL_PICTURE_RECEPTION_PORT` | Test process only. Port of a running production standalone sharing its fresh scratch data directory with the test. Unset skips the matrix. |

Build the production standalone, copy its static assets and the native
packages its tracer leaves out (as the Dockerfile does), and start it with the
native ingress preload. Use a disposable directory whose name starts with
`dezfil-test-`. The fixture creates an admin credential in that directory and
sets that account's own picture. From the repository root, in one terminal:

```sh
export DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-picture-reception-XXXXXX)
npm run build
mkdir -p .next/standalone/.next
cp -R .next/static .next/standalone/.next/
cp -R public .next/standalone/
for pkg in @duckdb better-sqlite3 bindings file-uri-to-path sharp @img detect-libc semver; do
  rm -rf .next/standalone/node_modules/$pkg && cp -R node_modules/$pkg .next/standalone/node_modules/
done
PORT=3100 HOSTNAME=127.0.0.1 node --import=./scripts/ingress-preload.mjs .next/standalone/server.js
```

In another terminal, set `DEZFIL_DATA_DIR` to that same fresh path, then run:

```sh
DEZFIL_PICTURE_RECEPTION_PORT=3100 npx vitest run src/lib/profile-pictures/reception.standalone.test.ts
```

The six cases take about four minutes. A file of exactly 10 MB, sent in chunks
with no declared length, sets the picture and one byte more is refused with
nothing changed. A size refusal reaches a sender that stops sending within 5
seconds and its connection closes. A caller who leaves mid-body changes
nothing. First-byte and mid-body silence answer 408 `upload_stalled` within
65 seconds. A body still arriving at 120 seconds answers
`data_processing_timeout`. Each case asserts its status, code and timing, that
the picture stayed as it was, that no received file is left, and that the
next upload succeeds. Stop the server before removing its scratch directory.

For an exact failing seed, change `receiveMs: 120_000` to `receiveMs: 60_000`
in `src/lib/profile-pictures/limits.ts`, rebuild and restart with a fresh
directory, then run the matrix with `-t 'still arriving'`. The case must fail
its 119-second lower bound. Restore the constant and rebuild before
collecting passing results.
