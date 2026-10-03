import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildOpenApiDocument } from "@/lib/api/openapi";

/**
 * **This spec adds no API semantics**.
 *
 * The repository already sweeps every own-API call in the UI against the
 * documented paths, and that sweep covers these modules too — but it passes as
 * long as *some* call somewhere was found, so it cannot notice that this
 * feature's calls were missed. Two things are asserted here instead: that the
 * drawer's calls are seen at all, and that the set of endpoints it uses is
 * **exactly** the enumerated one. The second is what has teeth: a new endpoint
 * added to serve the drawer fails this test, which is what "calls what and
 * published" has to mean if it is a criterion rather than a promise.
 */

const DRAWER_DIR = path.join(process.cwd(), "src/components/builder/drawer");
/** The one-step surface's calls that live outside the drawer directory —
 * the exception strip and the table-detail door. A file extracted out of the
 * directory must be added here, or its calls silently leave the inventory:
 * the scan follows designated modules, not a folder. */
const ALSO_SCANNED = [
  "src/components/builder/ExceptionStrip.tsx",
  "src/components/TableRunState.tsx",
  // the catalog and the tables list are read through the shared
  // browser-safe reads the workflow canvas also uses; the calls moved
  // there, the endpoints did not change.
  "src/components/api.ts",
];

/** Every endpoint the drawer is allowed to reach, with the spec that published
 * it. Adding a row is a decision, which is the point. */
const ALLOWED: Record<string, string> = {
  // Absent deliberately: reading one recipe, and the index's rename,
  // duplicate and delete — the recipe UI left with the one-step pivot, and
  // the API keeps those capabilities for agents. Also absent: reading one
  // recipe. The drawer runs steps through the recipe, and reads the list
  // rather than a member — a row here for something unused would make this
  // list a wish rather than a description.
  "POST /api/operations/run": "the dry run that gates Run (dryRun: true only; committed runs go through the step)",
  "GET /api/operations": "the catalog, as data",
  "GET /api/operations/runs/X": "poll a run",
  "GET /api/recipes": "the workspace's recipes",
  "POST /api/recipes": "create a recipe",
  "POST /api/recipes/X/steps": "add a step",
  "DELETE /api/recipes/X/steps/X": "remove a step; its dataset remains",
  "POST /api/recipes/X/steps/X/run": "run one step",
  "GET /api/tables": "the workspace's tables",
  "GET /api/tables/X": "one table, with its columns",
  "POST /api/maps/X/layers": "the result on the map",
};

interface Call {
  file: string;
  method: string;
  route: string;
}

function drawerCalls(): Call[] {
  const calls: Call[] = [];
  const files = [
    ...readdirSync(DRAWER_DIR)
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
      .filter((entry) => !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx"))
      .map((entry) => ({ entry, full: path.join(DRAWER_DIR, entry) })),
    ...ALSO_SCANNED.map((rel) => ({
      entry: rel,
      full: path.join(process.cwd(), rel),
    })),
  ];
  for (const { entry, full } of files) {
    const src = readFileSync(full, "utf8");
    // The call and the options object that follows it, so the method is read
    // rather than assumed: a POST counted as a GET would let a write in.
    const re = /(?:fetch|request)\(\s*[`"']([^`"']*\/api\/[^`"']*)[`"']\s*(?:,\s*\{([\s\S]{0,200}?)\})?/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) {
      const route = match[1].replace(/\$\{[^}]+\}/g, "X").split("?")[0];
      const method = /method:\s*"([A-Z]+)"/.exec(match[2] ?? "")?.[1] ?? "GET";
      calls.push({ file: entry, method, route });
    }
  }
  return calls;
}

describe("the drawer's API surface", () => {
  const calls = drawerCalls();

  it("is actually seen by this sweep", () => {
    // Without this the two assertions below are vacuously true, which is the
    // shape of check the review rules hunt.
    expect(calls.length).toBeGreaterThanOrEqual(12);
    expect(new Set(calls.map((c) => c.file)).size).toBeGreaterThanOrEqual(3);
  });

  it("is exactly the endpoints published, and no others", () => {
    const used = [...new Set(calls.map((c) => `${c.method} ${c.route}`))].sort();
    expect(used).toEqual(Object.keys(ALLOWED).sort());
  });

  it("resolves, every one of them, to a documented path", () => {
    const documented = Object.entries(buildOpenApiDocument().paths).flatMap(
      ([p, methods]) =>
        Object.keys(methods as Record<string, unknown>).map((method) => ({
          method: method.toUpperCase(),
          matcher: new RegExp(
            "^" + p.replace(/\{[^}]+\}/g, "X").replace(/\//g, "\\/") + "$",
          ),
        })),
    );
    const undocumented = calls.filter(
      (call) =>
        !documented.some(
          (d) => d.method === call.method && d.matcher.test(call.route),
        ),
    );
    expect(undocumented).toEqual([]);
  });
});
