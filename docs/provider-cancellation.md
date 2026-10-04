# Provider cancellation probes

Run against an isolated **production** instance, started separately. The probe
owns a real HTTP provider on `127.0.0.1:4319`; the app and probe must share the
host network namespace. No containers or networks are created by the probe.
Use the existing settings when starting the instance on port 3217:

```sh
DEZFIL_DATA_DIR="$(mktemp -d /tmp/dezfil-provider-app-XXXXXX)" \
DEZFIL_GEOCODER_URL=http://127.0.0.1:4319 \
DEZFIL_EGRESS_ALLOWLIST=127.0.0.1 \
DEZFIL_GEOCODE_PACE_MS=100 \
DEZFIL_GEOCODE_REQUEST_TIMEOUT_S=30 \
npm start -- --hostname 127.0.0.1 --port 3217
```

Build before starting, in the environment permitted to build. Run the exact same
probe against the baseline build and repaired build:

```sh
DEZFIL_DATA_DIR="$(mktemp -d /tmp/dezfil-provider-probe-XXXXXX)" \
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
