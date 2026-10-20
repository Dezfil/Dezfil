# Settings persistence smoke probe

Use an isolated production instance with its own persistent data directory,
exposed at `http://127.0.0.1:3396`. Leave `DEZFIL_PREVIEW_ROWS` unset or empty.
Supply an active admin token from that instance in `DEZFIL_PROBE_TOKEN`.
For a container named `dezfil-settings-probe`, run from the checkout:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/settings-probe-XXXXXX") \
  npm run probe:settings -- http://127.0.0.1:3396 -- docker restart dezfil-settings-probe
```

The probe reads `DEZFIL_PROBE_TOKEN` from the caller's environment; it never
prints the token. The scratch `DEZFIL_DATA_DIR` belongs to the probe process;
the server must retain its own data directory across the restart. Docker must
be available to this command. For a standalone server, replace the arguments
after the second `--` with an executable and its arguments that stop and start
that same isolated server with the same data directory and environment. The
command runs directly, without a shell. It has a two-minute timeout, followed
by up to two minutes of readiness polling. The probe refuses port 3000 and
non-loopback targets; another explicit isolated port may be substituted.

It warms the configuration, query and anonymous entry routes, changes
`previewRows` and `signInMessage` in one API write, checks the configuration and
query preview on their separate routes, then restarts. Both values must persist;
the start time must change and remain stable on repeated reads. Query checks
include all 25 source rows and the preview truncation flag. The probe restores
the original stored values through the API, including absent overrides, on
success and on failures where the instance remains reachable. If restoration
fails it reports failure too; discard the isolated fixture after investigating.

Green is exit 0 with one JSON result containing `"result":"confirmed"`, two
different start times and `"restored":true`. Red is exit 1 with `failed:` and
the failed assertion or request status. A restart command that does nothing,
a stale route consumer, missing persistence or failed cleanup cannot be green.
The unit controls run without listening sockets:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/settings-probe-unit-XXXXXX") \
  npx vitest run src/lib/settings/smoke-probe.test.ts
```
