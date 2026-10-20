# Production abandonment check

| Probe | Variable | Meaning |
|---|---|---|
| Abandonment | `DEZFIL_ABANDONMENT_PORT` | Test process only. Port of a running production standalone sharing its fresh scratch data directory with the test. Unset skips the check. |
| Abandonment | `DEZFIL_ABANDONMENT_LOG` | Test process only. The file the standalone writes its output to. Each case reads what it added. |

Build and copy the standalone as for the upload reception check, then start it
with the unexpected-error control preload as well, writing its output to a file:

```sh
export DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-abandonment-XXXXXX)
PORT=3101 HOSTNAME=127.0.0.1 node --import=./scripts/ingress-preload.mjs \
  --import=./scripts/abandonment-control.mjs .next/standalone/server.js > "$DEZFIL_DATA_DIR.log" 2>&1
```

In another terminal, with `DEZFIL_DATA_DIR` set to that same fresh path:

```sh
DEZFIL_ABANDONMENT_PORT=3101 DEZFIL_ABANDONMENT_LOG="$DEZFIL_DATA_DIR.log" \
  npx vitest run src/lib/auth/abandonment.standalone.test.ts
```

The five cases take about twenty seconds. In three of them, one connection that
never reads asks for answers far larger than its socket can buffer, then sends
a request the proxy refuses itself (a POST, PATCH or DELETE without
credentials), and leaves before that refusal finishes. In the fourth, a caller
leaves in the middle of a request body; the framework logs that departure once
as a handled `Error: aborted`. None of the four may add an `uncaughtException:`
or `unhandledRejection:` line, and a readiness check and an authenticated list
must both answer within 5 seconds afterwards. The fifth is the control: after
its caller leaves, the preload reports a failure that is not a departure on a
marked request, and that failure must appear once as `uncaughtException:`, with
no departure beside it. Stop the server before removing its scratch directory
and output file.

For an exact failing seed, delete the `request.on("error", departed)` call in
`src/lib/auth/reception.mjs` and restart the server: the three refusal cases
fail with `uncaughtException: Error: aborted`, and the control fails with that
departure beside its own failure. Restore the call and restart before collecting
passing results.
