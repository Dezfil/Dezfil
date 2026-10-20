# Derivation admission and timing probe

Use one fresh production standalone or one fresh container on port 3397. Set
`DEZFIL_TRUSTED_PROXIES=127.0.0.1` for this isolated test instance: the probe
sends distinct controlled forwarded sources over loopback, so the twenty-attempt
source budget cannot masquerade as derivation capacity. Do not disable login
limits, change work factors or increase admission capacity. The only observer
setting below belongs to the test preload, not to the production configuration.

Start from the isolated standalone directory, with `$PROBES` the checkout's
absolute `scripts` directory and `$SCRATCH` a fresh data directory:

```sh
PORT=3397 HOSTNAME=127.0.0.1 DEZFIL_DATA_DIR="$SCRATCH" DEZFIL_TRUSTED_PROXIES=127.0.0.1 DEZFIL_TEST_DERIVATION_LOG="$SCRATCH/derivations.ndjson" node --import=./scripts/ingress-preload.mjs --import="$PROBES/derivation-observer.mjs" server.js
```

From the checkout, against that running standalone:

```sh
DEZFIL_DATA_DIR="$SCRATCH" node scripts/derivation-probe.mjs http://127.0.0.1:3397 --state-log "$SCRATCH/derivations.ndjson"
```

The server's standalone tree needs the packaged `src/lib/auth/ingress.mjs` and
preload scripts, as in the transport recipe. The client uses the checkout's
recovery implementation; the container client uses the packaged implementation.
For the image, one server container and no sidecar or published port:

```sh
docker run -d --rm --name dezfil-derivation --network=none -e PORT=3397 -e DEZFIL_DATA_DIR=/data -e DEZFIL_TRUSTED_PROXIES=127.0.0.1 -e DEZFIL_TEST_DERIVATION_LOG=/data/derivations.ndjson -v "$PWD/scripts:/probes:ro" dezfil:ci node --import=./scripts/ingress-preload.mjs --import=/probes/derivation-observer.mjs server.js
docker exec dezfil-derivation node /probes/derivation-probe.mjs http://127.0.0.1:3397 --state-log /data/derivations.ndjson
docker stop dezfil-derivation
```

Green exits zero with `label: confirmed`, measured single and paired native
scrypt durations, observed peaks, busy count, and successful post-drain retries.
It covers setup contention, known and dummy sign-ins, signed-in checks, link
redemption, both password-change derivations and packaged recovery redemption.
The assertions require at most two actual native jobs, at most one protected
active job, at most six ordinary and two protected waiters, exact private busy
answers, and recovery after drain. Saturation never asserts an exact served
count. Busy sign-ins retry from their original sources without a fifteen-minute
wait; busy links remain redeemable. The observer wraps native callbacks and
records shared queue state; it neither holds work nor adds a production endpoint.

The timing report compares three ordinary queue waves and up to six waves under
protected competition against the five-second waiting deadline. Those wave
figures extrapolate the measured paired duration; they are not measured queue
latency or a promise that all waiters succeed on slower hosts. The isolated
`derivation-timing.test.ts` records local native timing in its scratch directory
when run alone; full-suite timings include contention from other tests.

Red exits nonzero with `label: failed` for a cross-route admission bypass, excess
native or protected concurrency, queue overflow, a missing or malformed busy
answer, login-limit interference, missing observations, or failed recovery.
The route-level probe test substitutes short native work and transport; it
confirms fixture and assertion coverage, not delivery or performance. Measure
these five additional server runs (four publication arms plus this arm) with the
existing 256 MiB and body probes when recording the image job's added minutes.
The earlier roughly six-minute image duration is a historical reference; no
candidate image duration is inferred from unit runs.
