import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
// The Projects screens: the list per page 05 (creation through both
// affordances under the name contract, search and the three sorts, both
// views, rename and dissolution from cards and rows, the unfiled
// summary, empty and filtered-empty kept distinct) and the home per
// page 13 (heading with note edit and the stats line, the crumb rename
// with refusals said, dissolution returning to Projects, the sections
// opening their objects, a shared dataset naming its other membership,
// the attention area over the shared run interaction, the missing
// state). Suite-residue-proof for the shared full-suite environment:
// the empty state is driven at the network boundary, the unfiled counts
// assert the strip against the API's own answer, and order assertions
// compare this run's projects among themselves.
//
// The partial-size fixture rides a second test gated on
// DEZFIL_DATA_DIR (the runner must reach the server's files) and
// skips visibly without it.
import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import { rename as fsRename } from "node:fs/promises";
import path from "node:path";
import { routeHouse, seedCsv } from "./support";

const runId = Date.now().toString(36);
const T1 = `pj_one_${runId}`;
const T2 = `pj_two_${runId}`;
const P1 = `Berlin mobility ${runId}`;
const P2 = `Flood atlas ${runId}`;
const P3 = `Coast survey ${runId}`;
const RENAMED = `Depot study ${runId}`;

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

const cardNamed = (page: Page, name: string) =>
  page.locator("article").filter({ hasText: name }).first();

const createViaDialog = async (page: Page, name: string) => {
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
};

test("departed project-home continuations keep project B clean", async ({ page, context }) => {
  await routeHouse(context, { basemapStyleStub: true });
  const settings = await page.request.patch("/api/settings", {
    data: { viewPrefs: { projects: { view: "grid" }, maps: { view: "grid" } } },
  });
  expect(settings.ok()).toBe(true);
  const nameA = `Continuation A ${runId}`;
  const nameB = `Continuation B ${runId}`;
  const renamed = `Continuation saved ${runId}`;
  const mapName = `Continuation map ${runId}`;
  const made: string[] = [];
  let mapId = "";
  let changes = 0;
  await page.exposeFunction("projectChangeObserved", () => { changes++; });
  await page.goto("/projects");
  try {
    const project = async (name: string) => {
      const result = (await api(page, "POST", "/api/projects", { name })) as { id: string };
      made.push(result.id);
      return result.id;
    };
    const a = await project(nameA);
    const b = await project(nameB);
    mapId = ((await api(page, "POST", "/api/maps", { name: mapName, projectId: a })) as { id: string }).id;
    // Prime the shared name cache with A's old name. Every navigation after
    // this is client-side: a full document load would erase the regression.
    await page.goto(`/maps/${mapId}`);
    const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumb.getByRole("link", { name: nameA, exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.addEventListener("dezfil:projects-changed", () => {
        void (window as typeof window & { projectChangeObserved: () => Promise<void> }).projectChangeObserved();
      });
    });
    await crumb.getByRole("link", { name: nameA, exact: true }).click();
    await expect(page.getByRole("heading", { name: nameA, exact: true })).toBeVisible();

    const cleanB = async () => {
      await expect(page).toHaveURL(new RegExp(`/projects/${b}$`));
      await expect(page.getByRole("heading", { name: nameB, exact: true })).toBeVisible();
      await expect(crumb).toContainText(nameB);
      await expect(page.getByRole("status")).toHaveCount(0);
      // Next's persistent route announcer is also an alert; only exclude
      // that framework node, so every app error still fails this check.
      await expect(page.getByRole("alert").and(page.locator(":not(#__next-route-announcer__)"))).toHaveCount(0);
      await expect(page.getByText("The change was saved, but the project couldn't be re-read.")).toHaveCount(0);
      await expect(page.getByLabel("Project name", { exact: true })).toHaveCount(0);
    };
    const toB = async () => {
      await crumb.getByRole("link", { name: "Projects", exact: true }).click();
      await page.getByRole("link", { name: `Open ${nameB}`, exact: true }).click();
      await cleanB();
    };
    const heldMutation = async (pathname: string, body: unknown, start: () => Promise<void>) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = false;
      let delivery: Promise<void> | undefined;
      const before = changes;
      const handler = (route: Route) => {
        // Claim exactly one PATCH before yielding; later requests to the
        // same path pass through without joining this hold.
        if (route.request().method() !== "PATCH" || delivery) return route.fallback();
        delivery = (async () => {
          expect(route.request().postDataJSON()).toEqual(body);
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          held = true; // The server committed; only the browser's reply is held.
          await gate;
          await route.fulfill({ response });
        })();
        return delivery;
      };
      await page.route(`**${pathname}`, handler);
      try {
        await start();
        await expect.poll(() => held).toBe(true);
        expect(changes).toBe(before);
        await toB();
        release();
        await delivery;
        // Positive settlement witness: assertions about absent effects run
        // after the production continuation has processed the held reply.
        await expect.poll(() => changes).toBe(before + 1);
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await cleanB();
      } finally {
        release();
        try {
          // Removing the final page route can continue its in-flight request.
          // Drain our fulfillment first, including when a B assertion fails.
          await delivery;
        } finally {
          await page.unroute(`**${pathname}`, handler);
        }
      }
    };

    await test.step("a held rename settles after departure; B stays clean and the next map breadcrumb uses the saved name", async () => {
      await heldMutation(`/api/projects/${a}`, { name: renamed }, async () => {
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
        await page.getByLabel("Project name", { exact: true }).fill(renamed);
        await page.keyboard.press("Enter");
      });
      await page.getByRole("link", { name: "Maps", exact: true }).click();
      await page.getByRole("link", { name: `Open ${mapName}`, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/maps/${mapId}$`));
      await expect(crumb.getByRole("link", { name: renamed, exact: true })).toBeVisible();
      await expect(crumb).not.toContainText(nameA);
      await expect(page).toHaveTitle(new RegExp(`${mapName} · ${renamed} · `));
    });

    await test.step("a held recent Add settles after departure without a notice, stale banner or redirect in B", async () => {
      await api(page, "PATCH", `/api/projects/${a}/members`, { removeMaps: [mapId] });
      // Keep this fixture first in Recent even on a residue-bearing instance;
      // the membership PATCH and all scoped reads still reach the server.
      const recent = async (route: Route) => {
        const response = await route.fetch();
        const maps = (await response.json()) as { id: string; updatedAt: string }[];
        await route.fulfill({ response, json: maps.map((map) => map.id === mapId
          ? { ...map, updatedAt: "9999-01-01T00:00:00.000Z" } : map) });
      };
      await page.route("**/api/maps", recent);
      try {
        await crumb.getByRole("link", { name: renamed, exact: true }).click();
        await expect(page.locator("[data-empty-plate]")).toBeVisible();
        await heldMutation(`/api/projects/${a}/members`, { addMaps: [mapId] }, async () => {
          await page.getByRole("button", { name: `Add ${mapName}`, exact: true }).click();
        });
        const saved = (await api(page, "GET", `/api/maps/${mapId}`)) as { projectId: string };
        expect(saved.projectId).toBe(a);
      } finally {
        await page.unroute("**/api/maps", recent);
      }
    });

    await test.step("an unsubmitted name draft from A does not survive into B", async () => {
      await crumb.getByRole("link", { name: "Projects", exact: true }).click();
      await page.getByRole("link", { name: `Open ${renamed}`, exact: true }).click();
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      const draft = `Unsubmitted A draft ${runId}`;
      await page.getByLabel("Project name", { exact: true }).fill(draft);
      // Dispatch the link's navigation without first blurring/submitting the
      // input, so this checks disposal of an actual unsaved local draft.
      await crumb.getByRole("link", { name: "Projects", exact: true }).dispatchEvent("click");
      await page.getByRole("link", { name: `Open ${nameB}`, exact: true }).click();
      await cleanB();
      await expect(page.getByText(draft, { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(nameB);
      await page.keyboard.press("Escape");
      const saved = (await api(page, "GET", `/api/projects/${a}`)) as { name: string };
      expect(saved.name).toBe(renamed);
    });
  } finally {
    if (mapId) await readThenWriteBrowserSetup(page, `/api/maps/${mapId}`, () => ({ method: "DELETE", path: `/api/maps/${mapId}` })).catch(() => {});
    for (const id of made) await api(page, "DELETE", `/api/projects/${id}`).catch(() => {});
  }
});

test("the Projects list and the project home", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  // Known Projects preferences: the slice is workspace-global, so a run
  // that stopped mid-step could leave list view or another sort.
  await page.request.patch("/api/settings", {
    data: { viewPrefs: { projects: { view: "grid", sort: "updated" } } },
  });

  await test.step("the empty state: ghost and copy, no toolbar, no strip", async () => {
    // Driven at the network boundary so the state is reachable on a
    // shared, residue-bearing instance.
    let stubbing = true;
    const emptyBody = (route: import("@playwright/test").Route) => {
      const url = new URL(route.request().url());
      if (!stubbing || route.request().method() !== "GET") return null;
      if (url.pathname === "/api/projects") return "[]";
      if (url.pathname === "/api/maps") return "[]";
      if (url.pathname === "/api/recipes") return '{"recipes":[]}';
      if (url.pathname === "/api/tables") return "[]";
      return null;
    };
    await context.route("**/api/**", async (route) => {
      const body = emptyBody(route);
      if (body === null) return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body,
      });
    });
    await page.goto("/projects");
    // The empty state is the tile alone: the line under it was struck.
    await expect(page.getByText("A name, nothing else")).toBeVisible();
    await expect(
      page.getByText("Until then everything simply lives here", { exact: false }),
    ).toHaveCount(0);
    // The toolbar is there from zero: the row never waits for the first
    // project.
    await expect(page.getByLabel("Search projects")).toBeVisible();
    await expect(page.getByText("Not in a project:")).toHaveCount(0);
    stubbing = false;
    await page.reload();
  });

  await test.step("creation through both affordances, under the name contract", async () => {
    // The heading button; a blank name is refused in place.
    await page.getByRole("button", { name: "New project", exact: true }).click();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText("Give it a name.")).toBeVisible();
    // Over the bound is refused; the bound itself is the input's cap.
    await page.getByLabel("Name", { exact: true }).fill("x".repeat(121));
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText("At most 120 characters.")).toBeVisible();
    // A padded name lands trimmed.
    await page.getByLabel("Name", { exact: true }).fill(`  ${P1}  `);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(cardNamed(page, P1)).toBeVisible();

    // The ghost tile is the same flow; duplicates are allowed.
    await page
      .getByRole("button", { name: /New project A name, nothing else/ })
      .click();
    await createViaDialog(page, P2);
    await expect(cardNamed(page, P2)).toBeVisible();
    await page
      .getByRole("button", { name: /New project A name, nothing else/ })
      .click();
    await createViaDialog(page, P3);
    await expect(cardNamed(page, P3)).toBeVisible();
  });

  let p1 = "";
  let p2 = "";
  let mapId = "";
  let wfId = "";
  let stepId = "";
  await test.step("seed members: a filed published map, a shared dataset, a workflow", async () => {
    const projects = (await api(page, "GET", "/api/projects")) as {
      id: string;
      name: string;
    }[];
    p1 = projects.find((p) => p.name === P1)!.id;
    p2 = projects.find((p) => p.name === P2)!.id;
    await seedCsv(
      page,
      T1,
      "name,lng,lat\nBuoy A,7.10,53.52\nBuoy B,7.22,53.44\n",
    );
    // T2 is larger and P1-only, so Largest is strict, not a tie.
    await seedCsv(
      page,
      T2,
      `name,lng,lat\n${Array.from({ length: 40 }, (_, i) => `Buoy ${i},7.${i},53.${i}`).join("\n")}\n`,
    );
    const tables = (await api(page, "GET", "/api/tables")) as {
      id: string;
      name: string;
    }[];
    const t1 = tables.find((t) => t.name === T1)!.id;
    const t2 = tables.find((t) => t.name === T2)!.id;
    // T1 in both projects: the home must name the other membership.
    await api(page, "PATCH", `/api/projects/${p1}/members`, {
      addTables: [t1, t2],
    });
    await api(page, "PATCH", `/api/projects/${p2}/members`, {
      addTables: [t1],
    });
    mapId = (
      (await api(page, "POST", "/api/maps", {
        name: `Stations map ${runId}`,
        projectId: p1,
      })) as { id: string }
    ).id;
    await readThenWriteBrowserSetup(page, `/api/maps/${mapId}`, () => ({ method: "POST", path: `/api/maps/${mapId}/layers`, body: {
      name: T1,
      sql: `SELECT * FROM ${T1}`,
    } }));
    await api(page, "POST", `/api/maps/${mapId}/publish`);
    wfId = (
      (await api(page, "POST", "/api/recipes", {
        name: `Lane density ${runId}`,
        projectId: p1,
      })) as { recipe: { id: string } }
    ).recipe.id;
    stepId = (
      (await api(page, "POST", `/api/recipes/${wfId}/steps`, {
        operation: "sql_step",
        parameters: { sql: `SELECT * FROM ${T1}`, name: `pj_out_${runId}` },
      })) as { step: { id: string } }
    ).step.id;
  });

  await test.step("cards report the facts; search and the sorts compose; both views", async () => {
    await page.reload();
    const card = cardNamed(page, P1);
    await expect(card).toContainText("1 published");
    // Sorts, compared among THIS run's projects (a shared instance may
    // hold residue): Largest puts P1 (the only sized one here) before
    // the other two; Name orders the three alphabetically.
    await page.getByLabel("Sort projects").selectOption("largest");
    await expect
      .poll(async () => {
        const names = await page.locator("article").allTextContents();
        const at = (n: string) => names.findIndex((x) => x.includes(n));
        return at(P1) >= 0 && at(P1) < at(P2) && at(P1) < at(P3);
      })
      .toBe(true);
    await page.getByLabel("Sort projects").selectOption("name");
    const sorted = [P1, P2, P3].sort((a, b) => a.localeCompare(b));
    await expect
      .poll(async () => {
        const names = await page.locator("article").allTextContents();
        const at = (n: string) => names.findIndex((x) => x.includes(n));
        return (
          at(sorted[0]) >= 0 &&
          at(sorted[0]) < at(sorted[1]) &&
          at(sorted[1]) < at(sorted[2])
        );
      })
      .toBe(true);
    // Search composes; no match keeps the toolbar and is not the empty state.
    await page.getByLabel("Search projects").fill(P2);
    await expect(cardNamed(page, P2)).toBeVisible();
    await expect(page.locator("article")).toHaveCount(1);
    await page.getByLabel("Search projects").fill("zzz-nothing");
    await expect(page.getByText("No projects match.")).toBeVisible();
    await expect(page.getByLabel("Search projects")).toBeVisible();
    await page.getByLabel("Search projects").fill("");
    // The list view renders the columns and the same facts.
    await page.getByRole("button", { name: "List view" }).click();
    await expect(page.getByText("Contents")).toBeVisible();
    // the row's actions are visible AT REST, not only on
    // hover — a first-time visitor has to be able to find them. The
    // shared gallery rule fades them in; the projects list opts out.
    const restingActs = page
      .getByRole("button", { name: `Rename ${P1}` })
      .locator("xpath=..");
    await expect
      .poll(() => restingActs.evaluate((el) => getComputedStyle(el).opacity), {
        message: "the list row's actions are visible without hover",
      })
      .toBe("1");
    await expect(
      page.getByRole("button", { name: `Open ${P1}` }),
    ).toContainText("1 map");
    // The list remembers view and sort like its siblings. The
    // write is fire-and-forget, so wait until the stored answer holds
    // both choices (list, name) before reloading; then both come back.
    const storedProjects = async () =>
      (
        (await api(page, "GET", "/api/settings")) as {
          viewPrefs?: { projects?: unknown };
        }
      ).viewPrefs?.projects ?? null;
    await expect
      .poll(storedProjects, {
        message: "the projects slice holds list view and the name sort",
      })
      .toEqual({ view: "list", sort: "name" });
    await page.reload();
    await expect(
      page.getByRole("button", { name: "List view" }),
    ).toHaveAttribute("data-on", "true");
    await expect(page.getByLabel("Sort projects")).toHaveValue("name");
    await expect(page.getByText("Contents")).toBeVisible();
    // Back to the defaults through the UI, and wait until the store says
    // so: the slice is workspace-global and later suites read it.
    await page.getByRole("button", { name: "Grid view" }).click();
    await page.getByLabel("Sort projects").selectOption("updated");
    await expect
      .poll(storedProjects)
      .toEqual({ view: "grid", sort: "updated" });
  });

  await test.step("the unfiled summary matches the API's own unfiled counts", async () => {
    // One unfiled map guarantees the strip appears; the exact numbers
    // come from the server's answers, residue included, so the
    // assertion holds the SCREEN's counting on any instance.
    await api(page, "POST", "/api/maps", { name: `Scratch ${runId}` });
    const [maps, recipes, unfiledTables] = (await Promise.all([
      api(page, "GET", "/api/maps"),
      api(page, "GET", "/api/recipes?origin=workflow"),
      api(page, "GET", "/api/tables?project=none"),
    ])) as [
      { projectId: string | null }[],
      { recipes: { projectId: string | null }[] },
      unknown[],
    ];
    const m = maps.filter((x) => !x.projectId).length;
    const w = recipes.recipes.filter((x) => !x.projectId).length;
    const d = unfiledTables.length;
    const word = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;
    await page.reload();
    await expect(page.getByText("Not in a project:")).toBeVisible();
    await expect(
      page.getByText(
        `${word(m, "map")} · ${word(w, "workflow")} · ${word(d, "dataset")}`,
      ),
    ).toBeVisible();
  });

  await test.step("rename from the card persists and refusals keep the confirmed name", async () => {
    const card = cardNamed(page, P3);
    await card.hover();
    await card.getByRole("button", { name: `Rename ${P3}` }).click();
    await page.getByLabel("Project name").fill(RENAMED);
    await page.keyboard.press("Enter");
    await expect(cardNamed(page, RENAMED)).toBeVisible();
    await page.reload();
    await expect(cardNamed(page, RENAMED)).toBeVisible();
  });

  await test.step("the home: heading, stats, note edit, sections, the crumb", async () => {
    await cardNamed(page, P1).getByRole("link", { name: `Open ${P1}` }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${p1}$`));
    await expect.poll(() => page.title()).toBe(`${P1} · Dezfil`);
    // The crumb: Projects / <name>, the name bold and renaming on click.
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb" }),
    ).toContainText("Projects");
    await expect(page.locator('button[title^="Rename "]')).toBeVisible();
    // The stats line counts what the sections list.
    await expect(page.getByText("1 map", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("1 workflow", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("2 datasets", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("1 published", { exact: false }).first()).toBeVisible();
    // The note: add, persist, clear.
    await page.getByRole("button", { name: "add a note" }).click();
    await page.getByLabel("Project note").fill("Q3 field study");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Q3 field study")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Q3 field study")).toBeVisible();
    await page.getByRole("button", { name: "edit", exact: true }).click();
    await page.getByLabel("Project note").fill("");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "add a note" })).toBeVisible();
    // The sections: the map card, the workflow card, the dataset row
    // with its other membership named; the published action opens a new
    // tab (the attribute is the contract; no click leaves this page).
    await expect(page.getByText(`Stations map ${runId}`)).toBeVisible();
    await expect(page.getByText(`Lane density ${runId}`)).toBeVisible();
    await expect(page.getByText(T1)).toBeVisible();
    await expect(page.getByText(`also in ${P2}`)).toBeVisible();
    const pub = page.getByRole("link", {
      name: `Open the published view of Stations map ${runId}`,
    });
    await expect(pub).toHaveAttribute("target", "_blank");
    await expect(pub).toHaveAttribute("href", /\/v\//);
  });

  await test.step("the crumb rename lands everywhere; a refusal is said and keeps the name", async () => {
    const crumbRename = page.locator('button[title^="Rename "]');
    await crumbRename.click();
    const input = page.getByLabel("Project name");
    await input.fill(`${P1} R`);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: `${P1} R` })).toBeVisible();
    await expect(crumbRename).toHaveText(`${P1} R`);
    await expect.poll(() => page.title()).toBe(`${P1} R · Dezfil`);
    // Refused: over the bound; the confirmed name stays, the refusal shows.
    await crumbRename.click();
    await page.getByLabel("Project name").fill("x".repeat(121));
    await page.keyboard.press("Enter");
    await expect(page.getByText(/at most 120/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: `${P1} R` })).toBeVisible();
    // Back to the stable name for the later steps.
    await crumbRename.click();
    await page.getByLabel("Project name").fill(P1);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: P1 })).toBeVisible();
  });

  await test.step("the menu rename shares the crumb's path and refusal rules", async () => {
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.getByLabel("Project name").fill(`${P1} M`);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: `${P1} M` })).toBeVisible();
    await expect(page.locator('button[title^="Rename "]')).toHaveText(`${P1} M`);
    await expect.poll(() => page.title()).toBe(`${P1} M · Dezfil`);
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.getByLabel("Project name").fill(P1);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: P1 })).toBeVisible();
  });

  await test.step("a zero-member project says so: no section, the plate, no callout", async () => {
    const empty = (await api(page, "POST", "/api/projects", {
      name: `Empty shelf ${runId}`,
    })) as { id: string };
    await page.goto(`/projects/${empty.id}`);
    await expect(
      page.getByRole("heading", { name: `Empty shelf ${runId}` }),
    ).toBeVisible();
    for (const section of ["Maps", "Workflows", "Data"]) {
      await expect(page.getByRole("heading", { name: section, exact: true })).toHaveCount(0);
    }
    await expect(page.locator("[data-empty-plate]")).toContainText("This project is empty");
    await expect(page.getByText("0 maps")).toHaveCount(0);
    await expect(page.locator("[data-attention]")).toHaveCount(0);
    await expect(page.locator("article")).toHaveCount(0);
    await api(page, "DELETE", `/api/projects/${empty.id}`);
    await page.goto(`/projects/${p1}`);
    await expect(page.getByRole("heading", { name: P1 })).toBeVisible();
  });

  await test.step("the attention area: to-run-again members, the Run action, and its absence", async () => {
    // Up to date first: no callout on a workflow that has never run and
    // is not to-run-again? A never-run workflow is not run_again — the
    // area stays absent until the server classifies one.
    await expect(page.locator("[data-attention]")).toHaveCount(0);
    // Run the node once, then edit it: the pending edit classifies the
    // workflow to-run-again with its truthful cause.
    await api(page, "POST", `/api/recipes/${wfId}/runs`, {
      members: [stepId],
    });
    await expect
      .poll(
        async () => {
          const recipe = (await api(page, "GET", `/api/recipes/${wfId}`)) as {
            recipe: { steps: { latestAttempt: { state: string } | null }[] };
          };
          return recipe.recipe.steps[0]?.latestAttempt?.state ?? "none";
        },
        { timeout: 60_000 },
      )
      .toBe("succeeded");
    await api(page, "PATCH", `/api/recipes/${wfId}/steps/${stepId}`, {
      parameters: { sql: `SELECT name FROM ${T1}`, name: `pj_out_${runId}` },
    });
    // A second affected workflow: every affected member gets its own
    // row, and each Run targets its own workflow.
    const wf2 = (
      (await api(page, "POST", "/api/recipes", {
        name: `Commute hexes ${runId}`,
        projectId: p1,
      })) as { recipe: { id: string } }
    ).recipe.id;
    const step2 = (
      (await api(page, "POST", `/api/recipes/${wf2}/steps`, {
        operation: "sql_step",
        parameters: { sql: `SELECT * FROM ${T2}`, name: `pj_hex_${runId}` },
      })) as { step: { id: string } }
    ).step.id;
    await api(page, "POST", `/api/recipes/${wf2}/runs`, { members: [step2] });
    await expect
      .poll(
        async () => {
          const recipe = (await api(page, "GET", `/api/recipes/${wf2}`)) as {
            recipe: { steps: { latestAttempt: { state: string } | null }[] };
          };
          return recipe.recipe.steps[0]?.latestAttempt?.state ?? "none";
        },
        { timeout: 60_000 },
      )
      .toBe("succeeded");
    await api(page, "PATCH", `/api/recipes/${wf2}/steps/${step2}`, {
      parameters: { sql: `SELECT name FROM ${T2}`, name: `pj_hex_${runId}` },
    });
    await page.reload();
    const callout = page.locator(`[data-attention="${wfId}"]`);
    const callout2 = page.locator(`[data-attention="${wf2}"]`);
    await expect(callout).toBeVisible();
    await expect(callout2).toBeVisible();
    await expect(callout).toContainText(`Lane density ${runId}`);
    await expect(callout2).toContainText(`Commute hexes ${runId}`);
    await expect(callout).toContainText("1 node to run again");
    await expect(callout).toContainText("an edit awaits a run");
    // Run drives the shared interaction: the node is current, so the
    // plan is wide and the SAME confirm dialog the canvas owns appears,
    // naming the node and that it runs again; confirming starts it, and
    // the settled world clears the callout.
    await callout.getByRole("button", { name: `Run Lane density ${runId}` }).click();
    const dialog = page.getByRole("dialog", { name: "Run all" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("runs again");
    await dialog.getByRole("button", { name: "Run 1 node" }).click();
    await expect(page.locator(`[data-attention="${wfId}"]`)).toHaveCount(0, {
      timeout: 60_000,
    });
    // Its sibling's row was not touched by that run.
    await expect(callout2).toBeVisible();
  });

  await test.step("dissolution from the home: stated, confirmed, returned to Projects", async () => {
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Delete project" }).click();
    await expect(
      page.getByText("its maps and workflows stay, unfiled", { exact: false }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Delete project", exact: true })
      .click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(cardNamed(page, P1)).toHaveCount(0);
    // The members survived, unfiled — and the shared dataset kept its
    // other membership.
    const map = (await api(page, "GET", `/api/maps/${mapId}`)) as {
      projectId: string | null;
    };
    expect(map.projectId).toBeNull();
    const tables = (await api(page, "GET", "/api/tables")) as {
      name: string;
      projectIds: string[];
    }[];
    expect(tables.find((t) => t.name === T1)!.projectIds).toEqual([p2]);
  });

  await test.step("a failed record read offers a retry, distinct from missing", async () => {
    let failing = true;
    await context.route(`**/api/projects/${p2}`, async (route) => {
      if (failing && route.request().method() === "GET") {
        failing = false;
        await route.abort();
        return;
      }
      await route.fallback();
    });
    await page.goto(`/projects/${p2}`);
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    // Not the missing state, and no stale content around it.
    await expect(page.getByText(/No project with id/)).toHaveCount(0);
    await retry.click();
    await expect(page.getByRole("heading", { name: P2 })).toBeVisible();
    await context.unroute(`**/api/projects/${p2}`);
  });

  await test.step("an unknown project reports as missing, never an empty project", async () => {
    await page.goto("/projects/no-such-project");
    await expect(page.getByText(/No project with id/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Projects" }).last()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Maps" })).toHaveCount(0);
  });

  await test.step("dissolution from the list card, armed with its consequence", async () => {
    await page.goto("/projects");
    const card = cardNamed(page, RENAMED);
    await card.hover();
    await card.getByRole("button", { name: `Delete ${RENAMED}` }).click();
    await card
      .getByRole("button", { name: /Really delete/ })
      .click();
    await expect(cardNamed(page, RENAMED)).toHaveCount(0);
  });
});

test("a member dataset with an unknown size marks the total partial", async ({
  page,
  context,
}) => {
  const dataDir = process.env.DEZFIL_DATA_DIR;
  test.skip(
    !dataDir,
    "DEZFIL_DATA_DIR is required so the fixture can unsize a member artifact",
  );
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/projects");
  const name = `pj_sz_${runId}`;
  await seedCsv(page, name, "name,lng,lat\nBuoy A,7.10,53.52\n");
  const tables = (await api(page, "GET", "/api/tables")) as {
    id: string;
    name: string;
    file: string;
  }[];
  const t = tables.find((x) => x.name === name)!;
  const project = (await api(page, "POST", "/api/projects", {
    name: `Sizes ${runId}`,
  })) as { id: string };
  await api(page, "PATCH", `/api/projects/${project.id}/members`, {
    addTables: [t.id],
  });
  const artifact = path.join(dataDir!, t.file);
  await fsRename(artifact, `${artifact}.away`);
  try {
    await page.reload();
    const card = cardNamed(page, `Sizes ${runId}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText("≥");
  } finally {
    await fsRename(`${artifact}.away`, artifact);
  }
});

test("the project home's ⋯ menu wears the house dress", async ({
  page,
  context,
}) => {
  // The field round's screenshot: bare stacked text, "RenameDelete
  // project" — the one menu in the app that passed no panel class.
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/projects");
  const name = `Menu study ${runId}`;
  const id = ((await api(page, "POST", "/api/projects", { name })) as {
    id: string;
  }).id;
  try {
    await page.goto(`/projects/${id}`);
    await page.getByRole("button", { name: "More" }).click();
    const projectMenu = page.getByRole("menu", { name: "Project actions" });
    await expect(projectMenu).toBeVisible();
    await expect(
      projectMenu.getByRole("menuitem", { name: "Delete project" }),
    ).toBeVisible();
    const dress = await projectMenu.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        border: parseFloat(s.borderTopWidth),
        background: s.backgroundColor,
        padding: parseFloat(s.paddingTop),
      };
    });
    expect(dress.border, "the menu panel has a border").toBeGreaterThan(0);
    expect(dress.background, "the menu panel has a background").not.toMatch(
      /^rgba\(0, 0, 0, 0\)$|^transparent$/,
    );
    expect(dress.padding, "the menu panel is padded").toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(projectMenu).toBeHidden();
  } finally {
    await api(page, "DELETE", `/api/projects/${id}`).catch(() => {});
  }
});

// The picture by count over maps, workflows
// and datasets, the counts that drop zeros, the note on its own line,
// equal card heights across a grid row, the list's words and Status
// header. Its own test, so one red never hides another; its own prefix,
// so no other suite's residue matches.
test("the Projects page: the picture by count and the counts that drop zeros", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  const run = `${runId}p`;
  const P = (word: string) => `${word} ${run}`;
  const names = {
    five: P("Five things"),
    three: P("Three things"),
    two: P("Two things"),
    one: P("One thing"),
    none: P("Nothing yet"),
    dataOnly: P("Data only"),
    mapsOnly: P("Maps only"),
    long: P("A deliberately long project name that must truncate in the list"),
  };
  const made: string[] = [];
  const project = async (name: string) => {
    const p = (await api(page, "POST", "/api/projects", { name })) as {
      id: string;
    };
    made.push(p.id);
    return p.id;
  };
  const csv = async (name: string, rows: number) =>
    seedCsv(
      page,
      name,
      `name,lng,lat\n${Array.from({ length: rows }, (_, i) => `R${i},7.${i},53.${i}`).join("\n")}\n`,
    );
  const tableId = async (name: string) =>
    ((await api(page, "GET", "/api/tables")) as { id: string; name: string }[]).find(
      (t) => t.name === name,
    )!.id;

  await page.goto("/projects");
  try {
    await test.step("seed: five, three, two, one, none, data-only and maps-only projects", async () => {
      const five = await project(names.five);
      const three = await project(names.three);
      const two = await project(names.two);
      const one = await project(names.one);
      await project(names.none);
      await project(names.long);
      const dataOnly = await project(names.dataOnly);
      const mapsOnly = await project(names.mapsOnly);
      await csv(`pic_a_${run}`, 3);
      await csv(`pic_b_${run}`, 4);
      await csv(`pic_c_${run}`, 5);
      const [ta, tb, tc] = await Promise.all([
        tableId(`pic_a_${run}`),
        tableId(`pic_b_${run}`),
        tableId(`pic_c_${run}`),
      ]);
      // Three things: a workflow and two datasets — one tile, the
      // workflow (datasets take no tile).
      await api(page, "POST", "/api/recipes", { name: P("Flow three"), projectId: three });
      await api(page, "PATCH", `/api/projects/${three}/members`, { addTables: [tb, tc] });
      // Two: a map, a workflow and a dataset — two tiles. One: a map.
      // Data only: a dataset and nothing to picture.
      await api(page, "POST", "/api/maps", { name: P("Map two"), projectId: two });
      await api(page, "POST", "/api/recipes", { name: P("Flow two"), projectId: two });
      await api(page, "PATCH", `/api/projects/${two}/members`, { addTables: [tc] });
      await api(page, "POST", "/api/maps", { name: P("Map one"), projectId: one });
      await api(page, "PATCH", `/api/projects/${dataOnly}/members`, { addTables: [ta] });
      // Maps only: three maps, one published, no note.
      for (const n of ["Alpha", "Beta", "Gamma"]) {
        const m = (await api(page, "POST", "/api/maps", { name: P(`Map ${n}`), projectId: mapsOnly })) as { id: string };
        if (n === "Alpha") await api(page, "POST", `/api/maps/${m.id}/publish`);
      }
      // Five things last, so it and the maps-only project are the two
      // newest and share the first grid row with the New-project tile.
      // Two maps, two workflows, two datasets, and a note: four tiles
      // of maps then workflows, the datasets never drawn. The maps are
      // created A then B, then A is renamed so its edited time is the
      // newer: the picture must still follow the listing's order (B,
      // then A), not the timestamps.
      const mapA = (await api(page, "POST", "/api/maps", { name: P("Map A"), projectId: five })) as { id: string };
      await api(page, "POST", "/api/maps", { name: P("Map B"), projectId: five });
      await readThenWriteBrowserSetup(page, `/api/maps/${mapA.id}`, () => ({ method: "PATCH", path: `/api/maps/${mapA.id}`, body: { name: P("Map A edited") } }));
      await api(page, "POST", "/api/recipes", { name: P("Flow five"), projectId: five });
      await api(page, "POST", "/api/recipes", { name: P("Flow five b"), projectId: five });
      await api(page, "PATCH", `/api/projects/${five}/members`, { addTables: [ta, tb] });
      await api(page, "PATCH", `/api/projects/${five}`, { note: "A note on its own line" });
      await page.reload();
      await page.getByRole("button", { name: "Grid view", exact: true }).click();
      await expect(cardNamed(page, names.mapsOnly)).toBeVisible();
    });

    await test.step("the picture: maps then workflows, never datasets — four, three (tall first), two, one, the folder", async () => {
      const tiles = (name: string) => cardNamed(page, name).locator("[data-tile]");
      await expect(tiles(names.five)).toHaveCount(4);
      await expect(tiles(names.mapsOnly)).toHaveCount(3);
      await expect(tiles(names.two)).toHaveCount(2);
      await expect(tiles(names.three)).toHaveCount(1);
      await expect(tiles(names.one)).toHaveCount(1);
      await expect(tiles(names.none)).toHaveCount(1);
      await expect(tiles(names.none).first()).toHaveAttribute("data-empty", /.*/);
      // A datasets-only project has nothing to picture: the folder
      // tile, beside a counts line that still says what it holds.
      await expect(tiles(names.dataOnly)).toHaveCount(1);
      await expect(tiles(names.dataOnly).first()).toHaveAttribute("data-empty", /.*/);
      await expect(cardNamed(page, names.dataOnly).locator('[data-count="datasets"]')).toContainText("1");
      // Kind priority and listing order: maps first, B before the
      // renamed A; then the workflows; the datasets never.
      const kinds5 = await tiles(names.five).evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
      expect(kinds5).toEqual(["map", "map", "workflow", "workflow"]);
      const kinds2 = await tiles(names.two).evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
      expect(kinds2).toEqual(["map", "workflow"]);
      const mapIds = await tiles(names.five).evaluateAll((els) => els.slice(0, 2).map((e) => e.getAttribute("data-id")));
      const maps = (await api(page, "GET", `/api/maps?project=${made[0]}`)) as { id: string; name: string }[];
      expect(mapIds).toEqual(maps.map((m) => m.id));
      expect(maps[0].name).toBe(P("Map B"));
      const kinds3 = await tiles(names.three).evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
      expect(kinds3).toEqual(["workflow"]);
      // The three-tile shape: the first tile spans the strip's height.
      const strip = cardNamed(page, names.mapsOnly).locator("[data-picture]");
      const stripBox = (await strip.boundingBox())!;
      const firstBox = (await tiles(names.mapsOnly).first().boundingBox())!;
      const secondBox = (await tiles(names.mapsOnly).nth(1).boundingBox())!;
      expect(Math.abs(firstBox.height - stripBox.height)).toBeLessThan(3);
      expect(secondBox.height).toBeLessThan(stripBox.height * 0.6);
      // A kind mark on every card tile, none on a row tile; no wash.
      await expect(cardNamed(page, names.five).locator("[data-mark]")).toHaveCount(4);
      const wash = await cardNamed(page, names.five)
        .locator("[data-picture]")
        .evaluate((el) => getComputedStyle(el.parentElement!, "::after").content);
      expect(wash).toBe("none");
    });

    await test.step("counts drop zeros; Empty; the chip only when published; the note on its own line", async () => {
      const mapsOnly = cardNamed(page, names.mapsOnly);
      await expect(mapsOnly.locator("[data-count]")).toHaveCount(1);
      await expect(mapsOnly.locator('[data-count="maps"]')).toContainText("3");
      await expect(mapsOnly.getByText("1 published")).toBeVisible();
      const five = cardNamed(page, names.five);
      await expect(five.locator('[data-count="datasets"]')).toContainText("2");
      await expect(five.locator('[data-count="size"]')).toBeVisible();
      await expect(five.getByText(/published/)).toHaveCount(0);
      await expect(cardNamed(page, names.none).locator('[data-count="empty"]')).toHaveText("Empty");
      const counts = (await five.locator("[data-counts]").boundingBox())!;
      const note = (await five.locator("[data-note]").boundingBox())!;
      expect(note.y).toBeGreaterThan(counts.y + counts.height - 1);
      await expect(five.locator("[data-note]")).toHaveText("A note on its own line");
    });

    await test.step("two cards in one grid row share one height", async () => {
      // Measured after the entrance animation settles: the two newest
      // projects sit in the first row; one carries a note and no chip,
      // the other a chip and no note.
      const boxes = async () => {
        const a = (await cardNamed(page, names.mapsOnly).boundingBox())!;
        const b = (await cardNamed(page, names.five).boundingBox())!;
        return { dy: Math.abs(a.y - b.y), dh: Math.abs(a.height - b.height), h: a.height };
      };
      await expect.poll(async () => (await boxes()).dy, { timeout: 5_000 }).toBeLessThan(1);
      const { dh, h } = await boxes();
      expect(dh).toBeLessThan(1);
      expect(h).toBeGreaterThan(200);
    });

    await test.step("the list: the words, the Status header, the blank size, no marks", async () => {
      await page.getByRole("button", { name: "List view", exact: true }).click();
      await expect(page.getByText("Status", { exact: true })).toBeVisible();
      const rowTwo = page.getByRole("button", { name: `Open ${names.two}` });
      await expect(rowTwo).toContainText("1 map");
      await expect(rowTwo).toContainText("1 workflow");
      await expect(rowTwo).toContainText("1 dataset");
      await expect(rowTwo.locator("[data-mark]")).toHaveCount(0);
      // The swatch follows the picture rule: map and workflow, no
      // dataset tile.
      await expect(rowTwo.locator("[data-tile]")).toHaveCount(2);
      const rowNone = page.getByRole("button", { name: `Open ${names.none}` });
      await expect(rowNone).toContainText("Empty");
      await expect(rowNone.locator("[data-size-cell]")).toHaveText("");
      // A long name truncates in its own column instead of running into
      // the Contents column (the side-by-side round's catch).
      const rowLong = page.getByRole("button", { name: `Open ${names.long}` });
      const nameBox = (await rowLong.locator("[data-row-name]").boundingBox())!;
      const contentsBox = (await rowLong.locator("[data-row-contents]").boundingBox())!;
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(contentsBox.x + 1);
      await page.getByRole("button", { name: "Grid view", exact: true }).click();
    });
  } finally {
    await page.getByRole("button", { name: "Grid view", exact: true }).click().catch(() => {});
    for (const id of made) await api(page, "DELETE", `/api/projects/${id}`).catch(() => {});
  }
});

// Head A without its picture: the facts line
// that says only what exists, only the sections with something, the
// section head as mark, title and count, the dataset card in the home's
// metric, and the one switch, in its own row under the head, that turns
// every section into a list with its header row. Its own test; its own
// prefix.
test("the project home: facts that drop zeros, only the sections with something, one switch", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  const run = `${runId}h`;
  const P = (word: string) => `${word} ${run}`;
  const made: string[] = [];
  const project = async (name: string) => {
    const p = (await api(page, "POST", "/api/projects", { name })) as { id: string };
    made.push(p.id);
    return p.id;
  };
  await page.goto("/projects");
  let two = "";
  let mapsOnly = "";
  try {
    await test.step("seed: two maps + three datasets (one shared), a maps-only project", async () => {
      two = await project(P("Two and three"));
      mapsOnly = await project(P("Maps only"));
      const shared = await project(P("Other shelf"));
      await seedCsv(page, `hm_a_${run}`, "name,lng,lat\nA,7.1,53.5\nB,7.2,53.4\n");
      await seedCsv(page, `hm_b_${run}`, "name,lng,lat\nC,7.3,53.3\n");
      await seedCsv(page, `hm_c_${run}`, "name,value\nD,1\nE,2\n");
      const tables = (await api(page, "GET", "/api/tables")) as { id: string; name: string }[];
      const id = (n: string) => tables.find((t) => t.name === n)!.id;
      await api(page, "PATCH", `/api/projects/${two}/members`, {
        addTables: [id(`hm_a_${run}`), id(`hm_b_${run}`), id(`hm_c_${run}`)],
      });
      await api(page, "PATCH", `/api/projects/${shared}/members`, { addTables: [id(`hm_a_${run}`)] });
      await api(page, "POST", "/api/maps", { name: P("Draft one"), projectId: two });
      await api(page, "POST", "/api/maps", { name: P("Draft two"), projectId: two });
      for (const n of ["Alpha", "Beta"]) {
        await api(page, "POST", "/api/maps", { name: P(`Only ${n}`), projectId: mapsOnly });
      }
    });

    await test.step("the head: exactly the facts that exist, in order, no picture; the actions in order", async () => {
      await page.goto(`/projects/${two}`);
      await expect(page.getByRole("heading", { name: P("Two and three") })).toBeVisible();
      const facts = page.locator("[data-facts] [data-fact]");
      await expect(facts).toHaveCount(4);
      const keys = await facts.evaluateAll((els) => els.map((e) => e.getAttribute("data-fact")));
      expect(keys).toEqual(["maps", "datasets", "size", "updated"]);
      await expect(facts.nth(0)).toHaveText("2 maps");
      await expect(facts.nth(1)).toHaveText("3 datasets");
      await expect(page.locator("[data-picture]")).toHaveCount(0);
      // Publish a map: the published fact appears, after datasets.
      const maps = (await api(page, "GET", `/api/maps?project=${two}`)) as { id: string }[];
      await api(page, "POST", `/api/maps/${maps[0].id}/publish`);
      await page.reload();
      await expect.poll(async () =>
        page.locator("[data-facts] [data-fact]").evaluateAll((els) => els.map((e) => e.getAttribute("data-fact"))),
      ).toEqual(["maps", "datasets", "published", "size", "updated"]);
      await expect(page.locator('[data-fact="published"]')).toHaveText("1 published");
      // The actions, left to right: Add, Export, the owner's Share, the
      // menu, and nothing else (the switch left the head).
      const acts = page.locator("[data-head-acts]");
      const labels = await acts.locator("button, [role=group]").evaluateAll((els) =>
        els.map((e) => e.getAttribute("aria-label") ?? e.textContent?.trim() ?? ""),
      );
      expect.soft(labels).toEqual(["Add to project", "Export project", "Share", "More"]);
    });

    await test.step("the switch under the head where the list screens keep it; the head's four controls at one height", async () => {
      // A box read once the entrance animation has settled: two reads
      // 120ms apart agree.
      const settle = async (loc: Locator) => {
        let prev = (await loc.boundingBox())!;
        await expect
          .poll(
            async () => {
              const next = (await loc.boundingBox())!;
              const same = Math.abs(next.y - prev.y) < 0.5 && Math.abs(next.height - prev.height) < 0.5;
              prev = next;
              return same;
            },
            { timeout: 5_000, intervals: [120] },
          )
          .toBe(true);
        return prev;
      };
      for (const viewport of [
        { width: 1280, height: 720 },
        { width: 1440, height: 900 },
      ]) {
        await page.setViewportSize(viewport);
        await page.goto("/projects");
        const listSwitch = page.getByRole("group", { name: "View" });
        await expect(listSwitch).toBeVisible();
        const onList = await settle(listSwitch);
        await page.goto("/maps");
        const onMaps = await settle(page.getByRole("group", { name: "View" }));
        await page.goto(`/projects/${two}`);
        const acts = page.locator("[data-head-acts]");
        await expect(acts.getByRole("button", { name: "More", exact: true })).toBeVisible();
        const heights: number[] = [];
        for (const name of ["Add to project", "Export project", "Share", "More"]) {
          heights.push((await settle(acts.getByRole("button", { name, exact: true }))).height);
        }
        expect.soft(heights, `${viewport.width}: the four head controls at one height`).toEqual([heights[0], heights[0], heights[0], heights[0]]);
        expect.soft(Math.round(heights[0]), `${viewport.width}: the chrome metric`).toBe(38);
        const heading = await settle(acts.locator("xpath=.."));
        const homeSwitch = page.locator("[data-switch-row]").getByRole("group", { name: "View" });
        await expect(homeSwitch).toBeVisible();
        const s = await settle(homeSwitch);
        const firstBlock = await settle(page.locator("[data-home-content] > *").first());
        expect.soft(s.y, `${viewport.width}: the switch lies below the head`).toBeGreaterThanOrEqual(heading.y + heading.height);
        expect.soft(s.y + s.height, `${viewport.width}: the switch lies above the first content block`).toBeLessThanOrEqual(firstBlock.y);
        expect.soft(
          Math.abs(s.x + s.width - (onList.x + onList.width)),
          `${viewport.width}: the switch's right edge is the Projects screen's`,
        ).toBeLessThanOrEqual(1);
        expect.soft(
          Math.abs(s.x + s.width - (onMaps.x + onMaps.width)),
          `${viewport.width}: the switch's right edge is the Maps screen's`,
        ).toBeLessThanOrEqual(1);
        expect.soft(Math.abs(s.height - heights[0]), `${viewport.width}: the switch at the head controls' height`).toBeLessThanOrEqual(1);
      }
      await page.setViewportSize({ width: 1280, height: 720 });
    });

    await test.step("only the sections with something, in order; a head is its mark, title and count, and links nowhere", async () => {
      await expect(page.getByRole("heading", { name: "Maps", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Data", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toHaveCount(0);
      const sections = await page.locator("[data-section]").evaluateAll((els) => els.map((e) => e.getAttribute("data-section")));
      expect(sections).toEqual(["map", "dataset"]);
      const main = page.getByRole("main");
      await expect.soft(main.getByRole("link", { name: /in this project/ })).toHaveCount(0);
      const heads = page.locator("[data-section] h2").locator("xpath=..");
      await expect(heads).toHaveCount(2);
      await expect.soft(heads.locator("a, [role=link]")).toHaveCount(0);
      await expect(heads.locator("h2")).toHaveText(["Maps", "Data"]);
      await expect(heads.locator("h2 + span")).toHaveText(["2", "3"]);
      expect(await heads.locator("[data-sec-mark]").evaluateAll((els) => els.map((e) => e.getAttribute("data-sec-mark")))).toEqual(["map", "dataset"]);
      // A third kind, so all three absences fail on their own against
      // the links `main` draws (found at review: a fixture without a
      // workflow section cannot miss that section's link). Made and
      // unmade here, whatever the assertions say.
      const wf = ((await api(page, "POST", "/api/recipes", { name: P("Passing flow"), origin: "workflow", projectId: two })) as { recipe: { id: string } }).recipe;
      try {
        await page.reload();
        await expect(page.locator("[data-section]")).toHaveCount(3);
        const heads3 = page.locator("[data-section] h2").locator("xpath=..");
        await expect(heads3.locator("h2")).toHaveText(["Maps", "Workflows", "Data"]);
        await expect(heads3.locator("h2 + span")).toHaveText(["2", "1", "3"]);
        expect(await heads3.locator("[data-sec-mark]").evaluateAll((els) => els.map((e) => e.getAttribute("data-sec-mark")))).toEqual(["map", "workflow", "dataset"]);
        await expect.soft(heads3.locator("a, [role=link]")).toHaveCount(0);
        for (const name of ["All maps in this project", "All workflows in this project", "All data in this project"]) {
          await expect.soft(main.getByRole("link", { name, exact: true })).toHaveCount(0);
        }
      } finally {
        await api(page, "DELETE", `/api/recipes/${wf.id}`).catch(() => {});
      }
      await page.reload();
      await expect(page.locator("[data-section]")).toHaveCount(2);
    });

    await test.step("the dataset card: the home's metric, the facts, also in, no tray, time stays on hover", async () => {
      const mapCard = page.locator('[data-sec-card="map"]').first();
      const dataCard = page.locator('[data-sec-card="dataset"]').filter({ hasText: `hm_a_${run}` });
      const mb = (await mapCard.boundingBox())!;
      const db = (await dataCard.boundingBox())!;
      expect(Math.abs(mb.width - db.width)).toBeLessThan(1);
      const mStrip = (await mapCard.locator("[class*='strip']").first().boundingBox())!;
      const dStrip = (await dataCard.locator("[class*='strip']").first().boundingBox())!;
      expect(Math.abs(mStrip.height - dStrip.height)).toBeLessThan(1);
      await expect(dataCard).toContainText("rows");
      await expect(dataCard).toContainText("Points");
      await expect(dataCard.locator("[data-also-in]")).toHaveText(`also in ${P("Other shelf")}`);
      await expect(page.locator('[data-sec-card="dataset"]').filter({ hasText: `hm_c_${run}` })).toContainText("No geometry");
      await dataCard.hover();
      await expect(dataCard.locator("[class*='acts']")).toHaveCount(0);
      const when = dataCard.locator("[class*='cardWhen']");
      await expect.poll(() => when.evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
      await dataCard.getByRole("link", { name: `Open hm_a_${run}` }).click();
      await expect(page).toHaveURL(new RegExp(`/tables/hm_a_${run}$`));
      await page.goBack();
      await expect(page.getByRole("heading", { name: "Maps", exact: true })).toBeVisible();
    });

    await test.step("one switch: every section a list with its header; Also in only when shared; back to cards; reload starts in cards", async () => {
      let wrote = false;
      await context.route("**/api/settings", (route) => {
        if (route.request().method() === "PATCH") wrote = true;
        return route.fallback();
      });
      await page.getByRole("button", { name: "List view", exact: true }).click();
      await expect(page.locator('[data-section="map"] [class*="listHead"]')).toContainText("Last edited");
      // The row's picture has its own size (the 2px-sliver class, twice
      // met in side-by-side rounds).
      const pic = (await page.locator('[data-section="map"] [data-row-pic]').first().boundingBox())!;
      expect(pic.width).toBeGreaterThan(90);
      expect(pic.height).toBeGreaterThan(50);
      await expect(page.locator('[data-section="map"] [class*="listHead"]')).toContainText("Layers");
      await expect(page.locator('[data-section="dataset"] [class*="listHead"]')).toContainText("Last updated");
      await expect(page.locator('[data-section="dataset"] [class*="listHead"]')).toContainText("Also in");
      await expect(page.locator('[data-section="dataset"] [class*="listHead"]')).toContainText("Size");
      await expect(page.locator("[data-sec-card]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: `Open hm_a_${run}` })).toContainText(P("Other shelf"));
      // The published map's row action, visible at rest.
      const pub = page.locator('[data-section="map"]').getByRole("link", { name: /Open the published view of/ });
      await expect.poll(() => pub.evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
      await page.getByRole("button", { name: "Grid view", exact: true }).click();
      await expect(page.locator("[data-sec-card]").first()).toBeVisible();
      await expect(page.locator('[class*="listHead"]')).toHaveCount(0);
      // Not shared: no Also in column on the maps-only project.
      await page.goto(`/projects/${mapsOnly}`);
      await expect(page.getByRole("heading", { name: "Maps", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Data", exact: true })).toHaveCount(0);
      await expect(page.locator("[data-facts] [data-fact]")).toHaveCount(2);
      await page.getByRole("button", { name: "List view", exact: true }).click();
      await expect(page.locator('[data-section="map"] [class*="listHead"]')).toContainText("Status");
      await page.reload();
      await expect(page.locator("[data-sec-card]").first()).toBeVisible();
      await context.unroute("**/api/settings");
      expect(wrote).toBe(false);
    });
  } finally {
    for (const id of made) await api(page, "DELETE", `/api/projects/${id}`).catch(() => {});
  }
});

// Variant L: the empty project says so once,
// offers the three creates and the recent card with the kind first on
// every row; one Add ends the empty state. Recent ordering is driven at
// the network boundary so no residue can outrank the fixture; the live
// Add mutates and asserts its exact objects.
test("the empty project: the plate, the recent card, and one Add that ends it", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  const run = `${runId}e`;
  const P = (word: string) => `${word} ${run}`;
  const made: string[] = [];
  const project = async (name: string) => {
    const p = (await api(page, "POST", "/api/projects", { name })) as { id: string };
    made.push(p.id);
    return p.id;
  };
  await page.goto("/projects");
  await api(page, "PATCH", "/api/settings", { instanceName: `Stadtwerke ${run}` });
  let empty = "";
  let other = "";
  let mapId = "";
  let tableId = "";
  try {
    await test.step("seed: an empty project, a filed map elsewhere, an unfiled dataset, a workflow", async () => {
      empty = await project(P("Fresh shelf"));
      other = await project(P("Other shelf"));
      mapId = ((await api(page, "POST", "/api/maps", { name: P("Elsewhere map"), projectId: other })) as { id: string }).id;
      await seedCsv(page, `em_pts_${run}`, "name,lng,lat\nA,7.1,53.5\nB,7.2,53.4\n");
      tableId = ((await api(page, "GET", "/api/tables")) as { id: string; name: string }[]).find((t) => t.name === `em_pts_${run}`)!.id;
      await api(page, "POST", "/api/recipes", { name: P("Loose flow") });
    });

    await test.step("the plate and the recent card, the kind first on every row", async () => {
      await page.goto(`/projects/${empty}`);
      await expect(page.getByRole("heading", { name: P("Fresh shelf") })).toBeVisible();
      await expect(page.locator("[data-facts] [data-fact]")).toHaveCount(1);
      await expect(page.locator('[data-fact="created"]')).toContainText("created");
      await expect(page.locator("[data-section]")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Maps", exact: true })).toHaveCount(0);
      await expect(page.getByRole("group", { name: "View" })).toHaveCount(0);
      // Neither the switch nor its row: an empty row would pass the
      // group's absence alone.
      await expect(page.locator("[data-switch-row]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Export project" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "More" })).toBeVisible();
      // This reaches the empty head too: Add and the menu at one height (the
      // head does not animate; a direct read).
      const emptyActs = page.locator("[data-head-acts]");
      const addH = (await emptyActs.getByRole("button", { name: "Add to project", exact: true }).boundingBox())!.height;
      const moreH = (await emptyActs.getByRole("button", { name: "More", exact: true }).boundingBox())!.height;
      expect.soft(Math.abs(addH - moreH), "the empty head's Add and menu at one height").toBeLessThanOrEqual(1);
      const plate = page.locator("[data-empty-plate]");
      await expect(plate).toContainText("This project is empty");
      for (const name of ["New map", "New workflow", "Add data"]) {
        await expect(plate.getByRole("button", { name, exact: true })).toBeVisible();
      }
      await expect(page.locator("[data-recent-heading]")).toHaveText(`Recent in Stadtwerke ${run}`);
      await expect(page.locator("[data-recent-hint]")).toHaveText(`none of these is in ${P("Fresh shelf")}`);
      const rows = page.locator("[data-recent-row]");
      await expect(rows.first()).toBeVisible();
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(6);
      const mapRow = rows.filter({ hasText: P("Elsewhere map") });
      await expect(mapRow.locator("[data-recent-kind]")).toHaveText("Map");
      await expect(mapRow.locator("[data-recent-where]")).toHaveText(`in ${P("Other shelf")}`);
      await expect(mapRow).toContainText("0 layers");
      const dataRow = rows.filter({ hasText: `em_pts_${run}` });
      await expect(dataRow.locator("[data-recent-kind]")).toHaveText("Dataset");
      await expect(dataRow.locator("[data-recent-where]")).toHaveText("not in a project");
      await expect(dataRow).toContainText("2 rows · Points");
      const wfRow = rows.filter({ hasText: P("Loose flow") });
      await expect(wfRow.locator("[data-recent-kind]")).toHaveText("Workflow");
      // The button's word: Move on a map or workflow filed elsewhere,
      // Add on a dataset and on anything unfiled.
      await expect(mapRow.getByRole("button", { name: `Move ${P("Elsewhere map")}`, exact: true })).toBeVisible();
      await expect(mapRow.getByRole("button", { name: /^Add / })).toHaveCount(0);
      await expect(dataRow.getByRole("button", { name: `Add em_pts_${run}`, exact: true })).toBeVisible();
      await expect(wfRow.getByRole("button", { name: `Add ${P("Loose flow")}`, exact: true })).toBeVisible();
    });

    await test.step("the six newest across kinds, members and builder recipes excluded, driven at the boundary", async () => {
      const t = (i: number) => `2026-09-0${i}T00:00:00.000Z`;
      const maps = [
        { id: "mx1", name: "Map one", projectId: null, layerCount: 1, updatedAt: t(9), publishToken: null, createdAt: t(1) },
        { id: "mx2", name: "Member map", projectId: empty, layerCount: 1, updatedAt: t(8), publishToken: null, createdAt: t(1) },
        { id: "mx3", name: "Map three", projectId: null, layerCount: 2, updatedAt: t(3), publishToken: null, createdAt: t(1) },
      ];
      const recipes = [
        { id: "wx1", name: "Flow one", origin: "workflow", projectId: null, updatedAt: t(7), summary: { nodes: 1, sources: 0, liveOutputs: 0, status: "empty", count: 0 }, steps: [] },
        { id: "bx1", name: "Builder recipe", origin: "builder", projectId: null, updatedAt: t(9), summary: { nodes: 1, sources: 0, liveOutputs: 0, status: "empty", count: 0 }, steps: [] },
      ];
      const table = (id: string, name: string, imported: string) => ({
        id, name, projectIds: [], rowCount: 5, sizeBytes: 100, geometryColumn: null, geometryType: null, importedAt: imported, createdAt: t(1), source: "upload", format: "csv", file: "x", crsAssumed: false, headerSuspect: false, sourceFilename: null, sourceParams: null,
      });
      const tables = [
        table("tx1", "table_one", t(6)), table("tx2", "table_two", t(5)), table("tx3", "table_three", t(4)),
        table("tx4", "table_four", t(2)),
      ];
      await context.route("**/api/maps", (route) =>
        route.request().method() === "GET" && !new URL(route.request().url()).searchParams.has("project")
          ? route.fulfill({ json: maps })
          : route.fallback(),
      );
      await context.route(/\/api\/recipes\?origin=workflow$/, (route) =>
        route.fulfill({ json: { recipes: recipes.filter((r) => r.origin === "workflow") } }),
      );
      await context.route("**/api/tables", (route) =>
        route.request().method() === "GET" && !new URL(route.request().url()).searchParams.has("project")
          ? route.fulfill({ json: tables })
          : route.fallback(),
      );
      await page.reload();
      await expect(page.locator("[data-recent-row]")).toHaveCount(6);
      const names = await page.locator("[data-recent-name]").allTextContents();
      expect(names).toEqual(["Map one", "Flow one", "table_one", "table_two", "table_three", "Map three"]);
      // the card stands as tall as its heading and rows, and
      // the content region scrolls to its end. At the 1280×720 contract
      // viewport the plate and six rows exceed the screen.
      await page.setViewportSize({ width: 1280, height: 720 });
      const card = page.locator("[data-recent]");
      await expect
        .poll(async () => {
          const a = (await card.boundingBox())!.height;
          await page.waitForTimeout(120);
          return Math.abs(a - (await card.boundingBox())!.height) < 0.5;
        }, { timeout: 5_000 })
        .toBe(true);
      // Scrolling is needed: the card's end starts below the screen and
      // the home's content region has that much to give; after the
      // region scrolls to its end, the last row and the card's bottom
      // edge are on screen together.
      const before = (await card.boundingBox())!;
      expect.soft(before.y + before.height, "the card's end starts below the screen").toBeGreaterThan(720);
      const content = page.locator("[data-home-content]");
      expect.soft(
        await content.evaluate((el) => el.scrollHeight - el.clientHeight),
        "the content region reaches past the screen",
      ).toBeGreaterThan(0);
      await content.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      expect.soft(await content.evaluate((el) => el.scrollTop), "the content region advanced").toBeGreaterThan(0);
      const c = (await card.boundingBox())!;
      expect.soft(c.y + c.height, "the card's bottom edge is on screen after scrolling").toBeLessThanOrEqual(720);
      const lastRow = (await page.locator("[data-recent-row]").last().boundingBox())!;
      expect.soft(lastRow.y + lastRow.height, "the last row is on screen after scrolling").toBeLessThanOrEqual(720);
      const recentHead = (await page.locator("[data-recent-heading]").locator("xpath=..").boundingBox())!;
      const rowBoxes = await page.locator("[data-recent-row]").evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { y: r.y, h: r.height };
        }),
      );
      for (const r of rowBoxes) {
        expect(r.y, "a recent row starts inside the card").toBeGreaterThanOrEqual(c.y - 0.5);
        expect(r.y + r.h, "a recent row ends inside the card").toBeLessThanOrEqual(c.y + c.height + 0.5);
      }
      expect(c.height, "the card is as tall as its heading and rows").toBeGreaterThanOrEqual(
        recentHead.height + rowBoxes.reduce((sum, r) => sum + r.h, 0) - 1,
      );
      await context.unroute("**/api/maps");
      await context.unroute(/\/api\/recipes\?origin=workflow$/);
      await context.unroute("**/api/tables");
    });

    await test.step("a workspace with nothing eligible says so, without the hint; an unnamed instance heads plainly", async () => {
      await context.route("**/api/maps", (route) =>
        route.request().method() === "GET" && !new URL(route.request().url()).searchParams.has("project")
          ? route.fulfill({ json: [] })
          : route.fallback(),
      );
      await context.route(/\/api\/recipes\?origin=workflow$/, (route) => route.fulfill({ json: { recipes: [] } }));
      await context.route("**/api/tables", (route) =>
        route.request().method() === "GET" && !new URL(route.request().url()).searchParams.has("project")
          ? route.fulfill({ json: [] })
          : route.fallback(),
      );
      await api(page, "PATCH", "/api/settings", { instanceName: null });
      await page.reload();
      await expect(page.locator("[data-recent-none]")).toHaveText("Nothing recent yet.");
      await expect(page.locator("[data-recent-hint]")).toHaveCount(0);
      await expect(page.locator("[data-recent-heading]")).toHaveText("Recent");
      await context.unroute("**/api/maps");
      await context.unroute(/\/api\/recipes\?origin=workflow$/);
      await context.unroute("**/api/tables");
    });

    await test.step("Move on the filed map moves only that map, names the departure, and ends the empty state", async () => {
      await page.reload();
      const mapRow = page.locator("[data-recent-row]").filter({ hasText: P("Elsewhere map") });
      await expect(mapRow).toBeVisible();
      // The change lands but the re-read fails once: said, with a retry
      // never a stale plate. The route is armed
      // only once the page has settled, so it hits the re-read alone.
      let failOnce = true;
      await context.route(`**/api/maps?project=${empty}`, (route) => {
        if (failOnce) {
          failOnce = false;
          return route.fulfill({ status: 500, json: { error: { code: "internal", message: "Re-read failed for the test." } } });
        }
        return route.fallback();
      });
      await mapRow.getByRole("button", { name: `Move ${P("Elsewhere map")}` }).click();
      await expect(page.getByRole("status")).toContainText(`it left ${P("Other shelf")}`);
      await expect(page.getByText(/couldn't be re-read/)).toBeVisible();
      await page.getByRole("button", { name: "Try again" }).click();
      await context.unroute(`**/api/maps?project=${empty}`);
      await expect(page.locator("[data-empty-plate]")).toHaveCount(0);
      await expect(page.locator("[data-recent]")).toHaveCount(0);
      await expect(page.locator("[data-facts] [data-fact]").first()).toHaveText("1 map");
      await expect(page.getByRole("heading", { name: "Maps", exact: true })).toBeVisible();
      await expect(page.locator('[data-sec-card="map"]')).toHaveCount(1);
      await expect(page.getByRole("group", { name: "View" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Export project" })).toBeVisible();
      const moved = (await api(page, "GET", `/api/maps/${mapId}`)) as { projectId: string };
      expect(moved.projectId).toBe(empty);
      const stillUnfiled = (await api(page, "GET", "/api/tables")) as { id: string; projectIds: string[] }[];
      expect(stillUnfiled.find((t) => t.id === tableId)!.projectIds).toEqual([]);
    });

    await test.step("New map from the plate creates in this project and opens the builder", async () => {
      const shelf = await project(P("Second shelf"));
      await page.goto(`/projects/${shelf}`);
      // A double press makes one map.
      await page.locator("[data-empty-plate]").getByRole("button", { name: "New map", exact: true }).dblclick();
      await expect(page).toHaveURL(/\/maps\/[A-Za-z0-9_-]+$/);
      const created = ((await api(page, "GET", `/api/maps?project=${shelf}`)) as { id: string }[]);
      expect(created.length).toBe(1);
    });

    await test.step("Add data from the plate: an upload lands in this project", async () => {
      const shelf = await project(P("Third shelf"));
      await page.goto(`/projects/${shelf}`);
      await page.locator("[data-empty-plate]").getByRole("button", { name: "Add data", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Add data" })).toBeVisible();
      const seen: string[] = [];
      await context.route("**/api/tables?project=*", (route) => {
        seen.push(new URL(route.request().url()).searchParams.get("project") ?? "");
        return route.fallback();
      });
      await page.locator('input[type="file"]').setInputFiles({
        name: `em_up_${run}.csv`,
        mimeType: "text/csv",
        buffer: Buffer.from("name,lng,lat\nU,7.1,53.5\n"),
      });
      await expect.poll(() => seen.length, { timeout: 60_000 }).toBeGreaterThan(0);
      expect(seen[0]).toBe(shelf);
      await expect(page.getByRole("heading", { name: "Data", exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(page.locator("[data-empty-plate]")).toHaveCount(0);
      const filed = (await api(page, "GET", `/api/tables?project=${shelf}`)) as { name: string }[];
      expect(filed.map((t) => t.name)).toEqual([`em_up_${run}`]);
      await context.unroute("**/api/tables?project=*");
    });

    await test.step("New workflow from the plate asks for a name, then opens the canvas on a filed workflow", async () => {
      const shelf = await project(P("Fourth shelf"));
      await page.goto(`/projects/${shelf}`);
      await page.locator("[data-empty-plate]").getByRole("button", { name: "New workflow", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "New workflow" });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Name", { exact: true }).fill("");
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(dialog.getByText("Give it a name.")).toBeVisible();
      await dialog.getByLabel("Name", { exact: true }).fill(P("Shelf flow"));
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page).toHaveURL(/\/workflows\/[A-Za-z0-9_-]+$/);
      const created = (await api(page, "GET", `/api/recipes?origin=workflow&project=${shelf}`)) as { recipes: { name: string }[] };
      expect(created.recipes.map((r) => r.name)).toEqual([P("Shelf flow")]);
    });
  } finally {
    await api(page, "PATCH", "/api/settings", { instanceName: null }).catch(() => {});
    for (const id of made) await api(page, "DELETE", `/api/projects/${id}`).catch(() => {});
  }
});

// In the ruled window, the head's Add opens
// the project-first picker at one size; three tabs over what is not in
// the project, the search, selections kept across tabs, one atomic
// change that brings a map's datasets and their producers and a
// workflow's datasets, each once; a refusal changes nothing.
test("the project-first picker: three tabs, one atomic change with what it brings", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  const run = `${runId}k`;
  const P = (word: string) => `${word} ${run}`;
  const made: string[] = [];
  const project = async (name: string) => {
    const p = (await api(page, "POST", "/api/projects", { name })) as { id: string };
    made.push(p.id);
    return p.id;
  };
  await page.goto("/projects");
  let home = "";
  let other = "";
  let mapId = "";
  let wfId = "";
  let tShared = "";
  let tMapOnly = "";
  let tOut = "";
  try {
    await test.step("seed: a map elsewhere drawing two datasets (one a workflow's output), a shared dataset, a workflow reading it", async () => {
      home = await project(P("Picker home"));
      other = await project(P("Elsewhere"));
      await seedCsv(page, `pk_src_${run}`, "name,lng,lat\nA,7.1,53.5\nB,7.2,53.4\n");
      await seedCsv(page, `pk_map_${run}`, "name,lng,lat\nC,7.3,53.3\n");
      const tables = () => api(page, "GET", "/api/tables") as Promise<{ id: string; name: string }[]>;
      tShared = (await tables()).find((t) => t.name === `pk_src_${run}`)!.id;
      tMapOnly = (await tables()).find((t) => t.name === `pk_map_${run}`)!.id;
      // The shared dataset lives in Elsewhere already.
      await api(page, "PATCH", `/api/projects/${other}/members`, { addTables: [tShared] });
      // A workflow reading the shared dataset and writing an output.
      wfId = ((await api(page, "POST", "/api/recipes", { name: P("Producer") })) as { recipe: { id: string } }).recipe.id;
      await api(page, "POST", `/api/recipes/${wfId}/steps`, {
        operation: "sql_step",
        parameters: { sql: `SELECT * FROM pk_src_${run}`, name: `pk_out_${run}` },
      });
      const run1 = (await api(page, "POST", `/api/recipes/${wfId}/runs`, {})) as { id: string };
      await expect
        .poll(
          async () => {
            const body = (await api(page, "GET", `/api/recipes/${wfId}`)) as { recipe: { steps: { latestAttempt: { state: string } | null }[] } };
            return body.recipe.steps[0]?.latestAttempt?.state ?? "";
          },
          { timeout: 60_000 },
        )
        .toBe("succeeded");
      void run1;
      tOut = (await tables()).find((t) => t.name === `pk_out_${run}`)!.id;
      // A map in Elsewhere drawing the output and the map-only dataset.
      mapId = ((await api(page, "POST", "/api/maps", { name: P("Layered map"), projectId: other })) as { id: string }).id;
      await readThenWriteBrowserSetup(page, `/api/maps/${mapId}`, () => ({ method: "POST", path: `/api/maps/${mapId}/layers`, body: { name: `pk_out_${run}`, sql: `SELECT * FROM pk_out_${run}` } }));
      await readThenWriteBrowserSetup(page, `/api/maps/${mapId}`, () => ({ method: "POST", path: `/api/maps/${mapId}/layers`, body: { name: `pk_map_${run}`, sql: `SELECT * FROM pk_map_${run}` } }));
      // The map-only dataset is already in the home: the picker must
      // neither count it as brought nor send it again.
      await api(page, "PATCH", `/api/projects/${home}/members`, { addTables: [tMapOnly] });
    });

    await test.step("while the workspace read fails, the tabs show no counts and the failure is said", async () => {
      await context.route("**/api/maps", (route) =>
        route.request().method() === "GET" && !new URL(route.request().url()).searchParams.has("project")
          ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Workspace read failed for the test." } } })
          : route.fallback(),
      );
      await page.goto(`/projects/${home}`);
      await page.getByRole("button", { name: "Add to project", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `Add to ${P("Picker home")}` });
      await expect(dialog.getByText("Workspace read failed for the test.")).toBeVisible();
      await expect(dialog.locator("[data-tab-count]")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await context.unroute("**/api/maps");
    });

    await test.step("the head's Add opens the window on Maps; the tabs count what is not in the project", async () => {
      await page.goto(`/projects/${home}`);
      await expect(page.getByRole("heading", { name: "Data", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Add to project", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `Add to ${P("Picker home")}` });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("tab", { name: /^Maps/ })).toHaveAttribute("aria-selected", "true");
      const row = dialog.locator("[data-picker-row]").filter({ hasText: P("Layered map") });
      await expect(row).toBeVisible();
      await expect(row.locator("[data-picker-where]")).toHaveText(`in ${P("Elsewhere")}`);
      await expect(dialog.locator("[data-picker-status]")).toHaveText("Nothing picked");
      await expect(dialog.getByRole("button", { name: /^Add \d+ item/ })).toBeDisabled();
      // The window keeps one height across the tabs, measured once the
      // entrance animation has settled.
      const settled = async () => {
        let last = -1;
        await expect
          .poll(async () => {
            const h = (await dialog.boundingBox())!.height;
            const same = Math.abs(h - last) < 0.5;
            last = h;
            return same;
          }, { timeout: 5_000, intervals: [120, 120, 120, 200, 300] })
          .toBe(true);
        return last;
      };
      const h1 = await settled();
      await dialog.getByRole("tab", { name: /^Data/ }).click();
      const h2 = await settled();
      expect(Math.abs(h1 - h2)).toBeLessThan(1);
      await expect(dialog.locator("[data-picker-row]").filter({ hasText: `pk_src_${run}` })).toBeVisible();
      // Search within the tab; a miss says so; the query clears on a tab change.
      await dialog.getByRole("searchbox").fill("zzz-nothing");
      await expect(dialog.locator("[data-picker-empty]")).toHaveText("Nothing matches.");
      await dialog.getByRole("tab", { name: /^Workflows/ }).click();
      await expect(dialog.getByRole("searchbox")).toHaveValue("");
      await expect(dialog.locator("[data-picker-row]").filter({ hasText: P("Producer") })).toBeVisible();
    });

    await test.step("pick a map, a workflow and a dataset across tabs; the footer counts each object once", async () => {
      const dialog = page.getByRole("dialog", { name: `Add to ${P("Picker home")}` });
      await dialog.locator("[data-picker-row]").filter({ hasText: P("Producer") }).getByRole("checkbox").check();
      await dialog.getByRole("tab", { name: /^Maps/ }).click();
      const mapRow = dialog.locator("[data-picker-row]").filter({ hasText: P("Layered map") });
      await mapRow.getByRole("checkbox").check();
      await expect(mapRow.locator("[data-picker-sub]")).toContainText(`moves out of ${P("Elsewhere")}`);
      await expect(mapRow.locator("[data-picker-sub]")).toContainText("brings", { timeout: 15_000 });
      await dialog.getByRole("tab", { name: /^Data/ }).click();
      await dialog.locator("[data-picker-row]").filter({ hasText: `pk_src_${run}` }).getByRole("checkbox").check();
      // The selection survives a tab change and a search.
      await dialog.getByRole("tab", { name: /^Workflows/ }).click();
      await expect(dialog.locator("[data-picker-row]").filter({ hasText: P("Producer") }).getByRole("checkbox")).toBeChecked();
      // Picked: 1 map, 1 workflow, 1 dataset. Brought: the map's output
      // dataset only — pk_map is already in the home, pk_src is picked
      // itself and the workflow reads it, the map's producer is the
      // picked workflow. So 1 brought.
      await expect(dialog.locator("[data-picker-status]")).toHaveText("1 map · 1 workflow · 1 dataset · 1 they bring", { timeout: 15_000 });
      await expect(dialog.getByRole("button", { name: "Add 4 items" })).toBeEnabled();
    });

    await test.step("a refusal changes nothing; the confirmed change lands atomically", async () => {
      const dialog = page.getByRole("dialog", { name: `Add to ${P("Picker home")}` });
      let sent: unknown = null;
      await context.route(`**/api/projects/${home}/members`, (route) => {
        if (route.request().method() !== "PATCH") return route.fallback();
        sent = route.request().postDataJSON();
        return route.fulfill({ status: 409, json: { error: { code: "conflict", message: "Refused for the test." } } });
      });
      await dialog.getByRole("button", { name: "Add 4 items" }).click();
      await expect(dialog.getByText("Refused for the test.")).toBeVisible();
      // What the home already holds is not sent again.
      expect((sent as { addTables: string[] }).addTables).not.toContain(tMapOnly);
      await expect(dialog).toBeVisible();
      const before = (await api(page, "GET", `/api/maps/${mapId}`)) as { projectId: string };
      expect(before.projectId).toBe(other);
      await context.unroute(`**/api/projects/${home}/members`);
      await dialog.getByRole("button", { name: "Add 4 items" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("status")).toContainText(`Added 4 items to ${P("Picker home")}`);
      // The home shows every kind now; the objects moved and joined.
      await expect(page.getByRole("heading", { name: "Maps", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Data", exact: true })).toBeVisible();
      const movedMap = (await api(page, "GET", `/api/maps/${mapId}`)) as { projectId: string };
      expect(movedMap.projectId).toBe(home);
      const wf = (await api(page, "GET", `/api/recipes/${wfId}`)) as { recipe: { projectId: string } };
      expect(wf.recipe.projectId).toBe(home);
      const tables = (await api(page, "GET", "/api/tables")) as { id: string; projectIds: string[] }[];
      const ids = (id: string) => tables.find((t) => t.id === id)!.projectIds.sort();
      expect(ids(tShared)).toEqual([home, other].sort());
      expect(ids(tMapOnly)).toEqual([home]);
      expect(ids(tOut)).toEqual([home]);
      // Reopened, the picker no longer offers what joined.
      await page.getByRole("button", { name: "Add to project", exact: true }).click();
      const again = page.getByRole("dialog", { name: `Add to ${P("Picker home")}` });
      await expect(again.locator("[data-picker-row]").filter({ hasText: P("Layered map") })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(again).toHaveCount(0);
    });
  } finally {
    for (const id of made) await api(page, "DELETE", `/api/projects/${id}`).catch(() => {});
    if (wfId) await api(page, "DELETE", `/api/recipes/${wfId}`).catch(() => {});
  }
});
