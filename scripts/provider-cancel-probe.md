# Provider cancellation probes

Probes that place search and basemap inspection stop their outbound calls when the caller leaves or replaces the request.

Place search carries its caller's abort signal through the shared geocoder
capacity wait and the whole outbound exchange. The advisory custom-basemap
inspection carries the signal through its exchange. A new independent request
does not cancel another one: cancellation starts when that request's client
departs. The builder aborts submitted searches on supersession/departure and
advisory inspections on replacement, URL edit, Cancel and unmount. Sequence
fences still discard late answers and keep abort errors out of current UI.

Completed answers, attribution, inspection verdicts and authoritative
save/force-save decisions keep their existing contract. Search still shares
one paced slot with batch geocoding, held until its exchange finishes. Its
one-million-byte cap and configurable ten-second default exchange timeout
remain; inspection retains its two-MiB cap and eight-second deadline. Both use
the outbound engine's five-redirect limit and egress policy. An advisory
abort does not cancel a save or another consumer's work. No response field,
error code, production setting or generated tool changes.

These proofs are independent of image rendering and can be reviewed and run
without renderer changes. The recipes below specify required observations;
their existence alone does not establish socket or browser behavior.

## Production routes

Run against an isolated **production** instance, started separately. The probe
owns a real HTTP provider on `127.0.0.1:4319`; the app and probe must share the
host network namespace. No containers or networks are created by the probe.
Use the existing settings when starting the instance on port 3217:

```sh
DEZFIL_DATA_DIR="$(mktemp -d /tmp/dezfil-test-XXXXXX)" \
DEZFIL_GEOCODER_URL=http://127.0.0.1:4319 \
DEZFIL_EGRESS_ALLOWLIST=127.0.0.1 \
DEZFIL_GEOCODE_PACE_MS=100 \
DEZFIL_GEOCODE_REQUEST_TIMEOUT_S=30 \
npm start -- --hostname 127.0.0.1 --port 3217 > provider-server.log 2>&1
```

Build before starting, in the environment permitted to build. Run the exact same
probe against the baseline build and repaired build:

```sh
DEZFIL_DATA_DIR="$(mktemp -d /tmp/dezfil-test-XXXXXX)" \
node scripts/provider-cancel-probe.mjs http://127.0.0.1:3217 4319 30000
```

The arguments are app origin, provider port and expected search timeout in
milliseconds. Changing the port requires changing the instance's geocoder URL.
The inspection timeout is always eight seconds; neither timeout is shortened
to simulate cancellation. To check search's ten-second default separately,
restart without `DEZFIL_GEOCODE_REQUEST_TIMEOUT_S` and pass `10000`.

The journey helper provisions its synthetic account and API token. Use a fresh
store or one already provisioned with the same journey account. The probe
removes its map, revokes its token and closes its listener and sockets in
`finally`; the synthetic account remains in the disposable store. The caller
owns the app process, its store and captured logs.

Each search/inspection arm holds before headers, during a partial body, or at
the destination of a redirect whose body also stays unfinished. The probe
waits for provider contact, destroys the real client connection, and measures
provider socket closure within 1,000 ms, before cleanup. JSON lines retain
arrival, departure, closure and cleanup times. All six baseline arms must
individually fail that bound; a missing provider observation is a harness
failure, not the intended red. The repaired run must exit zero. Each abort and
timeout has a normal recovery request. A separate queued request must never
contact the provider, including after the held predecessor releases capacity.
A newer independent request alone must leave that predecessor running.

The full run takes roughly two minutes with a 30-second search timeout, plus
pacing and baseline failure windows. It also checks all six holds without
aborting: configured search deadlines and eight-second inspection deadlines
must produce the unchanged failed/unreachable answers and close sockets.

Retain built-server stderr separately. The known framework
`uncaughtException: Error: aborted` on client departure belongs to response
abandonment and is not a failure of this probe. Do not suppress or exempt
unhandled provider promise rejections. The probe does not change framework
response handling.

## Pre-aborted provider seams and completed-call controls

Outside a sandbox that forbids listeners, run:

```sh
DEZFIL_DATA_DIR="$(mktemp -d /tmp/dezfil-test-XXXXXX)" npm test -- \
  src/lib/net/provider-cancel.test.ts \
  src/lib/search/provider.test.ts src/lib/search/provider-signal.test.ts \
  src/lib/net/inspect-style.test.ts src/lib/basemap-custom.test.ts \
  src/lib/geocode/limiter.test.ts src/lib/geocode/provider.test.ts \
  src/lib/geocode/batch.test.ts src/lib/net/remote-fetch.test.ts \
  src/lib/net/remote-fetch-lifetime.test.ts
```

No app process is needed for these files. Their real fixtures bind ephemeral
ports and close their listeners in teardown; they create no containers or
networks. Each pre-aborted seam must record **zero connections and zero
requests**, then a normal call must contact the same live listener and return
the expected answer. This liveness control prevents an unreachable fixture
from supplying a false green. The other files cover normalization, credits,
verdicts, saves, body and redirect limits, shared pacing and batch consumers.
The mocked exchange tests establish signal/budget plumbing and capacity
release in code; they make no socket-closure claim.

## Browser callers

Use the production instance above and an installed Playwright Chromium. Run
after the route probe has released port 4319, not concurrently. The default
browser configuration excludes this separately provisioned journey:

```sh
DEZFIL_DATA_DIR="$(mktemp -d /tmp/dezfil-test-XXXXXX)" \
DEZFIL_BASE_URL=http://127.0.0.1:3217 \
npx playwright test --config=playwright.provider.config.ts
```

This journey provisions its own synthetic account session, token and map. It
owns the held provider on `127.0.0.1:4319`, and uses real search and inspection
routes; only basemap imagery is stubbed. Search supersession and departure,
and inspection replacement, edit, Cancel and panel departure must each emit
a cancelled browser request and close the held provider socket within
1,000 ms of the observed browser departure, before teardown. A replacement
check must remain pending after its predecessor aborts. Subsequent normal
searches and checks must succeed, with no stale error or old URL's save
action. The `provider-closure` attachment retains provider timing rows.

Green is a zero exit with all caller assertions and no page errors. A missing
provider arrival, absent browser abort, late closure, teardown-supplied closure
or stale UI is red. The journey closes provider sockets/listener, deletes its
map and revokes its token in `finally`. The synthetic account/session remains
in the disposable app store. It creates no containers or networks. Retained
failure traces/screenshots live in Playwright's `test-results` directory. The
operator owns the app process, scratch stores and logs and removes them after
recording evidence. Allow about a minute for this separate browser proof;
measure actual duration in the outside run. No pipeline step is added.

## Named defects and restoration

Use only a disposable checkout with no concurrent writer. The seed runner
changes one source file, runs its assertions and restores the original in
`finally`. A zero exit from the runner means an assertion red was observed
and the file restored; a killed process, import error or listener failure
does not count. Save its output and inspect the failing assertion.

```sh
DEZFIL_DATA_DIR="$(mktemp -d /tmp/dezfil-test-XXXXXX)" \
node scripts/provider-cancel-seeds.mjs sequence-only
```

Replace `sequence-only` with the name in the table. Without an option the
runner uses local tests; the explicitly marked rows require `--socket`:

| Seed | Required failing observation |
|---|---|
| `search-signal`, `inspect-signal` | Missing caller signal at capacity/exchange. Also run each with `--socket`: its pre-aborted seam opens a real provider connection. |
| `search-route-signal`, `inspect-route-signal` | The route omits its request signal. After `--prepare` and an outside rebuild, the corresponding production route holds fail the 1,000 ms bound. |
| `sequence-only` | Basemap invalidation keeps only sequencing; replacement, edit, Cancel and unmount no longer abort the request. |
| `search-caller-no-abort` | Search typing, resubmission and unmount no longer abort. |
| `search-sequence`, `style-sequence` | A late answer/error replaces current state or clears a replacement's pending state. |
| `capacity-release` | Completed/cancelled exchange fails to release its slot. |
| `search-timeout`, `style-timeout` | The exchange gets a shortened budget. With an outside rebuild, the production no-abort holds end too soon. |
| `search-byte-cap`, `style-byte-cap` | An over-limit body is accepted instead of the literal documented refusal. |
| `search-attribution`, `style-verdict` | Completed answers lose their expected credit or style name. |
| `force-save`, `save-attribution` | Unforced warning is accepted or a valid save loses its source credit. |
| `redirect-limit` (`--socket`) | The sixth redirect is followed, changing the observed hop count. |
| `search-pacing` (`--socket`) | Search bypasses the shared slot and violates the provider-observed interval. |

For example, the pre-abort and retained redirect/pacing seeds run as:

```sh
DEZFIL_DATA_DIR="$(mktemp -d /tmp/dezfil-test-XXXXXX)" node scripts/provider-cancel-seeds.mjs search-signal --socket
DEZFIL_DATA_DIR="$(mktemp -d /tmp/dezfil-test-XXXXXX)" node scripts/provider-cancel-seeds.mjs inspect-signal --socket
DEZFIL_DATA_DIR="$(mktemp -d /tmp/dezfil-test-XXXXXX)" node scripts/provider-cancel-seeds.mjs redirect-limit --socket
DEZFIL_DATA_DIR="$(mktemp -d /tmp/dezfil-test-XXXXXX)" node scripts/provider-cancel-seeds.mjs search-pacing --socket
```

To prove the real caller observers detect absent aborts, prepare each of
`sequence-only` and `search-caller-no-abort` separately:

```sh
DEZFIL_DATA_DIR="$(mktemp -d /tmp/dezfil-test-XXXXXX)" \
node scripts/provider-cancel-seeds.mjs sequence-only --prepare
```

`--prepare` does **not** run a test or restore automatically. It prints the
exact `cp` restoration command and stores the original under
`.claude/scratch/provider-seed-*/original`. Record that command before the
outside rebuild/restart, run the browser command above and require a red
caller observation, then execute the printed restoration command even if the
proof fails unexpectedly. Rebuild/restart the restored source and require
green. Use the same process for the route-signal and timeout seeds with the
route probe. Never commit a prepared seed or test a stale build.

## Retaining evidence

Retain the baseline and candidate commits, app/runtime/browser versions,
instance environment, commands and raw output. Record all six route arms
separately, queue cancellation and independence, both pre-aborted seams,
no-abort default/configured timeouts, recovery calls, caller flows, retained
contracts and each seed. Keep server stderr beside the probe output, including
the attributed framework abandonment lines; any unhandled provider rejection
remains a failure. The route test separately forces value search to exit
first and asserts that the concurrent provider rejection already has a handler.

Use **confirmed** only for observations actually run; code-only signal and
sequence checks are **confirmed mechanism, unmeasured impact** for socket
lifetime. Leave the 1,000 ms bound and browser flows explicitly **not run**
until the outside run has exercised them. Validating provider cancellation on
its own requires the checks and complete proof described here. Renderer results
cannot establish provider behavior; provider failures must be resolved separately.
