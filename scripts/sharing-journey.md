# Project departure proof on a production standalone

Use a detached scratch checkout of the candidate, never the working checkout
or its data. Build there, then provision the standalone exactly as the image
does: copy `public`, `.next/static`, complete native packages (`@duckdb`,
`better-sqlite3`, `bindings`, `file-uri-to-path`), and the ingress preload's
`scripts/ingress-preload.mjs`, `scripts/preload-options.mjs` and
`src/lib/auth/ingress.mjs` at their same relative paths. Keep every inherited
request-bounds probe in the wider image battery.

In that scratch checkout, after the production build:

```sh
PROOF_ROOT="$PWD"
mkdir -p .claude/test-data
LEAVE_PROOF=$(mktemp -d "$PWD/.claude/test-data/leave-proof-XXXXXX")
mkdir "$LEAVE_PROOF/data"
export DEZFIL_DATA_DIR="$LEAVE_PROOF/data"
(cd .next/standalone && PORT=3391 HOSTNAME=127.0.0.1 \
  DEZFIL_AI_PROVIDER=openai OPENAI_API_KEY=scripted-wire \
  OPENAI_BASE_URL=http://127.0.0.1:3392/v1 \
  DEZFIL_EGRESS_ALLOWLIST=127.0.0.1 DEZFIL_RENDER_CAP_FEATURES=2000 \
  node --import=./scripts/ingress-preload.mjs \
  --import="$PROOF_ROOT/scripts/sharing-leave-observer.mjs" server.js) \
  > "$LEAVE_PROOF/server.log" 2>&1 &
```

After `/api/health` on port 3391 is ready, from the same shell:

```sh
node scripts/sharing-journey.mjs seed http://127.0.0.1:3391 \
  "$LEAVE_PROOF/state.json" --assistant-wire=3392 \
  --leave-hold="$DEZFIL_DATA_DIR/.leave-probe" > "$LEAVE_PROOF/seed.json"
```

Stop only the process that owns the scratch port, restart the same command
against the same directory, then repeat with `verify` in place of `seed` and
`verify.json` as the output. Each run owns and closes the scripted wire on 3392.
Green exits zero and reports `departures` with session/token/MCP/assistant
counts **4/4/4/4**, frozen **8**, re-added **16**, and six held results: two
admitted reads, two refused outputs and two private outputs. Missing preload,
a swallowed refusal or a leaked output fails, never skips the held arm.
The retained `.ready` files identify the actual engine process and one marked
execution. Record both server and journey logs; do not publish fixture secrets.

For red controls, use separate detached builds of the same candidate. Run
`node scripts/seed-leave-defect.mjs reach` before building one, and `commit`
before building the other. Each gets a fresh store and the identical command
above. The reach seed must fail **departed project is absent**; the commit
seed must fail **late output commit follows current input reach**. A timeout,
boot failure or unavailable dependency is not the intended red. Restore the
single file printed by the seeder, rebuild, and observe the corrected green.
The seeder refuses to modify a working branch or an already modified target.

For browser proof, stop the scratch instance and restart it on port 3391 with
a fresh `DEZFIL_DATA_DIR`, using the same standalone command above. The browser
fixture provisions its own admin, so do not reuse the sharing journey's store.
From the scratch checkout, run:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/leave-browser-XXXXXX") \
  DEZFIL_BASE_URL=http://127.0.0.1:3391 npx playwright test e2e/project-leave.spec.ts
```

The four cases exercise Viewer/Editor and live/frozen owners, each across grid,
list and home. Record browser results only from an observed run, retaining
`test-results` screenshots:

1. In Projects, reveal the member's card bundle: Export then the exit glyph,
   with the Leave project hint. In list view both appear at rest. Check the
   owner's card has no Leave, and its home menu retains Rename and Delete.
2. On the member's home, keep the role/owner line and no people list. Open
   More with Enter; its only menu item is Leave project, in danger ink.
3. Open each confirmation using the keyboard. Focus starts inside the named
   dialog. Read: “You will no longer see this project or work you could access
   only through it. Its owner can add you again.” With owned work, also read:
   “What you created here stays yours and stays in the project. You still find
   it in your own lists.” No request has been sent.
4. Tab reaches Cancel; Shift+Tab wraps to Leave project; Tab wraps to Cancel.
   Cancel and Escape both close without a request and restore the entrance.
5. Confirm with Enter. Exactly one Leave request succeeds. The project
   disappears; home returns to Projects with “You left <name>.”; bundle
   departure focuses Search projects. Reopening the old URL shows the absent
   state. Owned maps still report the project identity for withdrawal.
6. Open Maps and its project filter. The departed project is absent and the
   independent project remains. Owned maps still appear in the list. Open
   the independent project's home and confirm its name and Viewer role.
   Capture the owner card/menu, each confirmation and the departure result.

Observe browser reds on separate detached builds using `placement`, `notice`
and `escape` seeds. Expect respectively owner/member entrance assertions,
the owned-work sentence, and cancellation/focus assertions to fail. Restore
and rebuild between seeds and the final green. Unit DOM assertions establish
component behavior only; they do not establish real browser layout or focus.
