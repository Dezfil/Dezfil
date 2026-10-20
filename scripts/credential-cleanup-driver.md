# Credential cleanup and restart probe

Run from the checkout against an already built isolated standalone, with its
native dependencies and ingress preload present. The driver owns port 3398;
choose another unused port with `--port` if needed. Never use the operator's
store or its development build. Each invocation requires an empty, absolute
scratch `DEZFIL_DATA_DIR` and creates no production setting:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/cleanup-XXXXXX") node scripts/credential-cleanup-driver.mjs --standalone /absolute/isolated-build/.next/standalone --port 3398
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/cleanup-XXXXXX") node scripts/credential-cleanup-driver.mjs --container dezfil:ci --port 3398
```

The container command is the image job's command. It needs the built `dezfil:ci`
image and Docker, no client image or sidecar. It creates one fresh named volume
and three successive server containers, each with `--network=none`,
`DEZFIL_DATA_DIR=/data`, `PORT=3398` and empty `DEZFIL_TRUSTED_PROXIES`. Clients
run inside each server's namespace with `docker exec`. The standalone likewise
uses three replacement processes over the same scratch store. The driver removes
its containers and volume even after failure; it leaves `cleanup-evidence.json`
and `cleanup-server.log` in the host scratch directory. Standalone mode also
leaves the isolated fixture store and its private credential manifest there.

The first launch provisions the fixture through HTTP, counts six repeated
sign-ins, and seeds 1,201 expired rows per credential kind alongside live and
retained controls. The second launch snapshots rows before credential traffic:
boot must remove between one and 500 old rows per kind. Continued cookie/token
access must drain the rest without an hourly wait. Every retained row survives,
recent revoked-token history stays visible, removed identifiers answer with the
exact unknown-token refusal, and live ordinary/recovery links redeem. Eleven
more old rows per kind are seeded for the third launch, which proves cleanup
runs again after replacement and live and redeemed credentials still work.

Green exits zero with `label: confirmed`, three launches, per-phase row counts
and checks. Red exits nonzero with `label: failed`: absent cleanup, a batch above
500 deletions, premature removal, stale history, changed refusals, failed live
use or a reused process/container identity fails. Unit fixtures seed missing
cleanup and premature removal independently and run the same probe through real
handlers. Those units do not establish socket, packaged boot or image behavior;
the driver does. Exact retention boundaries, 500 examined rows (including
live rows), hourly cadence and renewal races remain deterministic unit proofs.
