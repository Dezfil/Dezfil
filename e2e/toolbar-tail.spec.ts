// The list toolbar's tail: the Sort control and the Grid/List toggle are
// one unit at the toolbar's right end. Across the width band where the
// toolbar wraps, the toggle never sits on a line of its own and never at
// the left: at every width it shares the Sort control's top edge and the
// toolbar's right edge. On the three scoped screens the band runs under
// a project with a deliberately long name, the pressure a real project
// name applies. Red on main in the band where the toggle
// wraps alone (the last flex member drops first, to the left).
// Residue-proof: each screen only needs one item, seeded here and filed
// into the long-named project.
import { test, expect, type Page } from "@playwright/test";
import { routeHouse, seedCsv } from "./support";

const runId = Date.now().toString(36);
const LONG = `A deliberately long project name for the toolbar band ${runId}`;

const api = (page: Page, method: string, pathName: string, body?: unknown) =>
  page.evaluate(
    async ({ method, pathName, body }) => {
      const r = await fetch(pathName, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok && r.status !== 204) throw new Error(await r.text());
      const text = r.status === 204 ? "" : await r.text();
      return text ? (JSON.parse(text) as unknown) : null;
    },
    { method, pathName, body },
  );

const lists: { route: string; sort: string; scoped: boolean }[] = [
  { route: "/maps", sort: "Sort maps", scoped: true },
  { route: "/workflows", sort: "Sort workflows", scoped: true },
  { route: "/data", sort: "Sort tables", scoped: true },
  { route: "/projects", sort: "Sort projects", scoped: false },
];

// 1440 down to 640 in 40 px steps: a step narrower than the band where
// a lone toggle (about 86 px with its gap) could hide between two
// steps, and a floor low enough that even the Projects toolbar — search
// and tail only — reaches a wrapped width.
const widths: number[] = [];
for (let w = 1440; w >= 640; w -= 40) widths.push(w);

test("the toolbar's tail wraps as one, to the right", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");

  await test.step("seed one of each, filed in the long-named project", async () => {
    const pid = (
      (await api(page, "POST", "/api/projects", { name: LONG })) as {
        id: string;
      }
    ).id;
    const mapId = (
      (await api(page, "POST", "/api/maps", { name: `Tail map ${runId}` })) as {
        id: string;
      }
    ).id;
    const recipeId = (
      (await api(page, "POST", "/api/recipes", {
        name: `Tail flow ${runId}`,
      })) as { recipe: { id: string } }
    ).recipe.id;
    const tableName = `tail_${runId}`;
    await seedCsv(page, tableName, "name,lng,lat\nBuoy,7.10,53.52\n");
    const tables = (await api(page, "GET", "/api/tables")) as {
      id: string;
      name: string;
    }[];
    const tableId = tables.find((t) => t.name === tableName)!.id;
    await api(page, "PATCH", `/api/projects/${pid}/members`, {
      addMaps: [mapId],
      addRecipes: [recipeId],
      addTables: [tableId],
    });
  });

  try {
    for (const { route, sort, scoped } of lists) {
      await test.step(`${route} across the band`, async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(route);
        if (scoped) {
          // The pressure a real name applies: a long project name on the filter.
          await page.getByRole("button", { name: "Filter by project" }).click();
          await page.getByRole("menuitem", { name: LONG }).click();
          await expect(
            page.getByRole("button", { name: "Filter by project" }),
          ).toContainText(LONG);
        }
        const select = page.getByLabel(sort);
        // The Sort control is the label around the select; the toolbar
        // is the row that holds it.
        const sortBox = select.locator("xpath=..");
        const toolbar = select.locator(
          "xpath=ancestor::div[contains(@class,'toolbar')][1]",
        );
        const toggle = page.getByRole("group", { name: "View" });
        await expect(toggle).toBeVisible();
        let oneLine: number | null = null;
        let wrapped: number | null = null;
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => r(null))),
          );
          const s = (await sortBox.boundingBox())!;
          const v = (await toggle.boundingBox())!;
          const t = (await toolbar.boundingBox())!;
          expect(
            Math.abs(v.y - s.y),
            `${route} at ${width}: the toggle shares the Sort control's top edge`,
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs(v.x + v.width - (t.x + t.width)),
            `${route} at ${width}: the toggle sits at the toolbar's right edge`,
          ).toBeLessThanOrEqual(1);
          if (s.y > t.y + 1) wrapped = wrapped ?? width;
          else oneLine = oneLine ?? width;
        }
        // Both states must be observed, or the loop above proves
        // nothing about wrapping (raised at review).
        expect(oneLine, `${route}: a one-line width was observed`).not.toBeNull();
        expect(wrapped, `${route}: a wrapped width was observed`).not.toBeNull();
        console.log(
          `${route}: one line at ${oneLine} px, wrapped from ${wrapped} px`,
        );
      });
    }
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});
