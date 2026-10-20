# Account deletion operations and surfaces

Proofs over the deletion operations through session, token, MCP and the assistant, and over the Users screen that drives them.

These proofs use synthetic accounts in an isolated production build. Run them
from a built checkout outside the editing environment, observing each corrected
and seeded arm. A successful unit run is not evidence about these external arms.

In a detached scratch checkout at the candidate commit, install the lockfile
dependencies, set an empty scratch store, build, and copy the production assets:

```sh
export DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-build-XXXXXX")"
npm run build
cp -R .next/static .next/standalone/.next/static
cp -R public .next/standalone/public
```

The API proof owns its server on port 3397 and deterministic assistant wire on
3398, stops both on exit, and writes `server.log` under its scratch directory:

```sh
DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-parity-XXXXXX")" node scripts/account-deletion-parity-proof.mjs --standalone .next/standalone --port 3397 --wire-port 3398
```

Green exits zero with four `PASS: confirmed <road>` lines (session, token,
MCP, assistant) and the final production parity line. It checks preview privacy,
self/active/missing refusals, mistyped and stale confirmation, declined tool
confirmation, pending work, repeat identity, failed compaction, continuation,
completed-id absence, email/SQL-name reuse and an independent owner's survivor.
The test preload admits a held lease through a second source graph and forces
a compaction failure through the built-in filesystem, with no product endpoint.
Every deletion itself goes through the production HTTP route.

For each seed, restore the previous seed, apply one of the following in the
detached checkout, rebuild and recopy assets, then run the identical parity
command with a new scratch directory:

```sh
DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-seed-XXXXXX")" node scripts/seed-deletion-defect.mjs api-self
DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-seed-XXXXXX")" node scripts/seed-deletion-defect.mjs api-completion
DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-seed-XXXXXX")" node scripts/seed-deletion-defect.mjs api-confirmation
```

Red exits nonzero: `api-self` changes the self-refusal code;
`api-completion` falsely labels held work completed; `api-confirmation` removes
the tool confirmation, so the declined gate or assistant parking assertion fails.
Restore `src/lib/auth/account-deletion-eligibility.ts`,
`src/lib/auth/account-deletion-http.ts` or
`src/lib/api/openapi-user-deletion.ts`, respectively, before the next build.
An unobserved seed remains unconfirmed.

The Users browser journey owns no server. Start the proof host against that
same production standalone in one terminal, with a fresh empty scratch directory:

```sh
export DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-users-XXXXXX")"
node scripts/deletion-proof-host.mjs --standalone .next/standalone --port 3399
```

In the browser runner's terminal, use that exact scratch directory (the READY
line also prints the control directory). The normal browser setup creates and
signs in its synthetic administrator through the real account routes:

```sh
DEZFIL_DATA_DIR="$SCRATCH" DEZFIL_PROOF_CONTROL_DIR="$SCRATCH/control" DEZFIL_BASE_URL=http://127.0.0.1:3399 npx playwright test e2e/account-deletion.spec.ts
```

Here `$SCRATCH` is the absolute directory from the host's terminal. Green is
three passing journeys and the counts/email, invitation, empty, completed and
unfinished screenshots in `test-results`. The journeys check actual Users
rows, separate deactivation of an admin, self-row controls, private counts,
exact-email arming, Cancel/Escape focus restoration, Tab containment, stale
preview refusal and retyping, pending status, failure after acceptance, reload,
and both Finish deleting entrances. Only the test preload holds work and fails
compaction; preview, deletion, listing and continuation use the real routes.
No response is mocked. A pending response is never asserted to be completion.

For seeded browser reds, stop the host, apply one seed below in the detached
checkout, rebuild and recopy assets, restart with a fresh scratch directory,
and run the identical browser command. Each must fail, not skip:

```sh
DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-seed-XXXXXX")" node scripts/seed-deletion-defect.mjs ui-placement
DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-seed-XXXXXX")" node scripts/seed-deletion-defect.mjs ui-arming
DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-seed-XXXXXX")" node scripts/seed-deletion-defect.mjs ui-completion
DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-seed-XXXXXX")" node scripts/seed-deletion-defect.mjs ui-focus
```

Restore each named file before the next seed: `UserRow.tsx` for placement,
`DeleteAccountDialog.tsx` for arming, `UsersScreen.tsx` for completion/focus,
all under `src/components/users`. Expected failures are respectively Delete on
an active row, enabled Delete for an empty/wrong email, a completed notice while
work is held, and focus missing from Search users after confirmation closes.
These four defects also have observed unit reds, including an inertness check
for focus. A browser result counts only from an observed run. Stop the host and
remove the scratch directory after retaining its log; each fixture is small and
needs no retained database.

The attribution journey uses the same host, environment and port:

```sh
DEZFIL_DATA_DIR="$SCRATCH" DEZFIL_PROOF_CONTROL_DIR="$SCRATCH/control" DEZFIL_BASE_URL=http://127.0.0.1:3399 npx playwright test e2e/deleted-attribution.spec.ts
```

Green is one passing journey with screenshots of map/workflow cards, both
history hints and workflow heads/runs. The fixture creates a surviving owner,
a departing editor and a named editor through the API. It records real edits
and runs, deletes the departing editor through the real confirmation route,
then checks retained times/revisions, italic deleted/Unknown facts, plain run
labels, and the absence of erased display/SQL names in tooltips. The scratch
preload alone supplies legacy Unknown attribution; it restores the run's
immutability trigger in the same transaction and changes no times. All reads
and history presses use production pages/routes. It adds no product endpoint.

Use the same detached-checkout seed/rebuild/restart procedure for these reds:

```sh
DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-seed-XXXXXX")" node scripts/seed-deletion-defect.mjs actor-unknown
DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-seed-XXXXXX")" node scripts/seed-deletion-defect.mjs actor-tooltip
DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-seed-XXXXXX")" node scripts/seed-deletion-defect.mjs actor-run-tooltip
DEZFIL_DATA_DIR="$(mktemp -d "$PWD/.proof-seed-XXXXXX")" node scripts/seed-deletion-defect.mjs actor-redo
```

Expected failures: the deleted card says Unknown; its title names an erased
profile/SQL name; a run has an erased-profile title; Redo omits its original
author. Restore `src/components/sharing/LastChanged.tsx` for the first two,
`src/components/sharing/RunInitiator.tsx` for the third, and
`src/components/builder/shared-history.ts` for the fourth before rebuilding.
All four must exit nonzero. Unit reds do not substitute for observing these
browser failures; record results and screenshots only from observed browser runs.
