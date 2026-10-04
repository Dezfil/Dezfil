# TLS, browser transport and paired render timing

These probes run outside CI, from this checkout on one idle Docker host. Build
and name the candidate image first. Keep the baseline image built from `2aded21`
with the same Chromium version and resources. The scripts never build an image
or install dependencies. Every invocation needs a fresh absolute scratch folder.
Do not run other render probes concurrently: the isolated subnets overlap.

## TLS with host-provisioned trust

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-egress-driver.mjs --image dezfil:relay --suite tls
```

The **outside host** needs OpenSSL with `req -addext` and NSS `certutil` on PATH
(the NSS utility, not a platform utility with the same name). The driver calls
those executables; neither Node's built-in modules nor the runtime image can
mint the required certificates or NSS databases. Nothing is installed in or
added to the image. `render-tls-trust.mjs` generates, for each independent arm:

- A two-day RSA root CA and a separate untrusted root CA.
- A root-signed `tls.render.test` leaf, an untrusted-root-signed leaf for that
  same name, and a root-signed `other.render.test` leaf for the wrong-name arm.
- An intermediate signed by the trusted root and a leaf signed by that
  intermediate. The leaf's AIA URL is
  `http://aia.render.test:8080/intermediate.der`. The server sends only the leaf.
- Two fresh NSS SQL databases with **only the trusted root** imported using
  trust `C,,`, mounted writable at `/home/node/.pki/nssdb` and
  `/home/node/.local/share/pki/nssdb`. Both Linux browser database locations are
  provisioned; Chromium still has to demonstrate that it honors the mounted
  trust. Its user-data profile is newly created by each browser launch.
- A separate `node-ca.pem`, containing both roots and the intermediate, mounted
  through `NODE_EXTRA_CA_CERTS` for Node's save-time inspection. This does not
  supply browser trust. Save uses the normal API and force-save contract.

The generated certificates and fixture keys are mounted read-only at `/trust`.
The fixtures and observers are mounted at `/probes`; none enters the image.
The positive has no certificate override, special insecure origin, SPKI
exception or validation bypass. If provisioning or browser trust fails, its
report says **not run**, gives the failing checks/reason, and exits nonzero.
No green positive is inferred from a self-signed connection or from Node trust.

Green is exit 0 with `trusted-style-tiles-identity-pixels`: a complete PNG with
cyan raster tiles, completed browser style and tile responses whose certificate
SAN includes `tls.render.test`, and fixture SNI matching that name. Separate
`untrusted-validation-no-pixels` and `wrong-host-validation-no-pixels` lines
require respectively `ERR_CERT_AUTHORITY_INVALID` and
`ERR_CERT_COMMON_NAME_INVALID` on the fixture's browser request, no fixture
HTTP requests during the render, and zero cyan pixels. A transport failure or
an unrelated browser certificate error fails these checks. The export may
produce the shipped data-only image; these arms do not invent a new API error.
Missing logs, identity, pixels, closure, liveness or certificate errors are red.

The two cold-profile incomplete-chain arms separately report the AIA request's
source, destination, response, road and render outcome. The second returns 503
at the intermediate URL. A passive observer records any HTTP response through
a SOCKS stream. Contact without that attribution is reported as route
unconfirmed. No request means **configured, not observed**, even if rendering
succeeds. These are supplementary observations, not closure assertions; a
cached-chain or flag-only success does not prove fetching or suppression.

## Supplementary browser report

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-egress-driver.mjs --image dezfil:relay --suite supplementary
```

This uses the same host trust prerequisites. Before the production export, the
launched browser visits an explicitly **scripted page** on the trusted HTTPS
fixture. It attempts service-worker registration/activation and a worker fetch,
a WebSocket handshake, and WebRTC ICE gathering with a STUN destination at
`203.0.113.10:3478`. A favicon request is possible; background traffic remains
opportunistic. CDP events, fixture requests, handshake events, netlogs, flags
and stimulus results are retained. The UDP destination is a stimulus only:
there is no live UDP listener or QUIC server, so absence is no suppression proof.

Every sub-claim gets its own `REPORT` line and structured entry:

| Claim | Evidence label | Tip coverage |
|---|---|---|
| Service workers | configured, not observed | Activation/fetch stimuli do not yet establish each request's road. |
| WebSocket | observed in the spike | Tip events retained; connection-specific attribution is not established. |
| Non-proxied UDP/QUIC | configured, not observed | Flags and ICE stimulus, no live bypass control. |
| Browser-owned requests | observed in the spike | Favicon/background observations are opportunistic; individual road unconfirmed. |

These labels deliberately remain conservative even when a listener and a SOCKS
tunnel are both seen. They are not closure criteria. An optional
`--seed supplementary-direct` removes proxy flags to collect a direct companion;
it cannot promote any label or turn silence into a proven suppression claim.
A failed trust prerequisite retains all four report lines. Exit zero means the
trusted export/control completed and the report exists, not four coverage claims.

## Paired timing and guarded response counts

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-paired-driver.mjs --baseline dezfil:baseline --image dezfil:relay
```

The baseline tag must identify the frozen baseline above. The earlier standalone
baseline median of **4,543 ms**, with **81 tiles per export**, is historical
context, never a substitute for this paired run. Both images run on the same
host, with two CPUs and 4 GiB per app, fresh stores/browsers, disabled browser
cache and `no-store` fixture responses. The
[frozen fixture](../scripts/render-timing-fixture.json) stays byte-identical:
2048×2048 export, external HTTP basemap, public-range fixture network. The run
refuses mismatched browser versions. Each child's inventory retains the exact
image ID and resource settings; the paired report retains host identity.

Two warmups per version precede ten measured exports per version. Each pair is
interleaved; the first is baseline/candidate, the next candidate/baseline, and
so on. No two exports overlap. Request-to-complete-PNG durations include the
full response body. Warmups are excluded from medians but must still pass.
Every export needs at least 64 distinct successful, completed tile responses;
abandonment, a failed/incomplete tile, missing pixels or any missing sample
voids the **whole paired run**, including otherwise successful samples.

For the candidate, `road.ndjson` independently observes the app process's
accepted loopback socket bytes. It records the browser-selected SOCKS listener,
CONNECT destination, complete HTTP response bodies and tile SHA-256. It does
not use the fixture counter, relay implementation callbacks, additional socket
reads or data listeners. `guarded-tile-responses` joins exact distinct paths to
completed browser response IDs and observed SOCKS stream IDs, checks body hashes,
and cross-checks the fixture count. A direct browser connection can still give
81 fixture/browser tiles but must yield zero guarded tiles and fail this check.
Both versions load the observer; the baseline has no SOCKS listener to count.

`paired-report.json` retains all durations/counts and evidence paths, both
absolute medians, candidate-minus-baseline milliseconds, ratio, attempted-run
count and every void with reasons. Green is a valid complete run with ratio
at most **1.5**. A ratio above **1.2** requests an outside explanation/profile;
it is not a second gate. A complete slower-than-1.5 run is red and retained,
never reclassified as void to select a faster result.

The runner automatically repeats a voided run from its first warmup, at most
three attempts by default (`--max-runs 1..10`). Exhaustion or interruption exits
nonzero. Keep all directories. After interruption, repeat the complete command
with fresh scratch plus `--prior-report /absolute/old/paired-report.json` to
retain/count previous attempts. Repeated voids or a bound that cannot be met go
to the supervising operator for a decision; do not relax the fixture or bound.

## Named negative seeds

One command requires each unmodified control to pass and each seeded defect to
fail its intended assertion. It rejects setup failures as evidence. The optional
`--seed NAME` selects one row; the default runs all five:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-comparison-seeds.mjs --image dezfil:relay --baseline dezfil:baseline
```

| Seed | Expected red |
|---|---|
| `broken-tunnel` | Routes the trusted arm to a closed SOCKS port; trusted style/tile pixels and identity must fail. |
| `certificate-bypass-untrusted` | Explicit **negative mutant only** enables CDP certificate ignoring; the untrusted validation/no-pixels assertion must fail. |
| `certificate-bypass-wrong-host` | The same negative mutant only on the wrong-name arm; that arm's validation/no-pixels assertion must fail. |
| `direct-bypass` | Removes proxy flags for a candidate timing sample; 64 completed fixture/browser tiles still pass, guarded count fails. |
| `delay` | Adds ten seconds before candidate capture inside the timed export; a complete paired run must fail 1.5×, not time out or void. |

No source or image bytes are edited by these seeds. Certificate bypass is
confined to the two explicitly selected **negative mutants**, never a positive
or a fallback. Their additional `no-certificate-bypass` failure alone does not
satisfy the seed runner: the corresponding validation/pixels assertion must
also fail. Successful seed execution exits 0 and prints each green/red pair;
a seed that misses its assertion exits nonzero.

## Ownership and retained artifacts

Each child owns `dezfil-egress-<pid>-<nonce>-app`, `-dns`, `-host`, `-listener`
and two internal networks with the same prefix: `-public` (`203.0.113.0/24`)
and `-private` (`192.168.99.0/24`). All use the named image; helpers use Node
entrypoints. Internal ports: app 3187, DNS UDP 53, HTTP fixtures 8080 and TLS
fixture 8443. No host ports, extra image or named data volume. `/data` is tmpfs.
The scripted STUN attempt targets UDP 3478 without a listener. All owned
containers/networks are removed in `finally`, including ordinary failures and
SIGINT/SIGTERM; paired/seed drivers forward those signals and wait for cleanup.
A forced kill cannot run cleanup: consult each `inventory.json` for exact names.
The retained scratch contains fixture keys/trust databases, PNGs, raw logs,
netlogs, image/browser identities, reports and seed results. Remove it when the
outside evidence has been archived. No runtime app setting is introduced.

Expected runtime, to be measured outside: roughly 1–2 minutes for TLS, under
30 seconds for supplementary stimuli, 3–5 minutes for one paired attempt, and
roughly 10–15 minutes for all green/red seeds. Voids add whole attempts. None of
these durations or browser/connection outcomes has been measured by the local
socket-free assertion tests.
