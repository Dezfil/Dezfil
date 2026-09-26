import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TableListing } from "../../api";
import { CatalogTableBrowser } from "./CatalogTableBrowser";

/**
 * What the add-layer catalog's project filter prints, in every state the
 * browser can be in.
 *
 * The e2e journey drives the catalog's ready state. These render the
 * component itself, which is the only way to reach the states a browser
 * round cannot arrange on demand: a pending world, a failed world, a
 * globally empty catalog, and the two states where the SCOPED read is
 * pending or failed while the world is ready. The last two matter
 * because the filter IS drawn there — the earlier three return before
 * it — so its face obeys the count rule in them too.
 */

const table = (id: string, projectIds: string[]): TableListing =>
  ({
    id,
    name: id,
    sourceFilename: `${id}.geojson`,
    format: "geoparquet",
    file: `tables/${id}.parquet`,
    geometryColumn: "geom",
    geometryType: "Point",
    crsAssumed: false,
    rowCount: 1,
    createdAt: "2026-09-09T00:00:00.000Z",
    source: "upload",
    sourceParams: null,
    importedAt: null,
    sizeBytes: 1,
    projectIds,
  }) as unknown as TableListing;

const BERLIN = table("berlin_one", ["p-a"]);
const SHARED = table("shared_one", ["p-a", "p-b"]);
const LOOSE = table("loose_one", []);
const ALL = [BERLIN, SHARED, LOOSE];
const PROJECTS = [
  { id: "p-a", name: "Berlin" },
  { id: "p-b", name: "Atlas" },
  { id: "p-z", name: "Empty shelf" },
];

type Listing = Parameters<typeof CatalogTableBrowser>[0]["listing"];

const render = (listing: Partial<Listing>) =>
  renderToStaticMarkup(
    <CatalogTableBrowser
      listing={{
        world: { projects: PROJECTS, all: ALL },
        worldError: null,
        offered: ALL,
        offeredError: null,
        scope: { kind: "all" },
        onScope: () => {},
        onRetry: () => {},
        ...listing,
      }}
      selected={null}
      onPick={() => {}}
    />,
  );

/** The filter's presence, and what its face prints, from the markup. */
function face(html: string) {
  const present = html.includes('aria-label="Filter by project"');
  const name = /class="[^"]*faceName[^"]*"[^>]*>([^<]*)</.exec(html)?.[1] ?? null;
  const count =
    /data-scope-count[^>]*>([^<]*)</.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ??
    null;
  return { present, name, count };
}

describe("the catalog's filter across the browser's states", () => {
  it("is not drawn at all while the world is pending, when it failed, or when the catalog is globally empty", () => {
    const seen = {
      pending: face(render({ world: null })),
      failed: face(render({ worldError: "the server did not answer" })),
      empty: face(render({ world: { projects: PROJECTS, all: [] } })),
    };
    // No filter means no count, and means this piece cannot reach these
    // three states: they return before the control is built.
    expect(seen).toEqual({
      pending: { present: false, name: null, count: null },
      failed: { present: false, name: null, count: null },
      empty: { present: false, name: null, count: null },
    });
  });

  it("keeps each state's own body while the world is pending, failed or empty", () => {
    expect({
      pending: render({ world: null }).includes("Loading tables…"),
      failed: render({ worldError: "the server did not answer" }).includes(
        "the server did not answer",
      ),
      empty: render({ world: { projects: PROJECTS, all: [] } }).includes(
        "No tables yet. Import data first.",
      ),
    }).toEqual({ pending: true, failed: true, empty: true });
  });

  it("IS drawn while the scoped read is pending or failed, and obeys the count rule there", () => {
    // These two states keep the filter above their own body. Under All
    // its face prints nothing; under a named scope it prints its count.
    expect({
      offeredPending: face(render({ offered: null })),
      offeredFailed: face(render({ offeredError: "the scope did not answer" })),
      offeredPendingNamed: face(
        render({ offered: null, scope: { kind: "project", id: "p-a" } }),
      ),
      offeredFailedUnfiled: face(
        render({ offeredError: "no", scope: { kind: "none" } }),
      ),
    }).toEqual({
      offeredPending: { present: true, name: "All projects", count: null },
      offeredFailed: { present: true, name: "All projects", count: null },
      offeredPendingNamed: { present: true, name: "Berlin", count: "· 2" },
      offeredFailedUnfiled: {
        present: true,
        name: "Not in a project",
        count: "· 1",
      },
    });
  });

  it("prints no count on the All face in the ready state, whatever it holds", () => {
    // The menu's rows are not readable here: the popover mounts through
    // a portal only once it is opened, so nothing of it is in the
    // server markup. The rows are read in the browser instead, off
    // their count elements (e2e/add-layer-scope.spec.ts), and the rule
    // itself is unit-tested in src/components/scope/model.test.ts.
    expect(face(render({}))).toEqual({
      present: true,
      name: "All projects",
      count: null,
    });
  });

  it("keeps the count on a named face whose project holds every dataset", () => {
    const everything = [table("one", ["p-a"]), table("two", ["p-a"])];
    expect(
      face(
        render({
          world: { projects: PROJECTS, all: everything },
          offered: everything,
          scope: { kind: "project", id: "p-a" },
        }),
      ),
    ).toEqual({ present: true, name: "Berlin", count: "· 2" });
  });
});
