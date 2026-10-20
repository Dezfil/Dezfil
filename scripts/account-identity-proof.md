# Retained account identity upgrade proof

From a detached, built evidence checkout, with another built checkout at the
pre-feature commit, run on an owned port:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/identity-command-XXXXXX") \
  node scripts/account-identity-proof.mjs --old-root /path/to/built-old-checkout --port 3391
```

The proof creates its own populated old store and backup, upgrades a copy, compares
all rows and every schema entry except the accounts table byte for byte, reopens,
then runs real old-application reads and writes against the migrated copy. It runs
the matching `admin:recover` command in a terminal, redeems the link, and restores
the complete backup into another scratch directory for an old-application read.
The proof allocates that terminal with BSD or util-linux `script` and null input,
so its caller can be non-interactive on macOS or Linux. The recovery command's
terminal-only disclosure rule still applies.
Green ends with `PASS: identity upgrade, compatibility, recovery and restore`.
Each `--seed row|home|trigger|reservation|foreign-key|writer|recovery` invocation
must fail at its named preservation, write or recovery assertion. No seed touches
an operator's store. Evidence and scratch copies remain under the printed directory.
The `recovery` seed fails at `matching recovery command issues exactly one link`.
The pinned old revision is checked by the script before it starts either server.

Transaction rollback and enforcement on every exit are socket-free:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/identity-unit-XXXXXX") \
  npx vitest run src/lib/metadata/identity-migration.test.ts src/lib/auth/upgrade-fixture.test.ts
```

The seeded copy, integrity and trigger failures must roll back unchanged rows and
schema, keep foreign keys enabled, and permit a successful retry. The pre-account
fixture separately proves adoption, encrypted credentials and artifact preservation.
