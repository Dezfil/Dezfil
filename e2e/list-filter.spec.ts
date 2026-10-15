import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
// The project filter on the three lists (which takes the count off the
// All projects row and its face and leaves every other row's number
// where it was): the popover's truth (zero-count projects included; the
// Workflows counts stay workflow-origin and the builder filing is
// refused), composition with chips and search, the scoped heading
// sub-line, the address as the scope's home (reload, deep links,
// unknown/empty/deleted refusal, import-door preservation), scoped
// creation and its provisional default, the passive project facts. (The
// project home's section links left with; the lists' own filter is the
// path to a scoped list.) Residue-proof: counts assert against the
// API's own answers and order among this run's objects only.
import {
  test,
  expect,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { routeHouse, seedCsv, startFixtureServer } from "./support";

const runId = Date.now().toString(36);
const PA = `Berlin lanes ${runId}`;
const PB = `Atlas shelf ${runId}`;
const M1 = `Stations map ${runId}`;
const M2 = `Scratch map ${runId}`;
const W1 = `Lane density ${runId}`;
const W2 = `Loose ends ${runId}`;
const BUILDER = `Tool recipe ${runId}`;
const T_UP = `lf_up_${runId}`;
const T_LOOSE = `lf_loose_${runId}`;
const OUT = `lf_out_${runId}`;

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

const apiResult = (
  page: Page,
  method: string,
  pathName: string,
  body?: unknown,
  basis?: EditBasis,
) =>
  page.evaluate(
    async ({ method, pathName, body, basis }) => {
      const response = await fetch(pathName, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : undefined), ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = response.status === 204 ? "" : await response.text();
      return {
        status: response.status,
        body: text ? (JSON.parse(text) as unknown) : null,
      };
    },
    { method, pathName, body, basis },
  );

const filterButton = (page: Page) =>
  page.getByRole("button", { name: "Filter by project" });
const menuRow = (page: Page, name: string) =>
  page.getByRole("menuitem", { name: new RegExp(name) });
/* Every open row's printed count, keyed by the row's own name, read off
   the count ELEMENT and null when the row prints none; and the face's
   name and count the same way.

   A row's text is its project's name followed by its number, so
   `toContainText("3")` against the row matches any name holding a 3 —
   and these names carry a base-36 clock, which holds a 0 or a 2 about
   two runs in five. Such an assertion passes with the count element
   gone. Both readers take one pass once
   the subject is on screen, so a red run names every row rather than
   stopping at the first. */
const menuCounts = (page: Page): Promise<Record<string, string | null>> =>
  page
    .getByRole("menu", { name: "Filter by project" })
    .getByRole("menuitem")
    .evaluateAll((items) =>
      Object.fromEntries(
        items.map((el) => [
          (el.querySelector("[class*='rowName']")?.textContent ?? "").trim(),
          el.querySelector("[data-scope-count]")?.textContent?.trim() ?? null,
        ]),
      ),
    );
/* The face is read through expect.poll, never once: picking a scope
   navigates, and a single read after the click catches the face the
   pick is replacing. That shipped in this round's first draft and was
   caught by the conjunct-complete green run — "Workflows: the named
   scope's face" read "All projects" with no count. The menu reads need
   no poll: each follows a polling gate on the open menu's own rows, and
   nothing navigates between that gate and the read. */
const faceParts = (filter: Locator) =>
  filter.evaluate((el) => ({
    name: (el.querySelector("[class*='faceName']")?.textContent ?? "").trim(),
    count: el.querySelector("[data-scope-count]")?.textContent?.trim() ?? null,
  }));
/* The heading's second line: the paragraph after the title,
   present only when the list is narrowed or scoped. */
const subline = (page: Page) => page.locator("h1 + p");

test("the list filter across Maps, Workflows and Data", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");

  let pa = "";
  let pb = "";
  let w1 = "";
  await test.step("seed: two projects (one stays empty per list), filed and unfiled objects, a refused builder filing, a run output", async () => {
    pa = ((await api(page, "POST", "/api/projects", { name: PA })) as { id: string }).id;
    pb = ((await api(page, "POST", "/api/projects", { name: PB })) as { id: string }).id;
    await api(page, "POST", "/api/maps", { name: M1, projectId: pa });
    await api(page, "POST", "/api/maps", {
      name: `Depot map ${runId}`,
      projectId: pa,
    });
    await api(page, "POST", "/api/maps", { name: M2 });
    w1 = (
      (await api(page, "POST", "/api/recipes", {
        name: W1,
        projectId: pa,
      })) as { recipe: { id: string } }
    ).recipe.id;
    await api(page, "POST", "/api/recipes", { name: W2, origin: "workflow" });
    await api(page, "POST", "/api/recipes", {
      name: `Hex commutes ${runId}`,
      projectId: pa,
    });
    // The resolved fixture: a builder-origin recipe remains a valid
    // workspace object, but filing it into PA is a coded refusal.
    const builder = (
      (await api(page, "POST", "/api/recipes", {
        name: BUILDER,
        origin: "builder",
      })) as { recipe: { id: string } }
    ).recipe.id;
    const refused = await apiResult(
      page,
      "PATCH",
      `/api/projects/${pa}/members`,
      { addRecipes: [builder], expectedRevisions: { [`workflow:${builder}`]: ((await api(page, "GET", `/api/recipes/${builder}`)) as { recipe: { editRevision: string } }).recipe.editRevision } },
    );
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      error: {
        code: "invalid_request",
        message: expect.stringContaining(
          "Only workflows can be project members.",
        ),
      },
    });
    const builders = (await api(
      page,
      "GET",
      "/api/recipes?origin=builder",
    )) as { recipes: { id: string; projectId: string | null }[] };
    expect(
      builders.recipes.find((recipe) => recipe.id === builder)?.projectId,
    ).toBeNull();
    await seedCsv(page, T_UP, "name,lng,lat\nBuoy A,7.10,53.52\n");
    await seedCsv(page, T_LOOSE, "name,lng,lat\nBuoy B,7.22,53.44\n");
    const tables = (await api(page, "GET", "/api/tables")) as {
      id: string;
      name: string;
    }[];
    const up = tables.find((t) => t.name === T_UP)!.id;
    await api(page, "PATCH", `/api/projects/${pa}/members`, {
      addTables: [up],
    });
    await api(page, "PATCH", `/api/projects/${pb}/members`, {
      addTables: [up],
    });
    // A run output joins its workflow's project with source "operation",
    // giving the scope a second source kind for the chip fallback.
    const step = (
      (await readThenWriteBrowserSetup(page, `/api/recipes/${w1}`, () => ({ method: "POST", path: `/api/recipes/${w1}/steps`, body: {
        operation: "sql_step",
        parameters: { sql: `SELECT * FROM ${T_UP}`, name: OUT },
      } })).then(result => result.json)) as { step: { id: string } }
    ).step.id;
    await readThenWriteBrowserSetup(page, `/api/recipes/${w1}`, () => ({ method: "POST", path: `/api/recipes/${w1}/runs`, body: { members: [step] } })).then(result => result.json);
    await expect
      .poll(
        async () => {
          const r = (await api(page, "GET", `/api/recipes/${w1}`)) as {
            recipe: { steps: { latestAttempt: { state: string } | null }[] };
          };
          return r.recipe.steps[0]?.latestAttempt?.state ?? "none";
        },
        { timeout: 60_000 },
      )
      .toBe("succeeded");
  });

  await test.step("Maps: the popover's truth, scoping, the sub-line, tags, search", async () => {
    await page.goto("/maps");
    // The view preference is workspace-global; this step's subjects
    // (the ghost tile, the card tags) live in the grid.
    await page.getByRole("button", { name: "Grid view" }).click();
    const maps = (await api(page, "GET", "/api/maps")) as {
      projectId: string | null;
    }[];
    const inPa = maps.filter((m) => m.projectId === pa).length;
    const unfiled = maps.filter((m) => !m.projectId).length;
    // With the scope unset the face reads the name alone, and so
    // does the All row in the open menu. Every other row keeps its
    // number, below.
    await expect(
      filterButton(page),
      "the unset scope's face carries no count",
    ).toHaveText("All projects");
    await filterButton(page).click();
    // The All row's total was asserted here; the count came off the All row
    // alone, so the row is checked positively — it is there, in its
    // place, under its own name — and asserted to carry nothing else.
    // Every other row still carries its number, below.
    await expect(
      menuRow(page, "All projects"),
      "the All row is there, its name alone",
    ).toHaveText("All projects");
    // Every row this step is about, in one comparison off the count
    // elements, so a seeded defect is proven against each of them.
    const mapCounts = await menuCounts(page);
    expect(
      {
        all: mapCounts["All projects"],
        pa: mapCounts[PA],
        pb: mapCounts[PB],
        unfiled: mapCounts["Not in a project"],
      },
      `Maps: All silent, the rest counting; the menu read ${JSON.stringify(mapCounts)}`,
    ).toEqual({
      all: null,
      pa: String(inPa),
      pb: "0",
      unfiled: String(unfiled),
    });
    await menuRow(page, PA).click();
    await expect(page).toHaveURL(new RegExp(`project=${pa}`));
    // The named scope keeps its count on the face too.
    await expect
      .poll(() => faceParts(filterButton(page)), { message: "Maps: the named scope's face" })
      .toEqual({ name: PA, count: `· ${inPa}` });
    await expect(subline(page)).toHaveText(`${inPa} in ${PA}`);
    await expect(page.getByText(M1)).toBeVisible();
    await expect(page.getByText(M2)).toHaveCount(0);
    // The passive tag and the scoped New tile's face.
    await expect(page.getByText(PA).first()).toBeVisible();
    await expect(page.getByText(`in ${PA}`, { exact: true })).toBeVisible();
    // A search inside the scope says what is shown of what.
    await page.getByLabel("Search maps").fill("Depot");
    await expect(subline(page)).toHaveText(`1 of ${inPa} in ${PA} shown`);
    // A zero match says so too, beside the no-match state.
    await page.getByLabel("Search maps").fill("zzz-nothing");
    await expect(page.getByText("No maps match", { exact: false })).toBeVisible();
    await expect(subline(page)).toHaveText(`0 of ${inPa} in ${PA} shown`);
    await page.getByLabel("Search maps").fill("");
  });

  await test.step("Maps: scoped New files at birth; unfiled scope creates unfiled", async () => {
    await page
      .getByRole("button", { name: new RegExp(`New map in ${PA}`) })
      .click();
    await page.waitForURL(/\/maps\/[0-9a-f-]+$/);
    const createdId = page.url().split("/").pop()!;
    const created = (await api(page, "GET", `/api/maps/${createdId}`)) as {
      projectId: string | null;
    };
    expect(created.projectId).toBe(pa);
    await readThenWriteBrowserSetup(page, `/api/maps/${createdId}`, () => ({ method: "DELETE", path: `/api/maps/${createdId}` }));
    await page.goto("/maps?project=none");
    // The unfiled scope's face on Maps, where this step already stands
    // under it. Its value is residue-bound on a shared instance, so the
    // assertion is that a number is printed.
    await expect
      .poll(() => faceParts(filterButton(page)), {
        message: "Maps: the unfiled scope's face keeps a count",
      })
      .toEqual({
        name: "Not in a project",
        count: expect.stringMatching(/^·\s*\d+$/),
      });
    await page
      .getByRole("button", { name: /New map not in a project/ })
      .click();
    await page.waitForURL(/\/maps\/[0-9a-f-]+$/);
    const looseId = page.url().split("/").pop()!;
    const loose = (await api(page, "GET", `/api/maps/${looseId}`)) as {
      projectId: string | null;
    };
    expect(loose.projectId).toBeNull();
    await readThenWriteBrowserSetup(page, `/api/maps/${looseId}`, () => ({ method: "DELETE", path: `/api/maps/${looseId}` }));
  });

  await test.step("Maps: the scope survives a reload; unknown, empty and deleted scopes refuse", async () => {
    await page.goto(`/maps?project=${pa}`);
    await expect(subline(page)).toContainText(`in ${PA}`);
    await page.reload();
    await expect(subline(page)).toContainText(`in ${PA}`);
    // An unknown project and one the caller does not reach answer alike,
    // so the refusal does not say which.
    const absent = page
      .getByRole("alert")
      .getByText("The requested resource was not found.");
    await page.goto("/maps?project=ghost-id");
    await expect(absent).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByText(M2)).toHaveCount(0);
    await page.goto("/maps?project=");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByText(M2)).toHaveCount(0);
    const doomed = (
      (await api(page, "POST", "/api/projects", {
        name: `Doomed ${runId}`,
      })) as { id: string }
    ).id;
    await page.goto(`/maps?project=${doomed}`);
    await expect(subline(page)).toContainText(`in Doomed ${runId}`);
    await api(page, "DELETE", `/api/projects/${doomed}`);
    await page.reload();
    await expect(absent).toBeVisible();
    await expect(page.getByText(M2)).toHaveCount(0);
  });

  await test.step("Workflows: counts and results stay workflow-origin, the builder filing refused; scoped New files at birth", async () => {
    await page.goto("/workflows");
    const listed = (await api(page, "GET", "/api/recipes?origin=workflow")) as {
      recipes: { projectId: string | null }[];
    };
    const inPa = listed.recipes.filter((w) => w.projectId === pa).length;
    // Names: the unset face reads the name alone.
    await expect
      .poll(() => faceParts(filterButton(page)), { message: "Workflows: the unset scope's face" })
      .toEqual({ name: "All projects", count: null });
    await filterButton(page).click();
    await expect(
      menuRow(page, "All projects"),
      "Workflows: the All row, its name alone",
    ).toHaveText("All projects");
    // The refused BUILDER filing must not count: PA holds exactly the
    // workflow-origin members.
    const inPb = listed.recipes.filter((w) => w.projectId === pb).length;
    const unfiled = listed.recipes.filter((w) => !w.projectId).length;
    const wfCounts = await menuCounts(page);
    // Every row the open menu shows is compared, not a subset of it:
    // collecting a value into the failure message is not asserting it.
    expect(
      {
        all: wfCounts["All projects"],
        pa: wfCounts[PA],
        pb: wfCounts[PB],
        unfiled: wfCounts["Not in a project"],
      },
      `Workflows: the menu read ${JSON.stringify(wfCounts)}`,
    ).toEqual({
      all: null,
      pa: String(inPa),
      pb: String(inPb),
      unfiled: String(unfiled),
    });
    await menuRow(page, PA).click();
    await expect
      .poll(() => faceParts(filterButton(page)), { message: "Workflows: the named scope's face keeps its count" })
      .toEqual({ name: PA, count: `· ${inPa}` });
    await expect(page.getByText(W1)).toBeVisible();
    await expect(page.getByText(BUILDER)).toHaveCount(0);
    await expect(subline(page)).toHaveText(`${inPa} in ${PA}`);
    // The screen's own chips count inside the scope.
    await expect(
      page.getByRole("button", { name: new RegExp(`All · ${inPa}`) }),
    ).toBeVisible();
    // Search composes: what is shown of what, a zero match included.
    await page.getByLabel("Search workflows").fill("Hex");
    await expect(subline(page)).toHaveText(`1 of ${inPa} in ${PA} shown`);
    await page.getByLabel("Search workflows").fill("zzz-none");
    await expect(subline(page)).toHaveText(`0 of ${inPa} in ${PA} shown`);
    await page.getByLabel("Search workflows").fill("");
    // Scoped New through the dialog files at birth.
    await page.getByRole("button", { name: "New workflow", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(`Scoped wf ${runId}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/\/workflows\/[0-9a-f-]+$/);
    const wfId = page.url().split("/").pop()!;
    const made = (await api(page, "GET", `/api/recipes/${wfId}`)) as {
      recipe: { projectId: string | null };
    };
    expect(made.recipe.projectId).toBe(pa);
    await readThenWriteBrowserSetup(page, `/api/recipes/${wfId}`, () => ({ method: "DELETE", path: `/api/recipes/${wfId}` })).then(result => result.json);
  });

  await test.step("Data: the unset scope's face and its All row", async () => {
    // The third of the four surfaces. The Data page's
    // datasets are many-to-many, so its counts come from the API's own
    // answers per project rather than being assumed.
    await page.goto("/data");
    const tables = (await api(page, "GET", "/api/tables")) as {
      projectIds: string[];
    }[];
    const inPa = tables.filter((t) => t.projectIds.includes(pa)).length;
    const inPb = tables.filter((t) => t.projectIds.includes(pb)).length;
    const unfiled = tables.filter((t) => t.projectIds.length === 0).length;
    await expect
      .poll(() => faceParts(filterButton(page)), { message: "Data: the unset scope's face" })
      .toEqual({ name: "All projects", count: null });
    await filterButton(page).click();
    await expect(
      menuRow(page, "All projects"),
      "Data: the All row, its name alone",
    ).toHaveText("All projects");
    const dataCounts = await menuCounts(page);
    expect(
      {
        all: dataCounts["All projects"],
        pa: dataCounts[PA],
        pb: dataCounts[PB],
        unfiled: dataCounts["Not in a project"],
      },
      `Data: the menu read ${JSON.stringify(dataCounts)}`,
    ).toEqual({
      all: null,
      pa: String(inPa),
      pb: String(inPb),
      unfiled: String(unfiled),
    });
    await menuRow(page, PA).click();
    await expect
      .poll(() => faceParts(filterButton(page)), { message: "Data: the named scope's face keeps its count" })
      .toEqual({ name: PA, count: `· ${inPa}` });
  });

  await test.step("Data: the Project column, chip fallback in scope, import-door preservation", async () => {
    await page.goto(`/data?project=${pa}`);
    // The Project column lives in the list view.
    await page.getByRole("button", { name: "List view" }).click();
    // The shared dataset names only its OTHER membership under PA.
    const row = page.locator(`[data-table-row="${T_UP}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(`also in ${PB}`);
    // The run output followed its workflow into PA with its own source,
    // so the scope holds two source kinds; Results is pickable.
    await page.getByRole("button", { name: /Results/ }).click();
    // The output folds under its producer; unfold to reach it.
    await page
      .getByRole("button", { name: new RegExp(`${W1}, workflow`) })
      .click();
    await expect(page.locator(`[data-table-row="${OUT}"]`)).toBeVisible();
    await expect(row).toHaveCount(0);
    // Scoping to unfiled hides the Results source entirely: the active
    // chip falls back to All and the unfiled dataset shows.
    await filterButton(page).click();
    await menuRow(page, "Not in a project").click();
    // The unfiled scope keeps its count on the face too. The value is
    // residue-bound on a shared instance, so the assertion is that a
    // number is printed, not which one.
    await expect
      .poll(() => faceParts(filterButton(page)), { message: "the unfiled scope's face keeps a count" })
      .toEqual({
      name: "Not in a project",
      count: expect.stringMatching(/^·\s*\d+$/),
    });
    // Residue-proof: the Results source exists under the unfiled scope
    // exactly when the API lists an unfiled operation output. This run
    // files its own output into PA, so a fresh instance has none; a
    // shared instance's count follows the API's own answer.
    const unfiledResults = (
      (await api(page, "GET", "/api/tables?project=none")) as {
        source: string;
      }[]
    ).some((t) => t.source === "operation");
    await expect(page.getByRole("button", { name: /Results/ })).toHaveCount(
      unfiledResults ? 1 : 0,
    );
    await expect(page.locator(`[data-table-row="${OUT}"]`)).toHaveCount(0);
    // On a shared instance the Results chip may stay active over residue;
    // every source, so the loose upload is in the list either way.
    if (unfiledResults) {
      await page
        .getByRole("group", { name: "Filter tables" })
        .getByRole("button", { name: /^All/ })
        .click();
    }
    const loose = page.locator(`[data-table-row="${T_LOOSE}"]`);
    await expect(loose).toBeVisible();
    await expect(loose).toContainText("not in a project");
    // Data search composes with the scope and the heading follows.
    await filterButton(page).click();
    await menuRow(page, PA).click();
    const scopedDatasets = ((await api(
      page,
      "GET",
      `/api/tables?project=${pa}`,
    )) as unknown[]).length;
    await page.getByLabel("Search data").fill(T_UP);
    await expect(subline(page)).toHaveText(
      `1 of ${scopedDatasets} in ${PA} shown`,
    );
    await page.getByLabel("Search data").fill("zzz-none");
    await expect(subline(page)).toHaveText(
      `0 of ${scopedDatasets} in ${PA} shown`,
    );
    await page.getByLabel("Search data").fill("");
    // Unrelated address state survives a scope change.
    await page.goto("/data?zzunrelated=1");
    await filterButton(page).click();
    await menuRow(page, PA).click();
    await expect(page).toHaveURL(/zzunrelated=1/);
    await expect(page).toHaveURL(new RegExp(`project=${pa}`));
  });

  await test.step("the filter's geometry beside the search at both contract viewports; the popover under its left edge", async () => {
    // The reference (page 12 A): a chrome-height control, as tall as the
    // search beside it and top-aligned with it; its popover opens under
    // its own left edge. The field round saw a shorter chip and, on
    // Data Explorer, a popover shifted left of it.
    const lists: [string, string][] = [
      ["/maps", "Search maps"],
      ["/workflows", "Search workflows"],
      ["/data", "Search data"],
    ];
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      for (const [route, searchLabel] of lists) {
        await page.goto(route);
        const trigger = filterButton(page);
        // The search's box, not its inner input: the control the
        // reference measures against.
        const search = page.getByLabel(searchLabel).locator("xpath=..");
        await expect(trigger).toBeVisible();
        const t = (await trigger.boundingBox())!;
        const s = (await search.boundingBox())!;
        expect(
          Math.abs(t.height - s.height),
          `${route} at ${viewport.width}: the filter is as tall as the search`,
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(t.y - s.y),
          `${route} at ${viewport.width}: the filter's top edge aligns with the search`,
        ).toBeLessThanOrEqual(1);
        await trigger.click();
        const menu = page.getByRole("menu", { name: "Filter by project" });
        await expect(menu).toBeVisible();
        const m = (await menu.boundingBox())!;
        expect(
          Math.abs(m.x - t.x),
          `${route} at ${viewport.width}: the popover opens under the trigger's left edge`,
        ).toBeLessThanOrEqual(1);
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  });
});

// The Data page's imports under a project scope: the tile names the
// scope, the dialog says where imports land on all five surfaces and
// keeps the sentence inside the dialog, the upload and URL roads file the
// dataset into the scope, the three remote roads carry it at their
// request boundary (the request is what is measured; the fixture
// refuses), and both unfiled scopes stay unfiled. Criterion assertions
// are soft so one run against main reports every red; flow prerequisites
// stay hard.
test("Data: imports under a project scope join it, said on the tile and in the dialog", async ({
  page,
  context,
}) => {
  test.setTimeout(420_000);
  const PD = `Depot shelf ${runId}`;
  const T_PD = `lf_pd_${runId}`;
  const T_URL = `lf_url_${runId}`;
  const T_ALL = `lf_all_${runId}`;
  const T_NONE = `lf_none_${runId}`;
  const sent: Record<string, unknown> = {};
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  const refusal = {
    error: {
      code: "egress_blocked",
      message: "The fixture refuses; the request is what is measured.",
    },
  };
  const connection = {
    id: "lf-conn",
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
  const fixture = await startFixtureServer(31881, {
    files: { [`${T_URL}.csv`]: Buffer.from("name,lng,lat\nBuoy U,7.30,53.40\n") },
  });
  try {
    await page.goto("/maps");
    const pd = (
      (await api(page, "POST", "/api/projects", { name: PD })) as { id: string }
    ).id;
    const line = `Imported datasets join ${PD}.`;
    const membership = async (name: string) => {
      const rows = (await api(page, "GET", "/api/tables")) as {
        name: string;
        projectIds: string[];
      }[];
      return rows.find((t) => t.name === name)?.projectIds ?? null;
    };
    const addDataButton = () =>
      page.getByRole("button", { name: "Add data", exact: true });
    const dialog = () => page.getByRole("dialog", { name: "Add data" });
    const closeDialog = async () => {
      await dialog().getByRole("button", { name: "Close" }).click();
      await expect(dialog()).toHaveCount(0);
    };
    const csv = (who: string) =>
      Buffer.from(`name,lng,lat\n${who},7.12,53.50\n`);

    await test.step("the tile names the scope like the Maps tile (12-A)", async () => {
      // The view preference is workspace-global (the test above ends in
      // list view): the populated presentations need the grid. The view
      // toggle renders with the screen, which can arrive after the page's
      // load event, so the click waits for it rather than counting it.
      const gridView = () =>
        page.getByRole("button", { name: "Grid view", exact: true }).click();
      await page.goto(`/data?project=${pd}`);
      // Resolved-empty presentation: the project holds no dataset yet.
      await expect
        .soft(page.getByRole("button", { name: `Add data in ${PD}` }))
        .toBeVisible();
      await page.goto("/data?project=none");
      await gridView();
      await expect
        .soft(
          page
            .getByRole("button", { name: /^Add data not in a project$/ })
            .first(),
        )
        .toBeVisible();
      await page.goto("/data");
      await gridView();
      await expect
        .soft(
          page
            .getByRole("button", {
              name: /^Add data Upload a file or import from a source$/,
            })
            .first(),
        )
        .toBeVisible();
    });

    await test.step("the dialog says where imports land, on all five surfaces, inside the dialog", async () => {
      await page.goto(`/data?project=${pd}`);
      await addDataButton().click();
      await expect(dialog()).toBeVisible();
      const contained = async (surface: string) => {
        const note = dialog().getByText(line, { exact: true });
        await expect.soft(note, `${surface}: the destination sentence`).toBeVisible();
        // Geometry, not mere visibility: visibility misses ancestor
        // clipping (the catalog's own lesson, add-layer-scope).
        const noteBox = await note.boundingBox().catch(() => null);
        const dlgBox = await dialog().boundingBox();
        if (noteBox && dlgBox) {
          expect
            .soft(noteBox.y + noteBox.height, `${surface}: inside the dialog`)
            .toBeLessThanOrEqual(dlgBox.y + dlgBox.height + 1);
        }
      };
      await contained("Upload");
      await dialog().getByRole("tab", { name: "From URL" }).click();
      await contained("URL");
      await dialog().getByRole("button", { name: "Overture Maps" }).click();
      await contained("Overture");
      await dialog().getByRole("button", { name: "OpenStreetMap" }).click();
      await contained("OpenStreetMap");
      await dialog().getByRole("button", { name: /^PostGIS/ }).click();
      await contained("PostGIS");
      await closeDialog();
    });

    await test.step("the three remote roads carry the scope at their request boundary", async () => {
      await page.goto(`/data?project=${pd}`);
      await addDataButton().click();
      await expect(dialog()).toBeVisible();
      await dialog().getByRole("button", { name: "Overture Maps" }).click();
      await dialog().getByRole("button", { name: "Import as table" }).click();
      await expect.poll(() => sent.overture ?? null).not.toBeNull();
      expect.soft((sent.overture as { projectId?: string }).projectId).toBe(pd);
      await dialog().getByRole("button", { name: "OpenStreetMap" }).click();
      await dialog().getByRole("button", { name: "Buildings", exact: true }).click();
      await dialog().getByRole("button", { name: "Import as table" }).click();
      await expect.poll(() => sent.osm ?? null).not.toBeNull();
      expect.soft((sent.osm as { projectId?: string }).projectId).toBe(pd);
      await dialog().getByRole("button", { name: /^PostGIS/ }).click();
      await dialog().getByRole("button", { name: /Stub geodata/ }).click();
      await dialog().getByRole("button", { name: /^roads/i }).click();
      await dialog().getByRole("button", { name: "Import", exact: true }).click();
      await expect.poll(() => sent.postgis ?? null).not.toBeNull();
      expect.soft((sent.postgis as { projectId?: string }).projectId).toBe(pd);
      await closeDialog();
    });

    await test.step("an upload through the dialog lands filed in the scope; the URL road too", async () => {
      await page.goto(`/data?project=${pd}`);
      await addDataButton().click();
      await dialog()
        .locator('input[type="file"]')
        .setInputFiles({ name: `${T_PD}.csv`, mimeType: "text/csv", buffer: csv("Buoy P") });
      await expect.poll(() => membership(T_PD), { timeout: 60_000 }).not.toBeNull();
      expect.soft(await membership(T_PD), "the upload's membership").toEqual([pd]);
      // A clean batch closes the host; the dataset is in the scoped list.
      await expect(dialog()).toHaveCount(0, { timeout: 30_000 });
      // The card itself, not the ready notice that also names the table: its Open link, and the
      // scoped listing's own answer.
      await expect
        .soft(page.getByRole("link", { name: `Open ${T_PD}` }))
        .toBeVisible();
      const scoped = (await api(page, "GET", `/api/tables?project=${pd}`)) as {
        name: string;
      }[];
      expect.soft(scoped.map((t) => t.name)).toContain(T_PD);
      // The populated presentation under P carries the same sub-line.
      const gridBtn = page.getByRole("button", { name: "Grid view", exact: true });
      if ((await gridBtn.count()) > 0) await gridBtn.click();
      await expect
        .soft(page.getByRole("button", { name: `Add data in ${PD}` }).first())
        .toBeVisible();
      await addDataButton().click();
      await dialog().getByRole("tab", { name: "From URL" }).click();
      await dialog()
        .getByPlaceholder(/^https:/)
        .fill(`${fixture.origin}/files/${T_URL}.csv`);
      await dialog().getByPlaceholder("derived from the URL").fill(T_URL);
      await dialog().getByRole("button", { name: "Import as table" }).click();
      await expect.poll(() => membership(T_URL), { timeout: 60_000 }).not.toBeNull();
      expect.soft(await membership(T_URL), "the URL import's membership").toEqual([pd]);
      if ((await dialog().count()) > 0) await closeDialog();
    });

    await test.step("a 120-character unbroken project name wraps inside the dialog", async () => {
      const longName = "x".repeat(120);
      const pl = (
        (await api(page, "POST", "/api/projects", { name: longName })) as { id: string }
      ).id;
      await page.goto(`/data?project=${pl}`);
      await addDataButton().click();
      await expect(dialog()).toBeVisible();
      const note = dialog().getByText(`Imported datasets join ${longName}.`, { exact: true });
      await expect(note).toBeVisible();
      const nb = (await note.boundingBox())!;
      const db = (await dialog().boundingBox())!;
      expect.soft(nb.x + nb.width, "the note's right edge inside the dialog").toBeLessThanOrEqual(db.x + db.width + 1);
      expect.soft(nb.y + nb.height, "the note's bottom inside the dialog").toBeLessThanOrEqual(db.y + db.height + 1);
      // A stretched flex item's box stays contained even when its text
      // overflows. Removing .scopeNote's wrapping rule must fail here.
      const overflow = await note.evaluate((el) => el.scrollWidth - el.clientWidth);
      console.log(`Add data wrap: overflow=${overflow}px`);
      expect.soft(overflow, "no horizontal text overflow on the note").toBeLessThanOrEqual(0);
      await closeDialog();
      await api(page, "DELETE", `/api/projects/${pl}`);
    });

    await test.step("under All projects and Not in a project the same upload stays unfiled", async () => {
      for (const [address, name] of [
        ["/data", T_ALL],
        ["/data?project=none", T_NONE],
      ] as const) {
        await page.goto(address);
        await addDataButton().click();
        await expect(dialog()).toBeVisible();
        await expect
          .soft(dialog().getByText(/^Imported datasets join /), `${address}: no sentence`)
          .toHaveCount(0);
        await dialog()
          .locator('input[type="file"]')
          .setInputFiles({ name: `${name}.csv`, mimeType: "text/csv", buffer: csv("Buoy Z") });
        await expect.poll(() => membership(name), { timeout: 60_000 }).not.toBeNull();
        expect.soft(await membership(name), `${address}: unfiled`).toEqual([]);
        await expect(dialog()).toHaveCount(0, { timeout: 30_000 });
      }
      const unfiled = (await api(page, "GET", "/api/tables?project=none")) as {
        name: string;
      }[];
      expect
        .soft(unfiled.map((t) => t.name))
        .toEqual(expect.arrayContaining([T_ALL, T_NONE]));
    });
  } finally {
    await fixture.close();
  }
});
