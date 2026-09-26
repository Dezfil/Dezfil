/**
 * Icons come from the shared icon modules: an inline `<svg>` in a
 * builder component is how the Tools control drifted from its neighbours —
 * a hand-drawn copy of a prototype glyph, invisible to the vocabulary lint.
 *
 * The shipped leftovers are inventoried, exactly as the Wheelhouse checker
 * holds its own: a file may not grow its count, and a new file may not
 * appear. Shrinking the inventory is welcome; the numbers here move down
 * with the fix, never up with a workaround.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "src/components/builder");

/** file (relative to ROOT) → inline <svg> occurrences allowed to remain. */
const INVENTORY = new Map([
  ["WidgetsTab.tsx", 2],
  ["widget-editor/WidgetDraftEditor.tsx", 1],
  ["add-layer/AddLayerCatalog.tsx", 1],
  ["export/ExportControl.tsx", 3],
  // The draw overlay IS an SVG rendering surface (drafts, vertex
  // handles) — a canvas, not a hand-drawn icon.
  ["draw/DrawOverlay.tsx", 1],
]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".tsx") && !full.includes(".test.")) yield full;
  }
}

let failures = 0;
const seen = new Map();
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  const count = (readFileSync(file, "utf8").match(/<svg[\s>]/g) ?? []).length;
  seen.set(rel, count);
  const allowed = INVENTORY.get(rel) ?? 0;
  if (count > allowed) {
    failures += 1;
    console.error(
      `NEW: ${rel} — ${count} inline <svg>${count === 1 ? "" : "s"} (inventory allows ${allowed}). ` +
        "Draw it in src/components/ui/ and import it.",
    );
  }
}
// The ratchet turns one way (review): an allowance larger than reality is
// headroom a later SVG could hide in, so a shrunk file shrinks its row —
// and a vanished file loses it.
for (const [rel, allowed] of INVENTORY) {
  const count = seen.get(rel);
  if (count === undefined) {
    failures += 1;
    console.error(`STALE: ${rel} is inventoried but no longer exists — remove its row.`);
  } else if (count < allowed) {
    failures += 1;
    console.error(
      `STALE: ${rel} now holds ${count} (inventory allows ${allowed}) — ratchet the row down.`,
    );
  }
}

if (failures > 0) {
  console.error(`FAIL - ${failures} file(s) hand-draw icons outside the shared set.`);
  process.exit(1);
}
console.log("PASS - icons come from the shared set (inventoried leftovers unchanged).");
