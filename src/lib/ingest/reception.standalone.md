# Production upload reception check

| Probe | Port variable | Meaning |
|---|---|---|
| Upload reception | `DEZFIL_UPLOAD_RECEPTION_PORT` | Test process only. Port of a running production standalone sharing its fresh scratch data directory with the test. Unset skips the matrix. |

Build the production standalone, copy its static assets, and start it with the
native ingress preload. Use a disposable directory, with no upload-size or
processing-time environment override: the tests change those settings through
the authenticated API. The fixture creates an admin credential in that directory.
From the repository root, in one terminal:

```sh
export DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-upload-reception-XXXXXX)
npm run build
mkdir -p .next/standalone/.next
cp -R .next/static .next/standalone/.next/
cp -R public .next/standalone/
PORT=3100 HOSTNAME=127.0.0.1 node --import=./scripts/ingress-preload.mjs .next/standalone/server.js
```

In another terminal, set `DEZFIL_DATA_DIR` to that same fresh path, then run:

```sh
DEZFIL_UPLOAD_RECEPTION_PORT=3100 npx vitest run src/lib/ingest/reception.standalone.test.ts
```

The six cases take about eleven minutes: a 22 MiB CSV over 350 seconds succeeds
with every row while an ordinary request times out at 300 seconds; first-byte
and mid-body silence answer within 65 seconds; a size refusal reaches a silent
sender within 60 seconds; continuous progress reaches its admitted deadline;
and a 120-second admission survives a change to 60 seconds, followed by reuse of
the completed connection. Each test asserts its status, code and timing bounds,
partial-file cleanup and recovery where applicable. Stop the server before
removing its scratch directory.

For an exact failing seed, change `UPLOAD_STALL_MS = 60_000` to
`UPLOAD_STALL_MS = 120_000` in `src/lib/auth/reception.mjs`, rebuild and restart
with a fresh directory, then run the matrix with `-t 'first-byte or mid-body'`.
Both silence cases must fail their 65-second response guard. Restore the constant
and rebuild before collecting passing results.

The browser refusal surface is covered separately by
`npx playwright test e2e/upload-refusal.spec.ts` on a provisioned instance. It
injects the three typed application refusals and then performs a real recovery
upload. The native matrix establishes the corresponding server behavior.
