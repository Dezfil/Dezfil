# Map picture proofs

Build and provision a production instance in a separate checkout with its own
scratch data directory, a real image renderer and tile builder. After building,
provision the standalone as in [the project departure proof](../../../scripts/sharing-journey.md):
copy `public` to `.next/standalone/public`, `.next/static` to
`.next/standalone/.next/static`, and the complete native packages (`@duckdb`,
`better-sqlite3`, `bindings`, `file-uri-to-path`) into its `node_modules`.
Copy the ingress preload and its supporting files at the same relative paths,
as that recipe describes. The traced standalone alone cannot render these proofs.
Use a port other than the development listener. Auto must be unpinned and its light and
dark style hosts reachable. Create a disposable account token on that instance.
The proof creates and deletes its own maps, never opens their builders, and
rejects the development port before making a request.

Set `DEZFIL_EGRESS_ALLOWLIST=127.0.0.1` on the real-render instance: the
drawing and incompleteness cases serve loopback styles beside the renderer.
Capture that instance's stderr with `2>"$DEZFIL_PICTURE_RENDER_LOG"` when
launching it. Choose an absolute log path readable by the test process and
export that same path there, as below. The abandoned-request proof reads the
renderer log to distinguish abandonment from an egress refusal or budget kill.

```sh
mkdir -p .claude/scratch
export DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/scratch/pictures-XXXXXXXX")
export DEZFIL_PICTURE_TEST_URL=http://127.0.0.1:3581
export DEZFIL_PICTURE_TEST_TOKEN=disposable-account-token
export DEZFIL_PICTURE_RENDER_LOG="$PWD/.claude/scratch/pictures-render.stderr.log"
fnm exec --using=24 npm test -- src/lib/pictures/pictures.real-render.test.ts --maxWorkers=2
```

Remove that test process's scratch directory after the run. The instance has
its own independent scratch directory. The test checks all three computed
mark positions at 692 by 296 in both appearances on each creation road,
then drawing changes, unsupported tiled live filters, a layer that fails
after save admission, an unreachable basemap and an abandoned outside request.
The pixel oracle's
flat-image control and listener guard run without a server in
`src/lib/pictures/real-proof-controls.test.ts`. A skipped real-render test is
not evidence of a rendered picture.

For the never-opened absence control, provision a separate instance from a
build made before server pictures. Point `DEZFIL_PICTURE_TEST_URL` and
`DEZFIL_PICTURE_TEST_TOKEN` at that instance, then run only the never-opened
cases with the absence switch:

```sh
export DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/scratch/pictures-control-XXXXXXXX")
DEZFIL_PICTURE_EXPECT_NONE=1 fnm exec --using=24 npm test -- src/lib/pictures/pictures.real-render.test.ts --maxWorkers=2 -t "never opened"
```

This control observes missing pictures for three quiet periods without calling
the picture refresh API. Remove its test scratch directory after the run.

The independent framing proof opens the real builder at 1440 by 900, flat
and pitched. It measures its visible 988 by 824 map window and compares mark
offsets around the saved centre against the card after reduction, within four
pixels. It attaches both images and the numeric errors. Keep loopback style
requests allowed in the isolated instance's egress policy.

```sh
DEZFIL_BASE_URL=http://127.0.0.1:3581 npx playwright test e2e/picture-framing.spec.ts --project=chromium
```

Use the style fixture only on the migrated theme suite's instance. Keep it off
the real-render and framing instance. For the migrated theme suite, copy
`scripts/pictures-browser-fixture-preload.mjs` into `.next/standalone/scripts/`
and load that copy: add `--import=./scripts/pictures-browser-fixture-preload.mjs`
while launching from `.next/standalone`, and set `DEZFIL_PICTURE_STYLE_FIXTURE=1`.
The root and standalone have separate copies of `puppeteer-core`; a preload
loaded from the root patches the wrong copy. This fixture refuses the development
port and requires a data directory whose name includes `pictures-`.
It substitutes only the three built-in style
responses after normal renderer admission. The actual browser still loads,
paints and captures them; no image or readiness declaration is mocked.

That same instance also needs the [browser suite's assistant wiring](../../../docs/self-host/backup-and-restore.md#the-browser-suite)
for `assistant-clear.spec.ts`: the scripted provider, automatic check off and
the `e2e/assistant-self-port.cjs` preload, with `DEZFIL_E2E_LISTEN_PORT` matching
the instance's port and `DEZFIL_E2E_SELF_PORT=3303`. Keep the self-port preload's
path valid from the standalone launch directory, alongside the ingress and
style preloads.

```sh
DEZFIL_BASE_URL=http://127.0.0.1:3581 npx playwright test e2e/thumbnail-theme.spec.ts e2e/picture-credit.spec.ts e2e/edit-attribution-capture.spec.ts e2e/map-alignment.spec.ts e2e/assistant-clear.spec.ts --project=chromium
```

Theme pictures and credit are seeded through server work. Alignment uses
loopback styles accessible to both browsers and the saved camera at the
card's composition size. The clear-conversation check counts every page
request; the browser uploads no pictures, so none is excused.

The card states run on that same instance and on a second one with no
renderer: the same standalone launched the same way, with its preloads, on
another port and data directory, with `DEZFIL_CHROMIUM_PATH` naming a file
that does not exist and no style fixture. Without `DEZFIL_NO_RENDERER_URL`
the no-renderer case is skipped. Cut the placeholder and administrator-line
baselines on the first run with `--update-snapshots=missing` and look at them
before keeping them.

```sh
DEZFIL_BASE_URL=http://127.0.0.1:3581 DEZFIL_NO_RENDERER_URL=http://127.0.0.1:3583 npx playwright test e2e/card-states.spec.ts --project=chromium
```
