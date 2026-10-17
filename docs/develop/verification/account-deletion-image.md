---
title: "Account deletion on the built application"
summary: "Proofs that account deletion erases rows, files and the store's free pages on the built application and in the container image."
read_when:
  - "you change account deletion and need the built-image evidence"
audience:
  - developer
checked: none
---

Run these from a built, detached linked candidate checkout outside the editing
environment, using its matching production standalone or image.
The probes use small disposable stores, own their processes, remove stores on
exit and retain server logs. The image arm uses only the built application image,
with no database image pull or browser. The inherited image-job steps keep their
order. The expected added image time is 1–3 minutes, excluding its build; measure
this outside and update the workflow comment from that observation.

These are the canonical checkout and image-job mirror invocations:

```sh
mkdir -p .claude/test-data
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/deletion-checkout-XXXXXX") node scripts/account-deletion-driver.mjs --standalone "$PWD/.next/standalone" --port 3403 --wire-port 3404
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/deletion-image-XXXXXX") sh scripts/account-deletion-image.sh dezfil:ci
```

Checkout mode owns loopback ports 3403 and 3404. Image mode uses those ports
inside an isolated container network namespace and publishes no host port. It
removes its container and named volume on success, failure and handled signals;
replacement waits for the old container name to disappear, using the same loop
as the other workflow journeys. Cleanup failure is a failed proof. Server logs
remain outside the erased store; the private fixture ledger and recovery link are
removed on exit. Neither mode accepts an existing populated scratch root.

Green exits zero and prints acceptance/page/checkpoint, four transport, live
completion, and recovery PASS lines, followed by elapsed seconds. It:

- Populates datasets, map/layer, workflow/step/run/output, project and connection
  ownership, with independently owned same-named data and connection controls.
- Finds current and changed-away profile/password values, credential hashes,
  stored connection bytes and owned content before deletion. Scans every live
  data-directory file, including database, WAL and shared memory, after completion
  while the server still holds its store open. Control sentinels and file hashes
  must survive. Opaque planted image/archive bytes test erasure, not rendering.
- Warms member workspace and anonymous viewer/embed pages, accepts through the
  session route while a process-wide fixture lease holds row cleanup, then proves
  all three pages refuse and contain no target material. Independent pages remain
  readable. The fixture asserts target rows still exist at this point, so row
  erasure cannot substitute for admission.
- Pins a real external SQLite read transaction, releases the lease, and requires
  `needs-retry` at the compaction stage. Evidenced foreign cards must already be
  removed. Replaces the process/container, finishes the same identifier with a
  token, and checks erasure, one dissolution revision, missing map/workflow inputs,
  unknown-table SQL and public-link loss. Other owners retain their definitions.
- Deletes through session, token, raw Streamable HTTP MCP and the scripted
  assistant. It checks real deleted identities and erased owned map rows, including
  assistant confirmation. No remote model is called. The inherited stock-client
  journeys remain separate transport evidence.
- Runs the packaged local recovery command in a terminal, redeems its link for
  the remaining admin, and keeps independent-owner reads working.

For row-erasure and foreign-card reds, seed one defect in the detached checkout,
rebuild that checkout and image, and rerun the two canonical invocations with new
scratch roots. Restore the printed file before each next seed and the final green:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/seed-XXXXXX") node scripts/seed-deletion-defect.mjs row-only
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/seed-XXXXXX") node scripts/seed-deletion-defect.mjs foreign-card
```

`row-only` omits VACUUM but keeps the real checkpoint, and must fail `live erased
sentinel remains` after continuation. `foreign-card` skips foreign input evidence
and must fail `recorded foreign card removed before restart`. The unit fixture's
same seed fails `recorded derivative or owned file remains`. Both probes take at
most the green journey's approximate time; neither changes the compaction proof.

The module-local admission protection is proven by the separate
[built-page proof and its seed](account-deletion-admission.md). Run both against
the same standalone; no changed product build is needed:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/deletion-pages-XXXXXX") node scripts/account-deletion-pages-proof.mjs --standalone "$PWD/.next/standalone" --port 3395
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/deletion-page-red-XXXXXX") node scripts/account-deletion-pages-proof.mjs --standalone "$PWD/.next/standalone" --port 3395 --seed module-local
```

The unseeded proof must exit zero; the seed must exit nonzero at
`accepted owner must be absent from built page`, usually within a minute.
Missing controls, packages, boot failure or timeout is a harness failure, never
the intended red.

The checkout driver and image journey no longer accept a module-local seed.
Their warm-up reads map identity, project standing and owner status before
deactivation. After acceptance, the first cleanup stage calls
`requireDeletingAccount` before waiting for the held work. Its
`SELECT status FROM accounts WHERE id = ?` is exactly the read used by page
admission, so the preload replaces the warm value with `deleting` before replay
starts. Replaying that value still refuses the page. Warming after deactivation
would not prevent that overwrite; replaying before acceptance would instead fail
the cleanup guard. The built-page proof changes status directly in its scratch
store and starts replay without the intervening cleanup read, so its seed retains
the pre-acceptance value and tests the intended page assertion.

The journey's filesystem handshake and injected lease are proof-only preloads;
no application endpoint exposes them. Before the first hold,
the journey runs a read-only query through the session API to load admission.
The control waits up
to five seconds for the application to create its process-wide admission holder;
it never creates that holder itself. A missing holder reports a bounded failure
to the journey, within its ten-second control deadline. Outside green and reds
are unconfirmed until actually observed. Keep the separate [restart boundary
proofs](account-deletion-admission.md), [operation/browser proofs](account-deletion-surfaces.md)
and [compaction measurements](account-compaction.md) in the wider mirror.
