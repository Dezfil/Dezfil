// The decomposition tripwire. Holds the size half of the rule — features extract the
// piece they touch; new logic starts in new modules — by a check instead
// of memory; code review holds the semantic half (the extraction actually
// happening). Each oversized module must sit exactly at its recorded
// ceiling: growth fails until the ceiling is raised in the same diff (an
// explicit, reviewable decision), and shrinking fails until the ceiling
// is lowered to match (a mandatory ratchet — a stale ceiling would let a
// later change regrow the module silently).
// Usage: node scripts/check-monster-files.mjs
import { readFileSync } from "node:fs";

// Line-count ceilings = the sizes recorded when the rule was adopted.
// Lower a ceiling when a PR shrinks its file (the ratchet); raising one
// is a reviewed decision, not a convenience.
const CEILINGS = {
  // The builder shell. Extractions so far: thumbnail capture, the export
  // card, the Basemap tab, the failure rail, the shell's own state,
  // undo/redo coordination, the draw integration, the legend corners, the
  // Add layer catalog mount, the stage controls, the assistant wiring, the
  // helper composition and the effective-basemap derivation.
  "src/components/builder/MapBuilder.tsx": 1792,
  // The map canvas. Extractions so far: capture, the text sublayer, the
  // basemap content-group lifecycle, tiled-layer construction, pointer
  // interaction, camera constraints, the shared paint readout and overlay lifetime.
  "src/components/map/MapCanvas.tsx": 1366,
  // Layer service. Extractions so far: layer geometry inspection and the
  // deletion cascade.
  "src/lib/layer-service.ts": 1554,
  // The style panel. Extractions so far: the icon picker, the Label
  // section and the hover-field sections.
  "src/components/builder/StylePanel.tsx": 1191,
  // The parameter form, after the catalog-driven parameter controls left
  // for parameter-controls so the workflow canvas composes the same rows.
  "src/components/builder/drawer/ParameterForm.tsx": 449,
  // The workflow canvas, after its right-side furniture left for
  // CanvasFurniture.
  "src/components/workflow-canvas/WorkflowCanvas.tsx": 1289,
};

let failed = false;
for (const [file, ceiling] of Object.entries(CEILINGS)) {
  // Physical lines, not newline delimiters — a final line without a
  // trailing newline still counts.
  const text = readFileSync(file, "utf8");
  const lines =
    text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  if (lines > ceiling) {
    failed = true;
    console.log(
      `::error file=${file}::${file} grew to ${lines} lines (ceiling ${ceiling}). ` +
        `The decomposition rule (AGENTS.md): extract the piece this change touches, ` +
        `or start the new logic in its own module.`,
    );
  } else if (lines < ceiling) {
    // The ratchet is mandatory, not advisory: a stale ceiling would let a
    // later change regrow the module up to it with no signal.
    failed = true;
    console.log(
      `::error file=${file}::${file} is ${lines} lines, below its ceiling of ${ceiling} — ` +
        `lower the ceiling to ${lines} in scripts/check-monster-files.mjs so the gain is kept.`,
    );
  } else {
    console.log(`OK   ${file} at its ceiling (${lines} lines)`);
  }
}

if (failed) {
  process.exit(1);
}
console.log("PASS — every oversized module is exactly at its recorded ceiling.");
