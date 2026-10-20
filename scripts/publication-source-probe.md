# Publication source and state probe

Use four fresh standalone processes or four sequential containers, one per arm:
`direct` on 3393, `trusted` on 3394, `untrusted` on 3395, and `missing` on 3396.
Every server uses `DEZFIL_DATA_DIR` pointing to its own empty scratch directory,
`DEZFIL_PUBLIC_RATE_LIMIT=4` and `DEZFIL_PUBLIC_TILE_RATE_LIMIT=2`. Only `trusted`
sets `DEZFIL_TRUSTED_PROXIES=127.0.0.1`; all other arms explicitly leave it empty.
These are controlled proxy requests over a real loopback socket. Direct traffic
binds the client's local address to 127.0.0.1 and 127.0.0.2; the workstation must
have both available. On macOS, the direct arm needs a loopback alias for
127.0.0.2 or must run in the container. Linux routes the whole loopback network;
the IPv4-only image uses these same two addresses.

Start the standalone from its isolated build directory (substitute the checkout's
absolute `scripts` path for `$PROBES` and a fresh directory for `$SCRATCH`):

```sh
PORT=3393 HOSTNAME=127.0.0.1 DEZFIL_DATA_DIR="$SCRATCH" DEZFIL_PUBLIC_RATE_LIMIT=4 DEZFIL_PUBLIC_TILE_RATE_LIMIT=2 DEZFIL_TRUSTED_PROXIES='' DEZFIL_TEST_PUBLICATION_LOG="$SCRATCH/publication.ndjson" node --import=./scripts/ingress-preload.mjs --import="$PROBES/publication-observer.mjs" server.js
```

For each other arm change the port, store and proxy setting above. `missing`
omits the ingress preload. The observer is test-process-only and records every
limiter insertion; it adds no diagnostic HTTP endpoint or production setting.
Against each already running standalone, run (change mode and port together):

```sh
DEZFIL_DATA_DIR="$SCRATCH" node "$PROBES/publication-source-probe.mjs" http://127.0.0.1:3393 direct --state-log "$SCRATCH/publication.ndjson"
```

On the fresh trusted standalone, explicitly include the served capacity proof:

```sh
DEZFIL_DATA_DIR="$SCRATCH" node "$PROBES/publication-source-probe.mjs" http://127.0.0.1:3394 trusted --state-log "$SCRATCH/publication.ndjson" --capacity
```

For a container, the direct arm is exactly:

```sh
docker run -d --rm --name dezfil-publication --network=none -e PORT=3393 -e DEZFIL_DATA_DIR=/data -e DEZFIL_PUBLIC_RATE_LIMIT=4 -e DEZFIL_PUBLIC_TILE_RATE_LIMIT=2 -e DEZFIL_TRUSTED_PROXIES='' -e DEZFIL_TEST_PUBLICATION_LOG=/data/publication.ndjson -v "$PWD/scripts:/probes:ro" dezfil:ci node --import=./scripts/ingress-preload.mjs --import=/probes/publication-observer.mjs server.js
docker exec dezfil-publication node /probes/publication-source-probe.mjs http://127.0.0.1:3393 direct --state-log /data/publication.ndjson
docker stop dezfil-publication
```

Repeat on fresh containers for `trusted`/3394 with proxies `127.0.0.1`,
`untrusted`/3395 with empty proxies, and `missing`/3396 with empty proxies and
no ingress preload. Four server containers total, no sidecars or published ports.
For the local trusted container, replace the probe command with:

```sh
docker exec dezfil-publication node /probes/publication-source-probe.mjs http://127.0.0.1:3394 trusted --state-log /data/publication.ndjson --capacity
```

The image job runs all four modes without `--capacity`: hosted runners cannot
fill the state inside one ten-second window. It proves direct/proxy source
separation and sharing, refusals, expiry and the missing-ingress answer, and
makes no capacity claim. The missing arm accepts an unready health response as
evidence that the deliberately unpreloaded server is listening.

Green exits zero with `label: confirmed` and per-arm check counts: independent
direct sockets, shared view budgets across valid/unknown tokens, separate tiles,
trusted-chain separation and mapped equivalence, untrusted sharing despite
forged headers, ten-second recovery and expiry on ordinary reads. The missing arm pins
the exact private 503 on all five operations, with and without forged provenance.
Red exits nonzero with `label: failed`: a shared direct key, accepted forged
provenance, changed refusal or absent expiry observation fails.

Only `trusted --capacity` sends the additional 10,050 distinct sources across
both buckets and asserts every observed size stays at most 10,000, reaches
10,000, and retains that size after further admissions. This requires 10,050
requests inside ten seconds, about 1,005 requests per second through the served
stack with the observer attached. `capacity arm never reached the bound; expiry
may have hidden eviction` means the probe did not fill the state before entries
could expire; it cannot prove eviction and fails. It is not a capacity pass on
a slower host. This explicit arm is the served proof of the bound on a machine
that can reach it. Without the flag, there are no capacity assertions or capacity
evidence. Deterministic unit tests with a controlled clock prove the exact bound,
expiry before eviction and renewal at capacity independently of host throughput.
`--capacity` is refused for other modes. No IPv6
rotation, throughput, latency or memory improvement is claimed.
