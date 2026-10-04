# Result byte budget proofs

The claim is **bounded at 32 MiB per result on the covered reads**. These
probes do not establish a process-memory bound. Native chunks, engine
allocations, JavaScript object overhead and transport duplication remain
separate. Run against disposable stores and a disposable PostGIS source.

## Local regressions

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) npx vitest run \
  src/lib/query/result-budget.test.ts src/lib/table-result-budget.test.ts \
  src/lib/geometry/result-budget.test.ts src/lib/postgis/result-budget.test.ts \
  src/lib/postgis/preview-owner.test.ts src/lib/query/result-budget-scope.test.ts \
  src/lib/query/result-budget-probe.test.ts src/lib/mcp/result-budget-parity.test.ts \
  src/lib/api/result-budget-contract.test.ts src/lib/query/result-budget-image.test.ts \
  src/lib/query/result-budget-quick.test.ts
```

Expect roughly 15-45 seconds. These run the real route and native client
inside the test process. They are not served HTTP observations. Stock MCP
client calls and a deterministic assistant provider relay the actual SQL
route refusal. MCP text, structured content and error flag, and the
assistant event/provider outcome retain the code and exact sentence. A
17-million-character fitting REST result succeeds even when its two MCP
copies exceed 32 MiB.

Client-boundary spies count decoded values and fetched chunks independently
of the budget accountant. The scope control forbids any accountant call on
layer renders, dataset map features, sliders, Overture previews, published
views, statistics, classification, widgets and value search. Overture's
remote source is substituted with native fixture SQL in that control.

Negative controls: removed cell/result accounting, late decoding, omitted
feature/envelope bytes, lost native geometry provenance, source text wrongly
exempted, swallowed PostGIS code, and bypassed prepare/stream/chunk ownership.
Relay controls must go red for a lost MCP error flag or structured code, a
changed refusal sentence, or recounting both MCP copies. Contract controls
must go red for a missing code, a stale ceiling or an omitted reader.
Driver tests substitute commands to exercise socket-only startup, a TCP
restart, readiness exhaustion, mode selection and cleanup on probe failure.
Removing owned cleanup must fail its control. The quick probe also runs through
real routes in-process; omitting a reader must fail its coverage assertions.
Neither test establishes container readiness or the image job's elapsed time.

## Served standalone probe

Build once outside a restricted runner, then provision two instances on
unused ports. Do not use an existing operator data directory.

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-build-XXXXXX) npm run build
PORT=3401 DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-small-XXXXXX) \
  DEZFIL_QUERY_MEMORY_MB=32 npm run start -- --hostname 127.0.0.1 --port 3401
PORT=3402 DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-normal-XXXXXX) \
  DEZFIL_QUERY_MEMORY_MB=512 DEZFIL_EGRESS_ALLOWLIST=127.0.0.1 \
  npm run start -- --hostname 127.0.0.1 --port 3402
```

Run each server command in its own terminal. Supply `DEZFIL_TEST_PG_URL`
pointing to the disposable PostGIS source allowed by the second instance's
egress policy. The source account must be able to create and drop its owned
schema; the product connection remains read-only. The pinned native client
and Postgres extension must be available in the invoking checkout.

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) \
  npm run probe:query-result-budget -- http://127.0.0.1:3401 standalone --refused
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) \
  npm run probe:query-result-budget -- http://127.0.0.1:3402 standalone --full
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) \
  npm run probe:query-result-budget -- http://127.0.0.1:3402 standalone --admitted
```

The default mode is `--refused`, for compatibility with the baseline probe.
Expect 1-10 seconds for refusal, 300-600 seconds for the full control set,
and 10-60 seconds for admitted calibration. These are expectations, not
measurements. Each run prints its actual sizes; full/admitted runs print
elapsed seconds. A missing PostGIS URL in `--full` fails, never skips.

The full probe checks both ceilings at minus one, equality and plus one on
all four reader families. SQL runs both WKT and GeoJSON. Boundary payloads
use nested cells so geometry-choice excerpts do not defeat the control.
Expected totals come from fitting response bytes, including current metadata;
SQL runtime digit changes are re-fitted. Inability to land fails the run.

Valid native multipoints have compact GeoJSON sizes 10,151,576, 6,138,709 and
267,502 bytes. The 258-row control totals 12,395,238 bytes with a 1,573,724-byte
largest geometry. Large shapes come first within each reader's row window.
Multipoints survive preview simplification, so emitted geometry above 2 MiB
is exercised too. Printed WKT/GeoJSON and envelope sizes are independent
response measurements. Wide schemas, escaped/multibyte text, nulls, JSON,
nested cells and coordinate text accompany them. Geometry overflow refuses
the complete result. All three file exports are consumed to EOF and their
row count, payload bytes and Content-Length are checked above both ceilings.

Green: all assertions pass; fitting boundaries return 200 at 33,554,431 and
33,554,432 bytes; excess returns only 422 `query_result_too_large` with the
catalogue sentence, below 1 KiB. Red on an unbounded build: the forty-row
case returns its large successful body instead of that error. Lost cell or
result ceilings, an unbounded reader, wrong geometry identity, or a boundary
that cannot be fitted all exit nonzero. No partial answer is accepted.
The probe prints Content-Encoding, Content-Length and Transfer-Encoding
separately; its counted bytes are the uncompressed entity, not HTTP framing.
Owned tables, connection, source schema, map and issued token are cleaned up
on assertion failure as well as success. A supplied `DEZFIL_PROBE_TOKEN`
remains caller-owned.

## Two process observations

The `--refused` and `--admitted` modes print the exact request (without
credentials) and bytes received for the refused forty-row case and an
admitted 33,554,432-byte result. The latter labels calibration separately
from `admitted-at-ceiling` requests and fails unless an observed request
lands exactly. The caller owns memory sampling. Record heap and RSS before
and during each labelled request, baseline, peak and delta, sampling method,
interval, image/commit and engine configuration. Label each result a
**single observation**. Do not infer a capacity bound from either run.

## Built image

The image must already be built. Run from the checkout root. The pipeline form
is also the driver's default when no mode is supplied:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-image-XXXXXX) \
  sh scripts/result-budget-image.sh dezfil:ci --quick
```

Expect **20-45 added seconds**, including both app starts, excluding the build.
The workflow gives this step a one-minute timeout. It starts isolated 32 MB and
512 MB app instances, with no outside source or database image pull, and runs:

- The refused forty-row case under the 32 MB engine budget.
- Non-geometry cell minus-one/exact/plus-one boundaries for SQL in both geometry
  encodings, dataset inspection and geometry-choice preview.
- A successful SQL answer of exactly 33,554,432 bytes, fitted from measured
  response bytes, with re-fitting when runtime metadata changes size.

The complete result-boundary matrix, every PostGIS arm, the large
native geometry and representation controls, and complete exports remain the
outside proof. The supervising session runs that complete matrix explicitly:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-image-XXXXXX) \
  sh scripts/result-budget-image.sh dezfil:ci --full
```

Expect **300-600 added seconds**, excluding the build and a cold PostGIS image
pull. This runs the forty-row refusal, the complete four-reader matrix and
exports, then the separately labelled at-ceiling admission observation. It
adds a disposable PostGIS fixture in the normal app's network namespace.
Source readiness requires three consecutive TCP successes at 127.0.0.1:5432,
the address used by the app. The socket-only initialization server cannot
satisfy it; a failed TCP check resets the streak, and exhaustion fails the run.

Both forms own their container names. An unconditional trap removes containers
and anonymous volumes on success, readiness failure or assertion failure. Both
print actual elapsed seconds before container cleanup; time the whole command
as well when recording pipeline cost. Durations above are expectations, not
container measurements. The script does not sample memory.

Green: exit zero, a forty-row 422 with the exact catalogue refusal below 1 KiB,
and a 200 answer at exactly 33,554,432 bytes. Quick mode also reports all cell
boundaries; full mode reports every reader's result boundaries at minus-one,
equality and plus-one, complete controls and all three complete exports.
The driver finishes with a `confirmed: result-budget image` line and elapsed
seconds. Red: any wrong status, size, code or sentence, an unlandable boundary,
or failed TCP readiness exits nonzero. A quick run exceeding one minute also
fails the workflow allowance. Cleanup still runs; neither form skips a missing arm.

## Delegated browser flow

A browser runner uses a provisioned instance with the normal engine budget:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-browser-XXXXXX) \
  DEZFIL_BASE_URL=http://127.0.0.1:3402 npm run e2e:result-budget
```

Expect 30-120 seconds. The console uses a real refused query, finds code and
sentence in its existing error note, checks that busy ends and SQL remains,
then runs a narrower successful query. A real oversized dataset inspection
shows the sentence, with no detail/set-geometry content. Add data receives
the exact real-route refusal through its browser fixture and displays it in
its existing geometry preview error place. That last arm proves UI
propagation; the served probe proves the geometry reader itself. No new
controls, styling or layout are needed.

Seeded browser negatives, each expected to exit nonzero:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-browser-XXXXXX) \
  DEZFIL_BASE_URL=http://127.0.0.1:3402 DEZFIL_RESULT_BUDGET_BROWSER_SEED=wrong-copy \
  npm run e2e:result-budget -- --grep 'console refusal'
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-browser-XXXXXX) \
  DEZFIL_BASE_URL=http://127.0.0.1:3402 DEZFIL_RESULT_BUDGET_BROWSER_SEED=stale-busy \
  npm run e2e:result-budget -- --grep 'console refusal'
```

Wrong-copy replaces the received error sentence. Stale-busy receives the
real 422 but holds completion of the browser fetch. Neither changes the
server or source files. Unset the seed and rerun for green. Browser outcomes
are reported only by the delegated runner that actually ran them.

The complete outside battery still runs `npm test` without socket exclusions,
the production build, all lint gates and the API/durability/ownership/sharing
and MCP journeys in [the runbook](runbook.md). The result probe supplements
those existing gates; it does not replace them.

## Contract counts

Measured against the pre-budget contract: 124 paths, 355 operations (including
HEAD/OPTIONS), 162 component schemas, 136 MCP tools and 219 deliberate tool
exclusions remain unchanged. JSON body readers remain 63: 11 at 65,536 bytes,
one at 131,072 bytes and 51 at 16,777,216 bytes. The error catalogue grows
from 106 to 107 codes. No runtime setting is added; the existing test-only
PostGIS URL is now also documented as executable probe wiring. Run
`npm run lint:contract-docs` and `npm run lint:readme` to remeasure.

## Companion outside commands

Keep the runbook's renderer, tiler and loopback fixture prerequisites. These
are unchanged checks, each on its own disposable instance/store; do not run
ownership/sharing seeds against a store another journey already provisioned.
Expected durations are 2-5 minutes for build, 15-30 minutes for the complete
battery, 1-5 minutes per API/MCP journey and 1-3 minutes per seed/verify arm.
Actual runtimes depend on the host and must be recorded by the outside runner.

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) npm test -- --maxWorkers=2
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/journey.mjs http://127.0.0.1:3403
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/mcp-journey.mjs http://127.0.0.1:3403 --render
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/durability.mjs seed http://127.0.0.1:3403 .claude/budget-durability.json
# Replace the 3403 server over the same store before verify.
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/durability.mjs verify http://127.0.0.1:3403 .claude/budget-durability.json
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/ownership-journey.mjs seed http://127.0.0.1:3404 .claude/budget-ownership.json
# Replace the 3404 server over its store.
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/ownership-journey.mjs verify http://127.0.0.1:3404 .claude/budget-ownership.json
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/sharing-journey.mjs seed http://127.0.0.1:3405 .claude/budget-sharing.json --assistant-wire=3406
# Replace the 3405 server over its store.
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-probe-XXXXXX) node scripts/sharing-journey.mjs verify http://127.0.0.1:3405 .claude/budget-sharing.json --assistant-wire=3406
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) npx vitest run src/lib/postgis/preview.live.test.ts
```

The sharing instance needs `DEZFIL_AI_PROVIDER=openai`, a synthetic
`OPENAI_API_KEY` and `OPENAI_BASE_URL=http://127.0.0.1:3406/v1`. The held-source
suite needs `DEZFIL_TEST_PG_URL` and takes about 60-90 seconds: green means
both timeout and departed-caller cases drain owned backends within their
existing bounds, retain source health and permit a sibling read. Any failed
assertion is red. No real-provider key or request is needed.
