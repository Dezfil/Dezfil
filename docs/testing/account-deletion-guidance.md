# Served reader and tool contract

Run in the detached candidate checkout with its matching production standalone
and image already built. The probe owns its isolated server or container, creates
a small synthetic account store, and deletes that store and any owned volume on
exit. It never connects to the operator's instance. Server logs remain in scratch.
No browser or database image is used. These are the canonical invocations:

```sh
mkdir -p .claude/test-data
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/served-checkout-XXXXXX") node scripts/served-contract-proof.mjs --standalone "$PWD/.next/standalone" --port 3407
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/served-image-XXXXXX") node scripts/served-contract-proof.mjs --container dezfil:ci --port 3407
```

Run them sequentially. Each owns loopback port 3407 and should take 10–40 seconds,
excluding builds; elapsed time is printed. Green exits zero with `PASS: confirmed
served counts, errors, actor variants, every MCP definition and installed guidance`.
It authenticates against `/api/openapi.json`, uses the stock MCP client's real
Streamable HTTP `tools/list`, and compares:

- Actual served paths, operations, schemas, error catalogue/enum, body-reader tiers,
  tool and exclusion identities against the committed API/MCP guide counts.
- Named, explicitly deleted and unknown actor variants at last-change, Undo/Redo
  author and run-starter positions, without changing their times or SQL homes.
- Every served MCP definition against the committed capture, and the entire served
  OpenAPI document against the candidate source. Equal counts cannot hide drift.
- The installed plugin's `analysis.md` against canonical shared/package guidance.
  This is the installed file in the checkout, not an imaginary plugin HTTP route.

<!-- contract-counts:start -->
Expected counts: 142 paths, 401 operations, 187 schemas, 139 error codes, 156 tools, 245 exclusions and 69 JSON readers (17 at 65,536 bytes, 1 at 131,072 bytes, 51 at 16,777,216 bytes).
<!-- contract-counts:end -->

Regenerate the human tables from the contract with
`node scripts/generate-contract-docs.mjs`, and the plugin with
`node scripts/generate-dezfil-guidance.mjs`, each under a fresh scratch
`DEZFIL_DATA_DIR`. Regeneration is separate from the proof; it never repairs a
reader before checking it.

Apply one seed at a time in the detached checkout, then repeat both canonical
invocations with fresh scratch roots. Restore the named file after each seed.
Only the actor seed changes application source and needs the standalone and image
rebuilt. Count, error and plugin seeds alter committed reader artifacts and need
no rebuild. Do not regenerate artifacts while observing a seed:

```sh
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/seed-XXXXXX") node scripts/seed-deletion-defect.mjs doc-count
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/seed-XXXXXX") node scripts/seed-deletion-defect.mjs doc-error
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/seed-XXXXXX") node scripts/seed-deletion-defect.mjs doc-actor
DEZFIL_DATA_DIR=$(mktemp -d "$PWD/.claude/test-data/seed-XXXXXX") node scripts/seed-deletion-defect.mjs doc-plugin
```

All must exit nonzero at `served reader contract`, normally within the same 10–40
seconds: count includes `API paths: reader says 129, contract requires 128`; error
includes `Reader error catalogue has missing or extra codes`; actor includes
`Actor schema differs: RecipeRun.runner` (and the other actor positions); plugin
includes `Installed plugin guidance is stale`. Boot failure, a missing dependency,
a port conflict or authentication failure is a harness failure, not an intended
red. After source restoration rebuild the green candidate before the final runs.

The socket-free tests exercise this same comparison with the actual generated MCP
listing and named drifts. They do not confirm delivery through a built server.
Outside green and all four seeded reds remain unconfirmed until observed.
