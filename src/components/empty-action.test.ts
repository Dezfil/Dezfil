import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cssRules } from "./testing/css-rules";

/**
 * A list page with nothing in it shows its New or Add tile at the top
 * left, where the grid's first card sits, not centred in the page: the
 * Maps, Projects, Workflows and Data list views, and the Connections
 * list, which has no grid. Their grid views carry the tile as the grid's
 * first cell already. One gallery rule places the tile for all five.
 */

const GALLERY = "src/components/gallery.module.css";
const SCREENS = [
  "src/components/MapsScreen.tsx",
  "src/components/ProjectsScreen.tsx",
  "src/components/WorkflowsScreen.tsx",
  "src/components/TablesScreen.tsx",
  "src/components/connections/ConnectionsLedger.tsx",
];

function* stylesheets(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* stylesheets(full);
    else if (full.endsWith(".module.css")) yield full;
  }
}

describe("the empty list's tile", () => {
  it("sits at the start of its row and the top of the page", () => {
    const rules = cssRules(GALLERY).filter((r) => r.selector === ".emptyAction");
    expect(rules.length).toBeGreaterThan(0);
    const body = rules.map((r) => r.body).join(";");
    expect(body).toMatch(/justify-content:\s*start;/);
    expect(body).not.toMatch(/center/);
    expect(body).not.toMatch(/padding/);
  });

  it("is placed by that one rule on every list page", () => {
    for (const screen of SCREENS) {
      expect(readFileSync(screen, "utf8"), screen).toContain("className={gallery.emptyAction}");
    }
    const elsewhere = [...stylesheets("src")].filter((f) => f !== GALLERY && readFileSync(f, "utf8").includes("emptyAction"));
    expect(elsewhere).toEqual([]);
  });
});
