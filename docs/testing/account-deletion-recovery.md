# Upgrade and recovery after deleting the original account

Run outside the editing environment, from a built, detached linked candidate
checkout with the locked dependencies. Container arms use an image built from that
same candidate. Never use a live store. Each invocation below gets a fresh scratch
root; the probes own and remove their stores, servers and containers. The upgrade
probe retains only its evidence and server log under the printed directory.

```sh
mkdir -p .claude/test-data
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/upgrade-checkout-XXXXXX") node scripts/account-upgrade-proof.mjs --port 3389
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/upgrade-image-XXXXXX") node scripts/account-upgrade-proof.mjs --container dezfil:ci --port 3389
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/recovery-checkout-XXXXXX") node scripts/admin-recovery-probe.mjs checkout
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/recovery-image-XXXXXX") node scripts/admin-recovery-probe.mjs container dezfil:ci
```

The upgrade arms use port 3389 and take roughly 1–3 minutes each. They copy a
pre-account store, adopt it, preserve every legacy row and artifact, restart and
run its workflow, then transfer its map and workflow before deleting the original
account. After another restart, setup must stay closed, adoption and SQL homes
must remain fixed, and the matching local recovery command must issue a link that
redeems for the remaining admin. A separate scratch restoration checks the old
schema, every fixture file hash and the encryption key. Green exits zero with the
original-profile preservation line and the final `result: confirmed` JSON. The
pre-account source is never opened by the new application.
Container-mode metadata checks take a fresh SQLite backup through `docker exec`
at each checkpoint, then inspect that closed copy on the host. The host never
opens the container's live SQLite store across its bind mount. Preservation,
credential and retained-identity assertions run against each snapshot unchanged.

The recovery arms allocate their own loopback port (never 3000), typically taking
30–90 seconds each. They delete the original profile before testing live issuance,
single use, old credential refusal, stopped issuance and redemption after restart.
Container mode exercises the packaged command both with `docker exec -t` and in a
one-off container over the same volume. Green is `PASS: <mode> admin recovery` and
a check count. No browser is launched by either of these modes. The transferred
map/workflow homes and remaining owner's identity are checked again after recovery.

For red-first controls, apply one seed at a time in that detached checkout,
rebuild the checkout and image, and repeat the four invocations above with fresh
scratch roots. Restore the printed file before the next seed or final green:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/seed-XXXXXX") node scripts/seed-deletion-defect.mjs original-setup
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/seed-XXXXXX") node scripts/seed-deletion-defect.mjs original-recovery
```

`original-setup` must fail `original-profile deletion must not reopen setup`
(the recovery probe reports its `original-profile deletion` stage).
`original-recovery` must fail `matching recovery command issues exactly one link`
in upgrade, and `live issuance` in the recovery probe. These remove acceptance of
the retained original identity in the real setup/recovery reader; they do not
change the expected answer. A startup, package or transport failure is not that red.
The socket-free deletion/recovery process test has the same two seeded controls.

Keep the separate [workflow restart journey](../runbook.md#driving-the-api-without-a-browser)
and the [identity migration and rollback proof](../runbook.md#retained-account-identity-upgrade).
They cover different boundaries and are not replaced by account deletion.
Outside arms remain unconfirmed until their green and named reds are observed.
