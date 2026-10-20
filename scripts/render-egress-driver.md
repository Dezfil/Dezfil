# Renderer destination probes

Probes that the image export renderer reaches only the destinations it may, from the image job's gate to the wider matrix.

These are assertion-bearing probes for the built image and the relay. Their
socket/browser outcomes require an outside run. Pure parser, admission and
evidence-checker tests make no connection claim. The original gate is one step
of the image job; the matrix and wider evidence remain outside it.

## Original gate

From the checkout, with Docker and an already built image:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-egress-driver.mjs --image dezfil:baseline
```

Use the baseline image built from `2aded21`, then repeat with the repaired image
tag. `--victim style` or `--victim blind` runs one three-arm variant; the default
runs both and reports every arm even when earlier assertions fail. The observed
baseline took 27 seconds for both variants (exit 1). The relay image gate was
observed outside at 29 seconds, exit 0, with all 42 assertions passing. These
observations are not a response-time promise; repeat against each new image.

Each invocation owns a random `dezfil-egress-<pid>-<nonce>` prefix. It creates two
internal networks (`-public`, `203.0.113.0/24`; `-private`, `192.168.99.0/24`) and
four containers (`-app`, `-dns`, `-host`, `-listener`), using the supplied image
for all four. Run serially: those fixed subnets must be available. No host port
is published. The app listens on 3187 inside its container, DNS on UDP 53,
and the style host and private listener on 8080. Every container's `/data` is
fresh tmpfs, overriding the image's volume declaration so no volumes are created.
Containers are replaced between arms; hostnames are also unique. There is no
attack allowlist. All scripts are mounted from this checkout.

The `finally` path removes every owned container (defensively removing any attached volumes)
and both networks, including after failures and SIGINT/SIGTERM. Retained scratch
contains the inventory, per-arm NDJSON logs, unmodified browser netlogs, export
PNG/JSON, browser version/flags, and the combined report. No global prune or
foreign resource cleanup is used. A forced process kill cannot run a finalizer;
the exact owned names are in `inventory.json` for that case.

Every arm saves through the API with public DNS first. It then reaches the
private listener from the app's namespace, waits for that socket's logged close,
and starts a distinct measurement epoch. Save/control traffic cannot consume the
render sequence. Public root styles paint cyan; a usable private response paints
magenta; the blind victim returns text. The observer only adds net logging and
disables browser cache; it does not change DNS, policy, proxy, TLS or timeouts.

Expected baseline output, separately for `style` and `blind`:

```text
PASS <variant>-public evidence-complete
PASS <variant>-public listener-live-before-measurement
PASS <variant>-public dns-answer-sequence
FAIL <variant>-public browser-dns-absent ...
PASS <variant>-public private-connections-zero
PASS <variant>-public private-requests-zero
PASS <variant>-public public-png-and-pixels
PASS <variant>-rebind evidence-complete
PASS <variant>-rebind listener-live-before-measurement
PASS <variant>-rebind dns-answer-sequence
FAIL <variant>-rebind browser-dns-absent ...
FAIL <variant>-rebind private-connections-zero ...
FAIL <variant>-rebind private-requests-zero ...
FAIL <variant>-rebind exact-policy-answer ...
PASS <variant>-private evidence-complete
PASS <variant>-private listener-live-before-measurement
PASS <variant>-private dns-answer-sequence
PASS <variant>-private browser-dns-absent
PASS <variant>-private private-connections-zero
PASS <variant>-private private-requests-zero
PASS <variant>-private exact-policy-answer
```

The baseline must exit 1. Green means every line is PASS, exit 0: public renders
cyan, both refused arms return exactly 502 `render_failed` with the shipped
egress sentence and no PNG, and the listener measurement is empty. A missing
log, early private admission, browser DNS job/transaction, unexpected AAAA
answer, incomplete browser close, dead listener or failed setup is a failure.
Resolver REQUEST bookkeeping alone is not browser DNS work. DNS logs retain all
question types; rebinding requires exactly one public A answer, followed only
by private A answers and empty AAAA responses.

The replay tool never changes retained evidence. These observation seeds must
fail even over a green arm (use a fresh scratch `DEZFIL_DATA_DIR` for each run):

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-egress-replay.mjs /path/to/arm missing-netlog
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-egress-replay.mjs /path/to/arm dead-listener
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-egress-replay.mjs /path/to/arm wrong-sequence
```

Expected failures are respectively `evidence-complete` / `browser-dns-absent`,
`listener-live-before-measurement`, and `dns-answer-sequence`. Omit the seed to
recheck the original observation. These are evidence-loss mutants, not claims
about connections made by a mocked socket.

## Dependency and compatibility matrix

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-egress-driver.mjs --image dezfil:baseline --suite matrix
```

This runs 43 independent exports. `--suite dependencies` selects its twelve
dependency exports; `--suite controls` selects its 31 compatibility exports.
The observed baseline took 198 seconds: 240 assertions passed and 23 failed,
exactly on the six changed-name roads below. It uses the
same four owned container names and two owned network names as the gate,
recreating them for every arm. The link-local arms use `169.254.99.0/24` for the
private network instead of `192.168.99.0/24`. IPv6 arms add
`fd00:deaf:beef::/64` and address `fd00:deaf:beef::10`; Docker must support IPv6.
The loopback/other-port arms add a listener process on 3188 inside the owned app
container, with separate logs and liveness. No host ports or extra containers.

Each of redirect, source metadata, sprite JSON, glyph, raster tile, and worker
GeoJSON gets a public companion and its own changed destination name. The root
name stays public. The sprite's public PNG and redirected JSON avoid racing two
admissions for the single public answer. The worker request must be observed in
a worker target; a request from the page alone fails that proof. No scripted
page substitutes for style-driven traffic. Public companion styles are checked
by the shipped style validator in the unit suite.

Expected baseline lines for each `<road>-rebind`, with the same exact names
used by the original gate:

```text
PASS <road>-rebind evidence-complete
PASS <road>-rebind listener-live-before-measurement
PASS <road>-rebind dependency-request-observed
PASS <road>-rebind dependency-answer-sequence
FAIL <road>-rebind browser-dns-absent ...
FAIL <road>-rebind private-connections-zero ...
FAIL <road>-rebind private-requests-zero ...
FAIL <road>-rebind exact-policy-answer ...
```

The last line can already PASS on the tile arm: concurrent tile admissions
can refuse later requests while the first admitted request contacts the
listener. That is still red on private contact. A baseline observation must
show contact in **each** changed-name arm; a missing stimulus, wrong DNS
sequence or setup error is not the intended baseline red. The public companions
must PASS `dependency-request-observed`, `dependency-answer-sequence`, both
silence assertions and `completed-control-png`. Their browser DNS remains in
raw netlogs; this matrix does not rename it a compatibility failure.

All 31 compatibility arms should PASS on the baseline and repaired image:

- Five denied destinations (private IPv4, localhost, the app host on another
  port, link-local, and private IPv6), directly and via redirect, for HTTP and
  HTTPS. Each expects the exact policy answer and empty listener measurements.
  Liveness uses plain HTTP on that destination's listening socket. HTTPS here
  checks destination refusal before TLS, and proves no certificate behavior.
- Hostname, IP and CIDR allowlists, each with private magenta content, a public
  cyan control, and an unlisted loopback listener that must stay silent.
- Dead at admission and public-then-NXDOMAIN: successful data-only PNGs, the
  exact shipped dead-style notice observed at capture, data pixels, no private
  contact and no policy answer. `dead-answer-sequence` must PASS.

Green on the repaired image means every matrix assertion passes, including
the exact refusal for all six changed dependencies. Removed literal checks,
mixed-answer admission, exception/bypass changes, relay lifetime, trusted TLS,
and comparison mutants belong beside the later implementation. They are not
invented baseline reds or claims made by these controls.

## Frozen timing baseline

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-egress-driver.mjs --image dezfil:baseline --suite timing
```

The observed baseline took 95 seconds, exit 0: all ten measured exports had
81 completed tiles each, with a 4,543 ms median. This is an unpaired baseline.
Same owned names, standard two
internal subnets and ports as the gate; no host ports. Each app has two CPUs
and 4 GiB of memory, a fresh store and a fresh browser. Browser caching is
disabled and every fixture response is `no-store`. The fixture is HTTP on the
public-range network at `timing.render.test:8080`, outside the app origin.
No internet, allowlist, app-origin tiles or loopback basemap supplies it.

[`render-timing-fixture.json`](render-timing-fixture.json) freezes
the style, 256×256 authored cyan PNG, 2048×2048 export definition and SHA-256
identities. The checker and tests pin those identities independently of the
manifest. Do not change them between baseline and candidate. The observer
captures the browser version and successful Network response/request IDs;
the host separately logs completed responses. Both must name the same set of
at least 64 distinct tile URLs, and every requested tile must finish with 200.

For each of two warmups followed by ten measured exports, expected baseline
output is:

```text
PASS timing-<warmup|sample>-<n> evidence-complete
PASS timing-<warmup|sample>-<n> listener-live-before-measurement
PASS timing-<warmup|sample>-<n> frozen-fixture
PASS timing-<warmup|sample>-<n> complete-timing-png
PASS timing-<warmup|sample>-<n> at-least-64-completed-tiles
PASS timing-<warmup|sample>-<n> private-listener-silent
```

The baseline timing probe should exit 0. A 63-tile, failed, incomplete,
abandoned or missing sample exits 1 and voids the entire series: no median is
reported. Keep every voided directory and its reasons; rerun the whole command
with fresh scratch. `report.json` retains all request-to-complete-body durations,
both tile counts and URL sets, browser versions, fixture identity and the
baseline median. `inventory.json` records the exact image and resource limits.
The saved images must contain the fixture pixels, not merely an offline PNG.

This command remains a baseline fixture/counting run and makes no paired or
guarded-road claim. Use the [paired timing driver](render-paired-driver.md#paired-timing-and-guarded-response-counts)
for the comparison, independent guarded response counts, both medians, delta,
ratio and retained voids. Its direct-bypass and delay seeds are documented beside
the TLS and supplementary probes.


## Relay framing, connections and local clients

Run from this checkout on a host that can bind IPv4 and IPv6 loopback sockets:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) npm test -- src/lib/export/render-socks.test.ts src/lib/export/render-address.test.ts src/lib/export/render-relay.test.ts
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-relay-seeds.mjs
```

No browser, container, network, fixed port or external service is created.
The socket fixture owns ephemeral TCP listeners on `127.0.0.1` and `::1`,
checks liveness before silence, and tears down its own clients/listeners in
`afterEach`. The relay owns its independent ephemeral IPv4 loopback listener,
upstream sockets and timers. Residue assertions run before fixture teardown.
Estimated added outside runtime: 20 seconds for the unseeded files and 40 seconds
for all relay seeds; these are expectations to measure, not observed timings.

Green means echo bytes arrive through the relay, only the admitted target sees
contact, reconnects recheck, mixed/literal denials contact nothing, each allowlist
exception works, and an unreachable first address falls back after one resolution.
A local client can use an allowed target; it cannot evade the policy. No client
authentication or exclusivity is promised. DNS/transport failures do not set the
policy-refusal flag. Invalid/unfinished handshakes open no upstream connection.
Closing destroys tunnels and the listener; a late DNS result cannot dial.

The seed runner first requires the unmodified named test to pass, applies one
source mutation, requires an assertion failure (infrastructure failure is not a
red), then restores exact source bytes in `finally`. Do not run it alongside an
editor/build/test in this checkout. Logs remain in `.claude/logs/render-relay-seeds`.
`--list` lists seeds; `--seed=<name>` selects one; `--unit` runs only socket-free
proofs. Each child gets a fresh scratch data directory. The seeds are:

- `parser`: accepts UDP ASSOCIATE as CONNECT; malformed-command assertion fails.
- `second-lookup`: replaces admitted addresses with a fresh unchecked resolution;
  target-contact/one-resolution assertions fail.
- `unchecked-literal`: skips literal policy; denial/silence assertions fail.
- `mixed-answer`: admits a set with any allowed address; whole-set refusal fails.
- `omitted-hostname-exception`, `omitted-ip-exception`, `omitted-cidr-exception`:
  each named exception's successful admission and real connection fail.
- `first-address-only`: omits remaining admitted candidates; fallback echo fails.

The existing gate/matrix commands should be repeated with the candidate image.
No TLS or guarded timing assertion is supplied by these socket tests.

## Render integration and lifetime

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) npm test -- src/lib/export/render-lifetime.test.ts src/lib/export/render-driver-relay.test.ts src/lib/export/render-driver-auth.test.ts src/lib/export/render-stall.test.ts
```

The lifetime file uses real relay and target sockets with a controlled browser
lifecycle, not Chromium. It owns ephemeral IPv4/IPv6 loopback listeners, clients,
in-memory account metadata and the relays; all are closed after each test.
Success, refusal, launch failure, crash, timeout and cancellation must each leave
no listener or upstream socket within the existing three-second grace, before
fixture teardown, and a queued next render must succeed. Concurrent renders must
keep independent tunnels. A stalled browser close must not retain relay resources;
a browser arriving after cancellation/timeout must be killed. A real bind conflict
must open no browser destination socket and yield exactly 502 `render_failed`:
“The image could not be rendered. Retry; if it persists, the instance's renderer
needs attention.” Recovery uses a fresh relay. Capture and abandoned-request
verdicts must still yield the exact egress sentence even with a held sibling.
Estimate 15 seconds for this focused invocation; measure outside.

The seed runner above also provides the integration defects below. Each can be
selected with `--seed=<name>`; the default runs all non-browser proofs. Pure and
real-socket versions run separately when both exist:

- `startup-classification`: leaks startup into the browser-unavailable 503 mapping.
- `direct-fallback`: launches without a proxy after relay startup fails; the bind
  proof's browser launch opens a real destination socket, which must fail silence.
- `connection-report`: drops the relay's policy flag; the exact capture refusal fails.
- `capture-refusal`: omits the final success/error checks; capture yields PNG/generic failure.
- `pending-admission`: stops waiting for late connection decisions.
- `abandoned-refusal`: discards a denied verdict after the client connection ended.
- `transport-as-policy`: turns an ordinary DNS failure into a policy claim.
- `cleanup-success`, `cleanup-refusal`, `cleanup-launch-failure`, `cleanup-crash`,
  `cleanup-timeout`, `cleanup-cancellation`: omit that ending's relay cleanup;
  timeout/cancellation seeds also detach the relay's independent stop so it cannot
  mask the omission. Listener/upstream residue assertions must fail before teardown.
- `late-dns`: restores dialing after shutdown; the target-contact count must fail.
- `shared-state`: shares sockets between relays; closing one breaks the other's echo.
- `credential-redirect`: attaches the app credential to external redirects; the
  existing driver header assertions must fail. This unit proof makes no wire claim.

The complete non-browser seed run is expected to take about 60 seconds. It retains
per-proof green/red logs and restores source bytes even on an assertion failure.
The maintainer must retain actual durations from the outside run; these added
estimates have not been measured in the socket-restricted implementation environment.

For the exact bypass seam, use the shipped Chromium executable on a host that
can bind loopback sockets. No built application, image, fixed port or network is
needed; the fixture serves its own tiny page and removes its resources in `finally`:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) DEZFIL_RELAY_BROWSER=1 DEZFIL_CHROMIUM_PATH=/usr/bin/chromium npm test -- src/lib/export/render-proxy.browser.test.ts
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) DEZFIL_RELAY_BROWSER=1 DEZFIL_CHROMIUM_PATH=/usr/bin/chromium node scripts/render-relay-seeds.mjs --browser --seed=broadened-scheme
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) DEZFIL_RELAY_BROWSER=1 DEZFIL_CHROMIUM_PATH=/usr/bin/chromium node scripts/render-relay-seeds.mjs --browser --seed=broadened-port
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) DEZFIL_RELAY_BROWSER=1 DEZFIL_CHROMIUM_PATH=/usr/bin/chromium node scripts/render-relay-seeds.mjs --browser --seed=implicit-loopback
```

This is explicitly a scripted-page stimulus, without request interception.
Green means the exact app origin renders its text, while the other scheme,
`localhost` alias and other port each fail with `ERR_SOCKS_CONNECTION_FAILED`,
set the relay refusal and contact no target. The three seeds respectively drop
the scheme, the port, or the implicit-loopback subtraction from the bypass rule;
each must fail the browser assertion. Flag-string tests alone establish no
browser behavior. Expect about 10 seconds for the unseeded browser file, plus
about 20 seconds per selected browser seed, to be measured outside.

The existing credential redirect browser control also remains required. On an
already provisioned isolated production app at `http://127.0.0.1:3217`, configured
with `DEZFIL_EGRESS_ALLOWLIST=127.0.0.1` and its shipped renderer, run from the same
network namespace (the fixture's loopback listeners must be reachable by the app):

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) DEZFIL_BASE_URL=http://127.0.0.1:3217 npx playwright test e2e/render-auth.spec.ts
```

Its two ephemeral trap listeners, map and API token are removed in `finally`;
the maintainer owns the app and its store. Green includes successful
cookie/token renders and looks, no credentials on either external redirect hop,
and the existing anonymous/revoked-call denials. For the stalled-tile control,
provision a separate production standalone sharing a fresh data directory and
render signing key with the test. From the repository root, with the standalone's
static assets already provisioned, run:

```sh
export DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX)
export DEZFIL_RENDER_DELEGATION_KEY=$(openssl rand -hex 32)
export DEZFIL_STALLED_TILES_RENDER=3217
export DEZFIL_CHROMIUM_PATH=/usr/bin/chromium
export DEZFIL_EGRESS_ALLOWLIST=127.0.0.1
PORT="$DEZFIL_STALLED_TILES_RENDER" HOSTNAME=127.0.0.1 node \
  --import="data:text/javascript,process[Symbol.for('dezfil.session-delegation-key')]=Buffer.from(process.env.DEZFIL_RENDER_DELEGATION_KEY,'hex')" \
  --import=./scripts/ingress-preload.mjs .next/standalone/server.js
```

In another shell with those same exported values, run:

```sh
npm test -- src/lib/export/map-look.stalled-tiles.test.ts
```

The setup refuses a missing key and probes the standalone with a delegated
credential before rendering. A non-200 response fails immediately and names
`DEZFIL_RENDER_DELEGATION_KEY`, rather than waiting out the render budget on a
sign-in page. The ephemeral basemap listener is removed by the fixture; the
runner stops the standalone and removes the scratch store. Green is a complete
image naming the abandoned host for both raster and vector tiles, on both the
map check and export roads. Four socket cases hold the first viewport tile; all
other vector tiles return an empty protobuf body. Two additional `never-started`
vector cases, one per road, model a stranded first z12 tile request: the driver's
admitted continue resolves without starting the fetch, so there is no socket and
no terminal event. Green for these cases means the first cut's settle signal
produces the image naming the abandoned host within the bound plus ten seconds
and before the road's budget, while the tile never reaches the server and has no
terminal event before capture. Seed red by commenting out
`void page.evaluate(settleRenderTiles).catch(() => {});` in
`src/lib/export/render-driver.ts`; both `never-started` cases must then exhaust
their render budgets.

The check uses its own request bound and budget; the export uses its default
request bound and budget. The cut ends
current relay sockets, reaching worker fetches as well as page fetches, before
the page's offline flip and stop. The relay remembers only hosts whose requests
outlived the bound since their start or last abandonment. It matches names case-insensitively and IPv6 literals
in their compressed, lowercase form without brackets, refusing re-dials with
SOCKS reply 4 before admission or dialing for this render only. Younger requests
also have their sockets ended, but their hosts can re-dial. The listener remains
available. Requests with no terminal event stay armed and trigger another
cut after the same request bound, normally 10 seconds for a check and 20 seconds
for an export. Previously abandoned requests receive no new arrival grace;
app-origin requests still hold the cut. Each cut is logged and counted again.
These HTTP/1.1 fixtures establish stalled-tile settlement; they do not exercise
transparent retries on reused HTTP/2 connections. That behavior requires an
outside render with a controlled TLS response hold; the product has no hold
switch.
Neither control starts an application, container or network for the runner.

The outside-observed relay gate passed all 42 assertions: public/rebinding
browser-DNS absence, rebinding listener silence and exact policy answers for both
victim variants. The wider matrix must still be repeated against the delivery
image; none of its 23 baseline failures is deferred or replaced with a flag check.
TLS, individual supplementary claims and the paired guarded timing comparison
have [their own recipes and named seeds](render-paired-driver.md). Their
outcomes remain separate from the style-driven destination boundary.

## Image job step

The job reuses its already-built `dezfil:ci` image for the app and three helpers.
Mirror its single step outside with:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-egress-driver.mjs --image dezfil:ci
```

Both three-arm variants run, with no attack allowlist or host port. The expected
added time is about **30 seconds**, based on the outside 27–29 second gate
measurements; record the actual hosted-runner seconds. No new response-time
contract or CI timing threshold is introduced. Missing readiness, logs, DNS
sequence, listener liveness/silence, pixel control or exact refusal exits nonzero.
Cleanup tries every exact owned name in `finally`, including failures and handled
signals. The resource inventory, internal ports/subnets, cleanup and retained
scratch are described above. There is no global prune and no reuse of another
step's live app. The dependency matrix, TLS, supplementary and paired timing
probes stay outside the image job.
