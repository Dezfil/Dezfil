import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
// The scoped add-layer catalog: the filter row above the shared browser's search
// in the Tables view and the SQL workbench, the ruled defaults per filing state,
// scoped rows in the shipped grouping with no membership tag on any row, pick
// dissolution, the empty scope keeping filter and search, the import line's two
// wordings, and the browsing-scope-never-redirects-an-import trade: upload and
// URL proven end to end through the API, the stale-project refusal end to end,
// and the three remote roads' request boundaries asserted in a stubbed second
// test. It also holds the compact filter's count rule in both views: All
// projects carries its name alone on the face and in the open menu, every other
// row keeps its number. The menu is read where it lives — portalled to the
// document body, outside the dialog — since an assertion scoped inside the
// dialog would pass without reading a row. Residue-proof: every assertion is
// about this run's seeded objects, and project-row counts (residue-free by
// construction) are the only counts asserted.
import {
  test,
  expect,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { routeHouse, seedCsv, startFixtureServer } from "./support";

const runId = Date.now().toString(36);
const PA = `Berlin scope ${runId}`;
const PB = `Atlas scope ${runId}`;
const PZ = `Empty shelf ${runId}`;
const MAP = `Scoped map ${runId}`;
const MAP2 = `Free map ${runId}`;
const T_A = `als_a_${runId}`;
const T_B = `als_b_${runId}`;
const T_SHARED = `als_shared_${runId}`;
const T_FREE = `als_free_${runId}`;
// A name long enough that the provenance line clips it on
// main, short enough to read in full once the line is gone.
const T_OUT = `als_output_with_long_name_${runId}`;

const CSV = "name,lng,lat\nBuoy,7.10,53.52\n";

const api = (page: Page, method: string, pathName: string, body?: unknown, basis?: EditBasis) =>
  page.evaluate(
    async ({ method, pathName, body, basis }) => {
      const r = await fetch(pathName, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : undefined), ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok && r.status !== 204) throw new Error(await r.text());
      const text = r.status === 204 ? "" : await r.text();
      return text ? (JSON.parse(text) as unknown) : null;
    },
    { method, pathName, body, basis },
  );

const listing = async (page: Page) =>
  (await api(page, "GET", "/api/tables")) as {
    id: string;
    name: string;
    projectIds: string[];
  }[];

/** Every open row's printed count, keyed by the row's own name: the
 * count read off the count ELEMENT, null when the row prints none.
 *
 * A menu row's text is its project's name followed by its number, so
 * `toContainText("2")` against the row matches any name that holds a 2
 * — and these names carry a base-36 clock, which holds a 0 or a 2 about
 * two runs in five. Such an assertion passes with the count element
 * gone.
 *
 * Read in one pass once the menu is on screen, so a red run names every
 * row rather than stopping at the first, and so a seeded defect is
 * proven against each row and not only the first. */
async function menuCounts(
  menu: Locator,
): Promise<Record<string, string | null>> {
  return menu.getByRole("menuitem").evaluateAll((items) =>
    Object.fromEntries(
      items.map((el) => [
        (el.querySelector("[class*='rowName']")?.textContent ?? "").trim(),
        el.querySelector("[data-scope-count]")?.textContent?.trim() ?? null,
      ]),
    ),
  );
}

/* The face is read through expect.poll, never once: picking a scope
   navigates, and a single read after the click catches the face the
   pick is replacing. That shipped in this round's first draft and was
   caught by the conjunct-complete green run — "Workflows: the named
   scope's face" read "All projects" with no count. The menu reads need
   no poll: each follows a polling gate on the open menu's own rows, and
   nothing navigates between that gate and the read. */
/** The face's name and its printed count, the same way. */
async function faceParts(filter: Locator) {
  return filter.evaluate((el) => ({
    name: (el.querySelector("[class*='faceName']")?.textContent ?? "").trim(),
    count: el.querySelector("[data-scope-count]")?.textContent?.trim() ?? null,
  }));
}

const openCatalogTables = async (page: Page) => {
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add layer" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Tables" }).click();
  return dialog;
};

test("the scoped catalog end to end", async ({ page, context }) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");

  let pa = "";
  let pb = "";
  let mapId = "";
  let map2Id = "";
  await test.step("seed the world", async () => {
    pa = (
      (await api(page, "POST", "/api/projects", { name: PA })) as { id: string }
    ).id;
    pb = (
      (await api(page, "POST", "/api/projects", { name: PB })) as { id: string }
    ).id;
    await api(page, "POST", "/api/projects", { name: PZ });
    await seedCsv(page, T_A, CSV);
    await seedCsv(page, T_B, CSV);
    await seedCsv(page, T_SHARED, CSV);
    await seedCsv(page, T_FREE, CSV);
    const ids = new Map((await listing(page)).map((t) => [t.name, t.id]));
    await api(page, "PATCH", `/api/projects/${pa}/members`, {
      addTables: [ids.get(T_A)!, ids.get(T_SHARED)!],
    });
    await api(page, "PATCH", `/api/projects/${pb}/members`, {
      addTables: [ids.get(T_B)!, ids.get(T_SHARED)!],
    });
    mapId = (
      (await api(page, "POST", "/api/maps", { name: MAP, projectId: pa })) as {
        id: string;
      }
    ).id;
    map2Id = (
      (await api(page, "POST", "/api/maps", { name: MAP2 })) as { id: string }
    ).id;
  });

  await page.goto(`/maps/${mapId}`);
  let dialog = await openCatalogTables(page);
  const filter = dialog.getByRole("button", { name: "Filter by project" });
  const search = dialog.getByLabel("Search tables");
  const row = (name: string) =>
    dialog.getByRole("button", { name, exact: true });
  const pickScope = async (name: string | RegExp) => {
    await filter.click();
    // The menu portals to the document body, outside the dialog's DOM.
    await page.getByRole("menuitem", { name }).click();
  };

  await test.step("the filed default and the popover's truth", async () => {
    // The default scope is the map's project, its dataset count on the
    // face (2: the own dataset and the shared one).
    await expect
      .poll(() => faceParts(filter), { message: "the filed default's face" })
      .toEqual({
      name: PA,
      count: "· 2",
    });
    await filter.click();
    const menu = page.getByRole("menu", { name: "Filter by project" });
    await expect(
      menu.getByRole("menuitem", { name: `All projects` }),
    ).toBeVisible();
    // Every row's count in one comparison, read off the count elements
    // and reported together: the zero-count project is offered at zero,
    // and Not in a project is there with a number of its own (its value
    // is residue-bound on a shared instance; the project rows' are not).
    const counts = await menuCounts(menu);
    expect(
      {
        all: counts["All projects"],
        pa: counts[PA],
        pb: counts[PB],
        pz: counts[PZ],
        unfiled: counts["Not in a project"],
      },
      `the popover's counts; the menu read ${JSON.stringify(counts)}`,
    ).toEqual({
      all: null,
      pa: "2",
      pb: "2",
      pz: "0",
      unfiled: expect.stringMatching(/^\d+$/),
    });
    // One Escape closes the popover and ONLY the popover: the catalog
    // holds for the next press (the contract; the pre-fix composition
    // closed both, caught by this journey's first run).
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("menu", { name: "Filter by project" }),
    ).toHaveCount(0);
    await expect(dialog).toBeVisible();
  });

  await test.step("scoped rows, no tags, search inside the scope", async () => {
    await expect(row(T_A)).toBeVisible();
    await expect(row(T_SHARED)).toBeVisible();
    // No row carries a membership tag: the shared table says nothing of
    // its other project, the own table nothing at all.
    await expect(row(T_SHARED)).not.toContainText("also in");
    await expect(row(T_SHARED)).not.toContainText(`in ${PB}`);
    await expect(row(T_A)).not.toContainText(`in ${PA}`);
    await expect(row(T_B)).toHaveCount(0);
    await expect(row(T_FREE)).toHaveCount(0);
    await expect(search).toHaveAttribute("placeholder", "Search 2 tables…");
    // Search matches within the scope only.
    await search.fill(T_B);
    await expect(
      dialog.getByText(`No table name matches “${T_B}”.`),
    ).toBeVisible();
    await search.fill("");
  });

  await test.step("a pick dissolves when the scope stops offering it", async () => {
    await row(T_A).click();
    await expect(row(T_A)).toHaveAttribute("aria-pressed", "true");
    const submit = dialog.getByRole("button", {
      name: "Add layer",
      exact: true,
    });
    await expect(submit).toBeEnabled();
    await pickScope(PB);
    await expect(row(T_B)).toBeVisible();
    await expect(row(T_A)).toHaveCount(0);
    await expect(dialog.locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect(submit).toBeDisabled();
    // Still no tag under the other scope.
    await expect(row(T_SHARED)).not.toContainText("also in");
  });

  await test.step("All projects and Not in a project speak their terms", async () => {
    await pickScope("All projects");
    // The compact filter obeys the same rule in the catalog. The
    // face reads the name alone under All, and so does the All row of
    // the OPEN MENU, which portals to the document body — scoping this
    // to the dialog would read no row at all.
    await expect(filter, "the All face carries no count").toHaveText(
      "All projects",
    );
    await expect
      .poll(() => faceParts(filter), { message: "the All face's parts" })
      .toEqual({
      name: "All projects",
      count: null,
    });
    await filter.click();
    const allMenu = page.getByRole("menu", { name: "Filter by project" });
    await expect(
      allMenu.getByRole("menuitem", { name: "All projects" }),
      "the All row carries its name alone",
    ).toHaveText("All projects");
    expect(
      (await menuCounts(allMenu))["All projects"],
      "the All row's count element",
    ).toBeNull();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("menu", { name: "Filter by project" }),
    ).toHaveCount(0);
    // Under All, filed rows name no project either.
    await expect(row(T_A)).toBeVisible();
    await expect(row(T_A)).not.toContainText(`in ${PA}`);
    await expect(row(T_SHARED)).not.toContainText(`in ${PB}`);
    await expect(row(T_SHARED)).not.toContainText(`in ${PA}`);
    await expect(row(T_FREE)).toBeVisible();
    await pickScope("Not in a project");
    await expect(row(T_FREE)).toBeVisible();
    await expect(row(T_A)).toHaveCount(0);
    // In the catalog, the unfiled scope keeps a count on the face, and
    // so does every named row in the open menu. The unfiled value is
    // residue-bound on a shared instance, so the shape is asserted, not
    // the number; the project rows are residue-free by construction and
    // keep their exact counts.
    await expect
      .poll(() => faceParts(filter), { message: "the unfiled scope's face keeps a count" })
      .toEqual({
      name: "Not in a project",
      count: expect.stringMatching(/^·\s*\d+$/),
    });
    await filter.click();
    const openMenu = page.getByRole("menu", { name: "Filter by project" });
    await expect(
      openMenu.getByRole("menuitem", { name: "All projects" }),
    ).toBeVisible();
    // One comparison over every row this step is about, so a seeded
    // defect is proven against each of them and not only the first.
    const kept = await menuCounts(openMenu);
    expect(
      {
        all: kept["All projects"],
        pa: kept[PA],
        pb: kept[PB],
        pz: kept[PZ],
        unfiled: kept["Not in a project"],
      },
      `All silent, every other row keeping its number; the menu read ${JSON.stringify(kept)}`,
    ).toEqual({
      all: null,
      pa: "2",
      pb: "2",
      pz: "0",
      unfiled: expect.stringMatching(/^\d+$/),
    });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("menu", { name: "Filter by project" }),
    ).toHaveCount(0);
  });

  await test.step("an empty scope keeps the filter and the search", async () => {
    await pickScope(PZ);
    // The zero-count scope keeps its count on the face, read off the
    // count element and reported with its name.
    await expect
      .poll(() => faceParts(filter), { message: "the empty scope's face" })
      .toEqual({
      name: PZ,
      count: "· 0",
    });
    await expect(search).toBeVisible();
    await expect(
      dialog.getByText("No tables yet. Import data first."),
    ).toBeVisible();
  });

  await test.step("the SQL workbench shares the scope; the draft is never scoped", async () => {
    await dialog.getByRole("button", { name: "SQL query" }).click();
    // One scope for the whole open catalog: the workbench's filter
    // face carries the empty scope picked in Tables.
    await expect(filter).toContainText(PZ);
    const editor = page.getByRole("textbox", { name: "New layer SQL" });
    await editor.click();
    await page.keyboard.type(`SELECT * FROM ${T_B}`);
    await expect(editor).toHaveText(`SELECT * FROM ${T_B}`);
    // Naming an out-of-scope table neither clears the draft nor
    // disables the commit.
    await expect(
      dialog.getByRole("button", { name: "Add layer", exact: true }),
    ).toBeEnabled();
  });

  await test.step("the SQL query view obeys the same count rule", async () => {
    // Still in the workbench, under the empty scope PZ: a named project
    // keeps its count on the compact face there too.
    await expect
      .poll(() => faceParts(filter), { message: "a named scope's face in the workbench" })
      .toEqual({ name: PZ, count: "· 0" });
    await filter.click();
    const menu = page.getByRole("menu", { name: "Filter by project" });
    await expect(
      menu.getByRole("menuitem", { name: "All projects" }),
      "the workbench's All row carries its name alone",
    ).toHaveText("All projects");
    const wb = await menuCounts(menu);
    // Every row the workbench's menu shows, not a subset: collecting a
    // value into the failure message is not asserting it. The unfiled
    // value is residue-bound, so its
    // shape is asserted; the project rows' counts are exact.
    expect(
      {
        all: wb["All projects"],
        pa: wb[PA],
        pb: wb[PB],
        pz: wb[PZ],
        unfiled: wb["Not in a project"],
      },
      `the workbench's menu; it read ${JSON.stringify(wb)}`,
    ).toEqual({
      all: null,
      pa: "2",
      pb: "2",
      pz: "0",
      unfiled: expect.stringMatching(/^\d+$/),
    });
    await menu.getByRole("menuitem", { name: "All projects" }).click();
    await expect(
      filter,
      "the workbench's All face carries no count",
    ).toHaveText("All projects");
    await expect
      .poll(() => faceParts(filter), { message: "the workbench's All face parts" })
      .toEqual({
      name: "All projects",
      count: null,
    });
  });

  await test.step("the import line's two wordings", async () => {
    // Back on the map's own project: the short wording.
    await dialog.getByRole("button", { name: "Tables" }).click();
    await pickScope(PA);
    await dialog.getByRole("button", { name: "Files" }).click();
    await expect(
      dialog.getByText(`Imported datasets join ${PA}.`, { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("tab", { name: "From URL" }).click();
    await expect(
      dialog.getByText(`Imported datasets join ${PA}.`, { exact: true }),
    ).toBeVisible();
    // Under any other scope, the fuller wording says the trade.
    await dialog.getByRole("button", { name: "Tables" }).click();
    await pickScope("All projects");
    await dialog.getByRole("button", { name: "Files" }).click();
    await expect(
      dialog.getByText(`Imported datasets join ${PA}, this map's project.`, {
        exact: true,
      }),
    ).toBeVisible();
  });

  await test.step("an upload from the catalog files into the map's project", async () => {
    // The browsing scope is All right now — the import still joins the
    // map's project (the filter browses, it never redirects).
    await dialog.getByRole("tab", { name: "Upload file" }).click();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: `als_up_${runId}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(CSV),
    });
    await expect(page.getByRole("dialog", { name: "Add layer" })).toHaveCount(
      0,
      { timeout: 60_000 },
    );
    await expect
      .poll(async () => {
        const t = (await listing(page)).find(
          (x) => x.name === `als_up_${runId}`,
        );
        return t?.projectIds ?? null;
      })
      .toEqual([pa]);
  });

  await test.step("a URL import from the catalog files into the map's project", async () => {
    const fixtures = await startFixtureServer(31881, {
      files: { [`als_url_${runId}.csv`]: Buffer.from(CSV) },
    });
    try {
      dialog = await openCatalogTables(page);
      await dialog.getByRole("button", { name: "Files" }).click();
      await dialog.getByRole("tab", { name: "From URL" }).click();
      await dialog
        .getByRole("textbox")
        .first()
        .fill(`http://127.0.0.1:31881/files/als_url_${runId}.csv`);
      await dialog.getByRole("button", { name: /Import/ }).click();
      await expect(page.getByRole("dialog", { name: "Add layer" })).toHaveCount(
        0,
        { timeout: 60_000 },
      );
      await expect
        .poll(async () => {
          const t = (await listing(page)).find(
            (x) => x.name === `als_url_${runId}`,
          );
          return t?.projectIds ?? null;
        })
        .toEqual([pa]);
    } finally {
      await fixtures.close();
    }
  });

  await test.step("an unfiled map: All default, no line, unfiled import", async () => {
    await page.goto(`/maps/${map2Id}`);
    const d2 = await openCatalogTables(page);
    await expect(
      d2.getByRole("button", { name: "Filter by project" }),
    ).toContainText("All projects");
    await d2.getByRole("button", { name: "Files" }).click();
    await expect(d2.getByText("Imported datasets join")).toHaveCount(0);
    await d2.locator('input[type="file"]').setInputFiles({
      name: `als_up2_${runId}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(CSV),
    });
    await expect(page.getByRole("dialog", { name: "Add layer" })).toHaveCount(
      0,
      { timeout: 60_000 },
    );
    await expect
      .poll(async () => {
        const t = (await listing(page)).find(
          (x) => x.name === `als_up2_${runId}`,
        );
        return t?.projectIds ?? null;
      })
      .toEqual([]);
  });

  await test.step("the layer-source edit catalog carries the same default filter", async () => {
    await page.goto(`/maps/${mapId}`);
    const layerRow = page
      .locator("li", { hasText: new RegExp(`als_up_${runId}`) })
      .first();
    await layerRow
      .getByRole("button", { name: "Layer menu", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Edit source" }).click();
    const edit = page.getByRole("dialog", { name: /Layer source/ });
    await expect(edit).toBeVisible();
    const editFilter = edit.getByRole("button", { name: "Filter by project" });
    await expect(editFilter).toContainText(PA);
    await page.keyboard.press("Escape");
    await expect(edit).toBeHidden();
  });

  await test.step("a stale project refuses the upload and creates nothing", async () => {
    const pd = (
      (await api(page, "POST", "/api/projects", {
        name: `Doomed shelf ${runId}`,
      })) as { id: string }
    ).id;
    const map3 = (
      (await api(page, "POST", "/api/maps", {
        name: `Doomed map ${runId}`,
        projectId: pd,
      })) as { id: string }
    ).id;
    await page.goto(`/maps/${map3}`);
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    const d3 = page.getByRole("dialog", { name: "Add layer" });
    await expect(d3).toBeVisible();
    await api(page, "DELETE", `/api/projects/${pd}`);
    await d3.locator('input[type="file"]').setInputFiles({
      name: `als_stale_${runId}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(CSV),
    });
    // The road's own refusal, in the zone; the catalog stays open and
    // nothing was created or filed.
    await expect(d3.getByText(`No project with id ${pd}.`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(d3).toBeVisible();
    expect(
      (await listing(page)).find((x) => x.name === `als_stale_${runId}`),
    ).toBeUndefined();

    // Reopening the catalog re-reads the world: the deleted default
    // scope now has no row, so no filter face stands in for it (the
    // All-projects fallback) — the scoped refusal
    // shows alone, distinct.
    await page.keyboard.press("Escape");
    await expect(d3).toBeHidden();
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    await expect(d3).toBeVisible();
    await d3.getByRole("button", { name: "Tables" }).click();
    await expect(d3.getByText(`No project with id ${pd}.`)).toBeVisible();
    await expect(
      d3.getByRole("button", { name: "Filter by project" }),
    ).toHaveCount(0);
  });

  await test.step("a tool output's row carries no provenance line and its name reads in full; the catalog filter is as tall as the catalog search", async () => {
    // Seed one tool output the builder's own way: a buffer step, run.
    const outcome = await page.evaluate(
      async ({ input, name }) => {
        const post = async (path: string, body: unknown) =>
          (
            await fetch(path, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          ).json();
        const { recipe } = (await post("/api/recipes", {
          name: `${name}_wf`,
        })) as {
          recipe: { id: string };
        };
        (window as unknown as { __alsRecipe: string }).__alsRecipe = recipe.id;
        const { step } = (await post(`/api/recipes/${recipe.id}/steps`, {
          operation: "buffer",
          parameters: { input, distance: 10, name },
        })) as { step: { id: string } };
        const { run } = (await (
          await (async function readThenWriteWorkflowSetup() { const basis = await (await fetch(`/api/recipes/${recipe.id}`)).json(); return fetch(`/api/recipes/${recipe.id}/steps/${step.id}/run`, { headers: { "X-Edit-Revision": basis.editRevision },
            method: "POST",
          }); })()
        ).json()) as { run: { members: { jobId: string | null }[] } };
        const jobId = run.members[0]?.jobId;
        if (!jobId) return "accepted without an attempt";
        for (;;) {
          const r = await fetch(`/api/operations/runs/${jobId}`, {
            cache: "no-store",
          });
          const { run: view } = (await r.json()) as { run: { state: string } };
          if (["succeeded", "failed", "cancelled"].includes(view.state))
            return view.state;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      },
      { input: T_FREE, name: T_OUT },
    );
    expect(outcome, "the seeded buffer run").toBe("succeeded");
    // The seeded workflow and its output leave with the step, whatever
    // the step finds: a shared instance's other journeys count what the
    // Data page shows (the first red run left them behind).
    const cleanup = async () => {
      await page.keyboard.press("Escape").catch(() => {});
      const recipeId = await page.evaluate(
        () => (window as unknown as { __alsRecipe?: string }).__alsRecipe ?? "",
      );
      if (recipeId)
        await readThenWriteBrowserSetup(page, `/api/recipes/${recipeId}`, () => ({ method: "DELETE", path: `/api/recipes/${recipeId}` })).then(result => result.json).catch(() => {});
      await api(page, "DELETE", `/api/tables/${T_OUT}`).catch(() => {});
    };
    try {
      await page.goto(`/maps/${map2Id}`);
      const d4 = await openCatalogTables(page);
      const filter4 = d4.getByRole("button", { name: "Filter by project" });
      await filter4.click();
      await page.getByRole("menuitem", { name: "All projects" }).click();
      const outputs = d4.locator('[data-table-group="outputs"]');
      const outRow = outputs.getByRole("button", { name: T_OUT, exact: true });
      await expect(outRow).toBeVisible();
      // The explanation line is gone entirely, and the name is no longer
      // clipped by it.
      await expect(outRow).not.toContainText("made by");
      const clipped = await outRow
        .locator("span")
        .filter({ hasText: T_OUT })
        .first()
        .evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(clipped, "the output's name reads in full").toBe(false);
      // Page 17 A: the filter takes the catalog's own control height.
      const filterBox = (await filter4.boundingBox())!;
      const searchBox = (await d4.getByLabel("Search tables").boundingBox())!;
      expect(
        Math.abs(filterBox.height - searchBox.height),
        "the catalog filter is as tall as the catalog search",
      ).toBeLessThanOrEqual(1);
    } finally {
      await cleanup();
    }
  });
});

test("the three remote roads carry the project at their request boundary", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const sent: Record<string, unknown> = {};
  const refusal = {
    error: { code: "unavailable", message: "Stubbed by the journey." },
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  const connection = {
    id: "als-conn",
    name: "Stub geodata",
    host: "db.internal",
    port: 5432,
    database: "gis",
    username: "reader",
    ssl: true,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    status: "connected",
    lastCheckedAt: "2026-08-01T10:00:00.000Z",
    lastCheckError: null,
    serverVersion: "PostgreSQL 17.2",
    postgisVersion: "3.5.2",
  };
  const relation = {
    schema: "public",
    table: "roads",
    kind: "table",
    system: false,
    geometryColumn: "geom",
    geometryType: "POINT",
    srid: 4326,
    spatialKind: "geometry",
    approxRows: 3,
  };
  await routeHouse(context, {
    basemapStyleStub: true,
    handler: async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/imports/overture/releases") {
        await json(route, { releases: ["2026-08.0"] });
        return true;
      }
      if (pathname === "/api/imports/overture/count") {
        await json(route, { count: 42 });
        return true;
      }
      if (pathname === "/api/imports/overture" && method === "POST") {
        sent.overture = request.postDataJSON();
        await json(route, refusal, 503);
        return true;
      }
      if (pathname === "/api/imports/osm/preview" && method === "POST") {
        await json(route, refusal, 503);
        return true;
      }
      if (pathname === "/api/imports/osm" && method === "POST") {
        sent.osm = request.postDataJSON();
        await json(route, refusal, 503);
        return true;
      }
      if (pathname === "/api/connections/postgis" && method === "GET") {
        await json(route, [connection]);
        return true;
      }
      if (
        pathname === `/api/connections/postgis/${connection.id}/tables` &&
        method === "GET"
      ) {
        await json(route, { tables: [relation] });
        return true;
      }
      if (
        pathname === `/api/connections/postgis/${connection.id}/preview` &&
        method === "POST"
      ) {
        await json(route, {
          columns: [
            { name: "id", type: "INTEGER", spatialKind: null },
            { name: "geom", type: "GEOMETRY", spatialKind: "geometry" },
          ],
          rows: [{ id: 1, geom: "POINT(13.35 52.51)" }],
        });
        return true;
      }
      if (pathname === "/api/imports/postgis" && method === "POST") {
        sent.postgis = request.postDataJSON();
        await json(route, refusal, 503);
        return true;
      }
      return false;
    },
  });

  await page.goto("/maps");
  const pa = (
    (await api(page, "POST", "/api/projects", {
      name: `Boundary shelf ${runId}`,
    })) as { id: string }
  ).id;
  const mapId = (
    (await api(page, "POST", "/api/maps", {
      name: `Boundary map ${runId}`,
      projectId: pa,
    })) as { id: string }
  ).id;
  await page.goto(`/maps/${mapId}`);
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add layer" });
  await expect(dialog).toBeVisible();
  const line = `Imported datasets join Boundary shelf ${runId}.`;

  await test.step("Overture", async () => {
    await dialog.getByRole("button", { name: "Overture Maps" }).click();
    const note = dialog.getByText(line, { exact: true });
    await expect(note).toBeVisible();
    // Geometry, not mere visibility: Playwright's visibility misses
    // ancestor clipping, which is how the note first shipped rendered
    // below the dialog's fold.
    const noteBox = await note.boundingBox();
    const dlgBox = await dialog.boundingBox();
    expect(noteBox!.y + noteBox!.height).toBeLessThanOrEqual(
      dlgBox!.y + dlgBox!.height + 1,
    );
    await dialog.getByRole("button", { name: "Import as table" }).click();
    await expect.poll(() => sent.overture ?? null).not.toBeNull();
    expect((sent.overture as { projectId?: string }).projectId).toBe(pa);
  });

  await test.step("OpenStreetMap", async () => {
    await dialog.getByRole("button", { name: "OpenStreetMap" }).click();
    await expect(dialog.getByText(line, { exact: true })).toBeVisible();
    await dialog
      .getByRole("button", { name: "Buildings", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Import as table" }).click();
    await expect.poll(() => sent.osm ?? null).not.toBeNull();
    expect((sent.osm as { projectId?: string }).projectId).toBe(pa);
  });

  await test.step("PostGIS", async () => {
    await dialog.getByRole("button", { name: /^PostGIS/ }).click();
    await expect(dialog.getByText(line, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: /Stub geodata/ }).click();
    await dialog.getByRole("button", { name: /^roads/i }).click();
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect.poll(() => sent.postgis ?? null).not.toBeNull();
    expect((sent.postgis as { projectId?: string }).projectId).toBe(pa);
  });
});

// The import line under a 120-character unbroken project name wraps
// inside the dialog. The line is a stretched flex item, so its box stays
// inside the dialog whether the text wraps or not: the check that can go
// red is the overflow measurement (328 px before the rule, 0 after); the
// box checks guard the fold, not the wrap. The Add data dialog's sibling
// step (list-filter) has the box checks only — recorded as.
test("the import line wraps a 120-character unbroken project name inside the dialog", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");
  const longName = "x".repeat(120);
  const pl = (
    (await api(page, "POST", "/api/projects", { name: longName })) as {
      id: string;
    }
  ).id;
  const mapId = (
    (await api(page, "POST", "/api/maps", {
      name: `Long-named map ${runId}`,
      projectId: pl,
    })) as { id: string }
  ).id;
  try {
    await page.goto(`/maps/${mapId}`);
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add layer" });
    await expect(dialog).toBeVisible();
    // The catalog opens on Files, where the line sits under the upload zone.
    const note = dialog.getByText(`Imported datasets join ${longName}.`, {
      exact: true,
    });
    await expect(note).toBeVisible();
    const nb = (await note.boundingBox())!;
    const db = (await dialog.boundingBox())!;
    expect(
      nb.x + nb.width,
      "the line's right edge inside the dialog",
    ).toBeLessThanOrEqual(db.x + db.width + 1);
    expect(
      nb.y + nb.height,
      "the line's bottom inside the dialog",
    ).toBeLessThanOrEqual(db.y + db.height + 1);
    // The sentence is readable whole: no character clipped past the edge.
    const overflow = await note.evaluate(
      (el) => el.scrollWidth - el.clientWidth,
    );
    expect(overflow, "no horizontal overflow on the line").toBeLessThanOrEqual(
      0,
    );
  } finally {
    await api(page, "DELETE", `/api/projects/${pl}`);
  }
});
