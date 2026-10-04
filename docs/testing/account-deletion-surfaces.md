# Account deletion operations and surfaces

These proofs use synthetic accounts in an isolated production build. The
implementing sandbox does not run a server, browser or build; the supervising
session observes each corrected and seeded arm. A successful unit run is not
evidence about these external arms.

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
