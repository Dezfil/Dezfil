# Renderer destination probes

These are assertion-bearing probes for the built image. They add no renderer
repair or pipeline step. Their socket/browser outcomes require an outside run;
unit tests exercise only the evidence checker.

## Original gate

From the checkout, with Docker and an already built image:

```sh
DEZFIL_DATA_DIR=$(mktemp -d /tmp/dezfil-test-XXXXXX) node scripts/render-egress-driver.mjs --image dezfil:baseline
```

Use the baseline image built from `2aded21`, then repeat with the repaired image
tag. `--victim style` or `--victim blind` runs one three-arm variant; the default
runs both and reports every arm even when earlier assertions fail. Expect
90–180 seconds for both variants, to be measured by the outside runner.

Each invocation owns a random `dezfil-egress-<pid>-<nonce>` prefix. It creates two
internal networks (`-public`, `203.0.113.0/24`; `-private`, `192.168.99.0/24`) and
four containers (`-app`, `-dns`, `-host`, `-listener`), using the supplied image
for all four. Run serially: those fixed subnets must be available. No host port
is published. The app listens on 3187 inside its container, DNS on UDP 53,
and the style host and private listener on 8080. The app's `/data` is fresh tmpfs.
Containers are replaced between arms; hostnames are also unique. There is no
attack allowlist. All scripts are mounted from this checkout.

The `finally` path removes every owned container (including anonymous volumes)
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
