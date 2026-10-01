import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableListing } from "../../api";
import { installDomHost } from "../../testing/dom-host";
import { SignedIn } from "../../sharing/signed-in";
import { homeLine, typedInHome } from "./catalog-state";
import { AddLayerCatalog } from "./AddLayerCatalog";

/**
 * The add-layer catalogue on a map whose SQL home is Ada's, opened by Bo:
 * it names each dataset as the map's SQL types it, Ada's by its plain name
 * and Bo's own with his SQL name, and one line under the scope names that
 * surprise. On Bo's own map nothing changes: Ada's carries her SQL name,
 * his own its plain name, and no line.
 */

const catalogue = vi.hoisted(() => ({ listing: null as unknown }));
vi.mock("./use-catalog-tables", () => ({ useCatalogTables: () => ({ listing: catalogue.listing, retry: vi.fn() }) }));
vi.mock("../drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("../../ui/Dialog", () => ({ Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../../scope/ScopeFilter", () => ({ ScopeFilter: () => <span data-scope /> }));
vi.mock("./CatalogWorkbench", () => ({ CatalogWorkbench: ({ draft }: { draft: string }) => <pre data-draft>{draft}</pre> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const table = (name: string, owner: typeof ada): TableListing =>
  ({
    id: `${owner.sqlName}-${name}`, name, qualifiedName: owner === bo ? name : `${owner.sqlName}.${name}`, owner,
    projectIds: ["berlin"], source: "upload", geometryColumn: "geom", geometryType: "POINT", rowCount: 186,
  }) as unknown as TableListing;
const OFFERED = [table("roads", ada), table("stations", bo)];

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  catalogue.listing = {
    world: { projects: [{ id: "berlin", name: "Berlin housing study" }], all: OFFERED }, worldError: null,
    offered: OFFERED, offeredError: null, onRetry: vi.fn(),
  };
  host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

const q = (selector: string) => host.document.querySelector(selector);
const rows = () => q('[aria-label="Tables"]')!.querySelectorAll("button").map((b) => b.getAttribute("aria-label"));
async function open(home: string, owner: typeof ada) {
  await act(async () => {
    root.render(
      <SignedIn account={bo}>
        <AddLayerCatalog request={{ kind: "add" }} onClose={vi.fn()} createLayer={vi.fn()} onPostgisTableImported={vi.fn()}
          uploadQueue={{ entries: [], active: null, position: 0, skips: [], softNotes: null, add: vi.fn() } as never}
          projectId="berlin" mapId="m1" mapHome={home} mapOwner={owner} />
      </SignedIn>,
    );
  });
  const tables = host.document.querySelectorAll("button").find((b) => b.textContent.startsWith("Tables"))!;
  await act(async () => tables.click());
}

describe("the catalogue's names on someone else's map", () => {
  it("names Ada's datasets plainly and Bo's own with his SQL name, as the map's SQL types them", async () => {
    await open("ada", ada);
    expect(rows()).toEqual(["roads", "bo.stations"]);
    expect(q('[aria-label="bo.stations"]')!.querySelector("i")?.textContent).toBe("bo.");
  });

  it("carries the one line under the scope naming the surprise", async () => {
    await open("ada", ada);
    expect(q("[data-home-line]")?.textContent).toBe("This map is Ada’s, so your own datasets carry your SQL name: bo.stations.");
  });

  it("seeds the SQL view with the typed name of the dataset picked", async () => {
    await open("ada", ada);
    await act(async () => q('[aria-label="bo.stations"]')!.click());
    const sql = host.document.querySelectorAll("button").find((b) => b.textContent.startsWith("SQL query"))!;
    await act(async () => sql.click());
    expect(q("[data-draft]")?.textContent).toBe("SELECT * FROM bo.stations");
  });

  it("changes nothing on Bo's own map: Ada's carries her SQL name, and no line", async () => {
    await open("bo", bo);
    expect(rows()).toEqual(["ada.roads", "stations"]);
    expect(q("[data-home-line]")).toBeNull();
  });
});

describe("the catalogue's naming rules", () => {
  it("types a dataset in a map's home, or as the console does without one", () => {
    expect(typedInHome(table("stations", bo), "ada")).toBe("bo.stations");
    expect(typedInHome(table("roads", ada), "ada")).toBe("roads");
    expect(typedInHome(table("roads", ada), null)).toBe("ada.roads");
  });

  it("names a handed-over map's home by its SQL name, and an empty list by the SQL name alone", () => {
    expect(homeLine("ada", bo, "bo", [])).toEqual({ lead: "This map reads ada’s datasets, so your own datasets carry your SQL name:", example: "bo" });
    expect(homeLine("bo", bo, "bo", [])).toBeNull();
  });
});
