# Request transport probe

Run the whole-body probe on a production standalone built in an isolated checkout,
with the native ingress preload and a fresh scratch store. The client must see the
same data directory and server log; it observes upload scratch growth while still
sending. Do not run it against a user's store. For example, from the isolated
build checkout (ports 3391 and 3392 must be free):

```sh
transport_data=$(mktemp -d "$PWD/.tmp-transport-XXXXXX")
DEZFIL_DATA_DIR="$transport_data" DEZFIL_UPLOAD_MAX_MB=257 HOSTNAME=127.0.0.1 PORT=3391 \
  node --import=./scripts/ingress-preload.mjs .next/standalone/server.js \
  > "$transport_data/server.log" 2>&1 &
transport_pid=$!
# Wait for GET http://127.0.0.1:3391/api/health to return 200.
DEZFIL_DATA_DIR="$transport_data" DEZFIL_UPLOAD_MAX_MB=257 \
  npm run probe:transport -- http://127.0.0.1:3391 --server-log "$transport_data/server.log"
kill "$transport_pid"
```

Repeat with a **new** scratch directory, `DEZFIL_UPLOAD_MAX_MB=1`, `PORT=3392`,
and the client command below to test the configured multipart file boundary:

```sh
DEZFIL_DATA_DIR="$transport_data" DEZFIL_UPLOAD_MAX_MB=1 \
  npm run probe:transport -- http://127.0.0.1:3392 --server-log "$transport_data/server.log" --file-limit-only
```

For the container, run each arm in a fresh container. The image job uses these
commands for the main arm, then repeats with port 3392, cap 1 and
`--file-limit-only`. The preload is the same as the image's default command;
redirection makes its log visible to the probe within the network namespace.

```sh
docker run -d --rm --name dezfil-transport --network=none \
  -e PORT=3391 -e DEZFIL_DATA_DIR=/data -e DEZFIL_UPLOAD_MAX_MB=257 \
  -v "$PWD/scripts:/probes:ro" dezfil:ci \
  sh -c 'exec node --import=./scripts/ingress-preload.mjs server.js > /data/transport-server.log 2>&1'
# Wait for health from inside this container.
docker exec dezfil-transport node /probes/transport-probe.mjs \
  http://127.0.0.1:3391 --server-log /data/transport-server.log
docker stop dezfil-transport
```

Green prints JSON with `"label": "confirmed"`, elapsed seconds, exact file sizes
and independently counted rows, growing scratch samples, workflow validation
answers, public refusal byte counts, and empty TRACE answers. Declared public
excess writes zero body bytes; a paced 4 MiB chunked sender must receive 413 by
81,920 bytes (65,536 plus fixed 16,384-byte scheduling slack). Red prints
`"label": "failed"` and the failing assertion, then exits 1. A missing response
times out. Missing rows, scratch growth only after sending, and any framework
truncation warning fail independently. The file-limit arm preserves the receiver's
existing boundary: one byte below the configured cap succeeds; exact and above
answer `upload_too_large` without a table or scratch file.

Run `npm run probe:gate -- http://127.0.0.1:3391` separately against another fresh
preloaded store for the unchanged complete native refusal matrix. These probes
assert behavior, not an RSS or latency improvement; compare the image job's total
duration separately when assessing its added cost.

## Provider cancellation and caller recovery

The [provider cancellation recipe](provider-cancel-probe.md) runs place search
and advisory custom-basemap checks against an owned held provider and a separate
production instance on port 3217. It includes route disconnects, queued and
pre-aborted calls, unchanged timeouts, completed-call controls, browser
supersession/departure and named defects with restoration instructions. Run it
outside environments that forbid listeners or browsers. It creates no container
or network and adds no image-job step; record its observations separately from
renderer proofs.

## Render destination gate and outside comparison

Run the [three-arm destination gate](render-egress-driver.md#image-job-step)
against the named built image. It runs both victim variants with three helpers,
two internal networks and no host ports, fails on missing evidence, and removes
its owned containers/networks on every ordinary exit. Expect about 30 added
image-job seconds against the outside 27–29 second measurements; record the
actual elapsed time. The same guide gives the wider dependency/compatibility
matrix, socket/lifetime proofs and cleanup recipes.

The [TLS and paired comparison guide](render-paired-driver.md) gives exact
host OpenSSL/NSS prerequisites and trust mounts, positive and negative certificate
arms, per-claim supplementary browser labels, two warmups then ten interleaved
exports per version, independent guarded tile counts, retained voids, medians,
delta/ratio and each named seed. Those probes stay outside CI. Do not interpret a
configuration flag or an unpaired baseline as a browser or performance result.

## Image job probe order

After building and recording the `dezfil:ci` image, the image job runs these
checks in order. The stock `dezfil-mcp-probe:ci` client image is built after the
inventory and render destination checks, before the SQL byte-budget probe; it
is a test client, not a shipped service.

| Order | Check | Containers required |
|---|---|---|
| 1 | `check-image-inventory.mjs` | Disposable `dezfil:ci` inspection containers. |
| 2 | `render-egress-driver.mjs --image dezfil:ci` | One app and three helpers using the built image, recreated per arm; two internal networks, unconditional owned cleanup. |
| 3 | `result-budget-image.sh dezfil:ci --quick` | Two fresh `dezfil-budget-small-<pid>` and `dezfil-budget-normal-<pid>` servers with 32 MiB and 512 MiB engine budgets, no source container or network; owned containers and anonymous volumes removed on exit. |
| 4 | `body-probe.mjs` (includes transport, 11/256 MiB uploads, 12 MiB workflow and paced public POSTs), then `transport-probe.mjs --file-limit-only` | Two fresh `dezfil-transport-ci` servers in sequence, 257 MiB then 1 MiB upload caps; stock MCP client beside the first server. |
| 5 | `publication-source-probe.mjs`: direct, trusted, untrusted, missing, without `--capacity` | Four fresh `dezfil-publication-ci` servers in sequence; only the trusted arm trusts loopback and only the missing arm omits ingress. |
| 6 | `derivation-probe.mjs` | One `dezfil-derivation-ci` server with trusted loopback and the test observer. |
| 7 | `credential-cleanup-driver.mjs` | Three replacement `dezfil:ci` servers over one fresh named volume, no sidecar. |
| 8 | `ingress-probe.mjs`, then `--expect-missing` | Two disposable `dezfil:ci` containers, with and without ingress preload. |
| 9 | `check-duckdb-extensions-offline.mjs` | One disposable `dezfil:ci` container without networking. |
| 10 | Thirty-second cold start, `journey.mjs`, then `durability.mjs seed` and `verify` | `dezfil-ci`, then its replacement on `dezfil-ci-data`. |
| 11 | `ownership-journey.mjs seed` and `verify` | Two successive `dezfil-ownership-ci` servers on their own volume, each driven by the stock MCP client. |
| 12 | `sharing-journey.mjs seed` and `verify` | Two successive `dezfil-sharing-ci` servers on their own volume, each driven by the stock MCP client and its scripted assistant wire. |
| 13 | `mcp-process-driver.mjs` | Two replacement `dezfil:ci` servers over a fresh volume plus stock MCP clients. |
| 14 | `dezfil-plugin-container.mjs` HTTP journey | One `dezfil-plugin-ci` server plus stock MCP client with mounted plugin files. Keep this server for the final check. |
| 15 | `offline-export-probe.mjs --tiled` | One `dezfil-offline` server without networking. |
| 16 | `offline-export-probe.mjs --expect-unavailable` | One `dezfil-nobrowser` server from the image with Chromium removed. |
| 17 | `dezfil-plugin-container.mjs --render --render-log ...` | The retained `dezfil-plugin-ci` server and a stock MCP client. |

The [account-deletion image journey](account-deletion-driver.md) also runs
after the account-journey cleanup and before MCP restart. Its guide is the canonical
checkout/image mirror and seeded-red recipe.

Cleanup steps stop remaining journey/plugin containers. The separate native gate,
account-upgrade, login-window and admin-recovery recipes remain outside this
image job; run them as described above when preparing a release.
