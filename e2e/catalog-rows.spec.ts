import type { EditBasis } from "../src/lib/edit-basis";
// The add-layer catalog's row: under the Tables source and the SQL
// query source alike, the row reads capsule, name, count from left to
// right and nothing else — no membership tag — the name set from the
// left of its box in the table face, the facts the row count alone in
// the interface face at the row's right edge; no size. An overlong name
// still clips with an ellipsis. Red on main: the button centres the
// name, and the facts read "n rows · n KB" in the table face; red on
// main: the filed row wears "in <project>". Residue-proof: every seeded
// name carries the run id.
import { test, expect, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { createMap, routeHouse, seedCsv, trackConsole } from "./support";

const runId = Date.now().toString(36);
const MAP = `Rows map ${runId}`;
const PROJECT = `Rows shelf ${runId}`;
const PROJECT_B = `Rows annex ${runId}`;
const TABLE = `rows_${runId}`;
const ONE = `rows_one_${runId}`;
const LONG = `rows_long_${runId}_${"x".repeat(56)}`;
const ROWS = 1234;

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

/** What a row renders, measured in the page: faces, edges, order. */
const measure = (row: ReturnType<Page["locator"]>, tableName: string) =>
  row.evaluate((el, name) => {
    const spans = Array.from(el.querySelectorAll("span"));
    const nameEl = spans.find((s) => s.textContent === name)!;
    const factsEl = spans[spans.length - 1];
    const tagEl = spans.find((s) => /^(also )?in /.test(s.textContent ?? ""));
    const capsule = el.firstElementChild!;
    const cs = (n: Element) => getComputedStyle(n);
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const rowRect = el.getBoundingClientRect();
    const left = (n: Element) => n.getBoundingClientRect().left;
    const norm = (t: string | null) => (t ?? "").replace(/\s+/g, " ").trim();
    return {
      // The row's whole visible reading, the capsule's word first.
      reading: norm((el as HTMLElement).innerText),
      facts: factsEl.textContent,
      nameFont: cs(nameEl).fontFamily,
      factsFont: cs(factsEl).fontFamily,
      bodyFont: cs(document.body).fontFamily,
      nameBoxLeft: left(nameEl),
      nameTextLeft: range.getBoundingClientRect().left,
      nameOverflows: nameEl.scrollWidth > nameEl.clientWidth,
      nameEllipsis: cs(nameEl).textOverflow,
      factsRight: factsEl.getBoundingClientRect().right,
      rowInnerRight:
        rowRect.right -
        parseFloat(cs(el).paddingRight) -
        parseFloat(cs(el).borderRightWidth),
      order: [
        left(capsule),
        left(nameEl),
        tagEl ? left(tagEl) : null,
        left(factsEl),
      ],
      tag: tagEl?.textContent ?? null,
    };
  }, tableName);

test("the catalog row reads name left, count right", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");

  let mapId = "";
  await test.step("seed a filed 1,234-row table, an overlong name, a map", async () => {
    const lines = ["name,lng,lat"];
    for (let i = 0; i < ROWS; i++) {
      lines.push(
        `p${i},${(7 + (i % 100) / 1000).toFixed(3)},${(53 + (i % 50) / 1000).toFixed(3)}`,
      );
    }
    await seedCsv(page, TABLE, `${lines.join("\n")}\n`);
    await seedCsv(page, LONG, "name,lng,lat\nBuoy,7.10,53.52\n");
    // The one-project fixture: two rows, filed in the first project only.
    await seedCsv(page, ONE, "name,lng,lat\nBuoy,7.10,53.52\nPier,7.11,53.53\n");
    const pid = (
      (await api(page, "POST", "/api/projects", { name: PROJECT })) as {
        id: string;
      }
    ).id;
    const pidB = (
      (await api(page, "POST", "/api/projects", { name: PROJECT_B })) as {
        id: string;
      }
    ).id;
    const tables = (await api(page, "GET", "/api/tables")) as {
      id: string;
      name: string;
    }[];
    // Shared between two projects: under All it would say "in A and B",
    // under A's scope "also in B" (the wordings, both gone).
    const tableId = tables.find((t) => t.name === TABLE)!.id;
    const oneId = tables.find((t) => t.name === ONE)!.id;
    await api(page, "PATCH", `/api/projects/${pid}/members`, {
      addTables: [tableId, oneId],
    });
    await api(page, "PATCH", `/api/projects/${pidB}/members`, {
      addTables: [tableId],
    });
    mapId = (
      (await api(page, "POST", "/api/maps", { name: MAP })) as { id: string }
    ).id;
  });

  await page.goto(`/maps/${mapId}`);
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add layer" });
  await expect(dialog).toBeVisible();

  // The dialog grows into its wide frame when the SQL source takes
  // over; a measurement taken mid-growth reads a row a third its
  // settled width. Wait until the dialog's width holds still.
  const settled = async () => {
    await expect
      .poll(async () => {
        const before = (await dialog.boundingBox())!.width;
        await page.waitForTimeout(150);
        return (await dialog.boundingBox())!.width === before;
      })
      .toBe(true);
  };

  const pickScope = async (name: string) => {
    await dialog.getByRole("button", { name: "Filter by project" }).click();
    // The menu portals to the document body, outside the dialog's DOM.
    await page.getByRole("menuitem", { name }).click();
    await expect(
      dialog.getByRole("button", { name: "Filter by project" }),
    ).toContainText(name);
  };

  for (const source of ["Tables", "SQL query"]) {
    await test.step(`under ${source}`, async () => {
      await dialog.getByRole("button", { name: source }).click();
      await settled();
      await pickScope("All projects");
      const row = dialog.getByRole("button", { name: TABLE, exact: true });
      await expect(row).toBeVisible();
      // The facts: the count with its separator and the word, nothing
      // else — no dot, no size.
      await expect(row.locator("span").last()).toHaveText("1,234 rows");

      const m = await measure(row, TABLE);
      // The measured row, as evidence in the run log.
      console.log(`${source}: ${JSON.stringify(m)}`);
      expect(
        Math.abs(m.nameTextLeft - m.nameBoxLeft),
        `${source}: the name's glyphs start at its box's left edge`,
      ).toBeLessThanOrEqual(1);
      expect(
        /mono/i.test(m.nameFont),
        `${source}: the name keeps the table face (${m.nameFont})`,
      ).toBe(true);
      expect(
        /mono/i.test(m.factsFont),
        `${source}: the facts leave the table face (${m.factsFont})`,
      ).toBe(false);
      expect(m.factsFont, `${source}: the facts wear the interface face`).toBe(
        m.bodyFont,
      );
      expect(
        Math.abs(m.factsRight - m.rowInnerRight),
        `${source}: the facts end at the row's inner right edge`,
      ).toBeLessThanOrEqual(1);
      // No membership hint under the All scope: the row's whole visible
      // text is the capsule's word — "point", known from the seeded
      // geometry, never read off the row — the name and the count,
      // nothing else. The one-project table is the spec's first fixture
      // (red on main: "in A"); the shared table rides along (red on
      // main: "in A and B"). Soft, so a red run reports every wording
      // in one pass.
      const one = dialog.getByRole("button", { name: ONE, exact: true });
      await expect(one).toBeVisible();
      const om = await measure(one, ONE);
      expect.soft(om.reading, `${source}, All: the one-project row`).toBe(
        `point ${ONE} 2 rows`,
      );
      // The count at the edge for THIS fixture too: the claim is
      // conjunctive over all four cases.
      expect(
        Math.abs(om.factsRight - om.rowInnerRight),
        `${source}, All: the one-project row's count ends at the inner right edge`,
      ).toBeLessThanOrEqual(1);
      expect.soft(m.reading, `${source}, All: the shared row`).toBe(
        `point ${TABLE} 1,234 rows`,
      );
      const [capsule, name, , facts] = m.order as [
        number,
        number,
        number | null,
        number,
      ];
      expect(capsule, `${source}: the capsule leads`).toBeLessThan(name);
      expect(name, `${source}: the name precedes the facts`).toBeLessThan(facts);

      // Under one of its projects' scope the shared table said "also in
      // <the other>" on main (the spec's second fixture); now the same
      // reading, the count still at the edge. The one-project table
      // under its own scope had no hint on main either: preservation.
      await pickScope(PROJECT);
      const scoped = dialog.getByRole("button", { name: TABLE, exact: true });
      await expect(scoped).toBeVisible();
      const sm = await measure(scoped, TABLE);
      expect.soft(sm.reading, `${source}, ${PROJECT}: the shared row`).toBe(
        `point ${TABLE} 1,234 rows`,
      );
      const oneScoped = dialog.getByRole("button", { name: ONE, exact: true });
      await expect(oneScoped).toHaveText(`point${ONE}2 rows`);
      const osm = await measure(oneScoped, ONE);
      expect(
        Math.abs(osm.factsRight - osm.rowInnerRight),
        `${source}, ${PROJECT}: the one-project row's count ends at the inner right edge`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(sm.factsRight - sm.rowInnerRight),
        `${source}, scoped: the facts end at the row's inner right edge`,
      ).toBeLessThanOrEqual(1);
      await pickScope("All projects");

      // The overlong name clips with an ellipsis; its facts stay put.
      const longRow = dialog.getByRole("button", { name: LONG, exact: true });
      await expect(longRow).toBeVisible();
      const l = await measure(longRow, LONG);
      console.log(`${source} (overlong): ${JSON.stringify(l)}`);
      expect(l.nameOverflows, `${source}: the overlong name overflows its box`).toBe(true);
      expect(l.nameEllipsis, `${source}: and clips with an ellipsis`).toBe("ellipsis");
      expect(
        Math.abs(l.factsRight - l.rowInnerRight),
        `${source}: the overlong row's facts still end at the right edge`,
      ).toBeLessThanOrEqual(1);
    });
  }
});

// The catalog note's door: a picked non-spatial file upload's note
// carries Set geometry; it leaves the builder for the dataset page with
// the panel open; after apply the row reads the geometry and Add layer
// is on. Red on main: the note has no door.
test("the catalog's non-spatial note carries the set-geometry door for an upload, and reads the geometry after apply", async ({ page, context }, info) => {
  await routeHouse(context, { basemapStyleStub: true });
  const errors = trackConsole(page);
  const table = `door_${runId}`;
  await page.goto("/data");
  await seedCsv(page, table, ["name,geom_wkt", 'A,"POINT(8.6 50.1)"', 'B,"POINT(8.7 50.2)"', "C,broken"].join("\n"));
  const mapId = await createMap(page, `Door map ${runId}`);
  await page.goto(`/maps/${mapId}`);
  const pickTable = async () => {
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add layer" });
    await dialog.getByRole("button", { name: "Tables" }).click();
    await dialog.getByRole("button", { name: table, exact: true }).click();
    await expect(dialog).toContainText("No geometry column. Still usable in the SQL source.");
    return dialog;
  };
  const accent = () =>
    page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const got = getComputedStyle(probe).color;
      probe.remove();
      return got;
    });
  // The dialog is modal: the theme is switched with it closed and the table picked again under each
  // theme.
  for (const theme of ["light", "dark"] as const) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme ?? "light")) !== theme) {
      await page.getByRole("button", { name: "Switch between dark and light theme" }).click();
    }
    const dialog = await pickTable();
    const door = dialog.locator('[data-set-geometry-door="catalog"]');
    await expect(door).toHaveText("Set geometry");
    await expect(dialog.getByRole("button", { name: "Add layer", exact: true })).toBeDisabled();
    expect(await door.evaluate((el) => getComputedStyle(el).color), `${theme}: the door's ink`).toBe(await accent());
    await info.attach(`catalog-door-${theme}`, { body: await page.screenshot(), contentType: "image/png" });
    if (theme === "light") {
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }
  }
  const door = page.getByRole("dialog", { name: "Add layer" }).locator('[data-set-geometry-door="catalog"]');
  await door.click();
  await expect(page).toHaveURL(new RegExp(`/tables/${table}\\?geometry=set$`));
  await expect(page.locator("[data-set-geometry-panel]")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-set-geometry-panel]")).toContainText("2 of 3 sampled rows read as points.");
  await page.locator("[data-set-geometry-panel]").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator("[data-set-geometry-panel]")).toHaveCount(0);
  // Under the address: once the page's re-read has landed, the same address
  // must not reopen the panel; the wait outlasts a mount-time open and its inspection round trip.
  await expect(page.getByText(/Geometry: geom_wkt read as WKT text/)).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-set-geometry-panel]")).toHaveCount(0);
  await page.goto(`/maps/${mapId}`);
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  const again = page.getByRole("dialog", { name: "Add layer" });
  await again.getByRole("button", { name: "Tables" }).click();
  const row = again.getByRole("button", { name: table, exact: true });
  await expect(row).toContainText(/point/i);
  await row.click();
  await expect(again).not.toContainText("No geometry column");
  await expect(again.getByRole("button", { name: "Add layer", exact: true })).toBeEnabled();
  expect(errors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
  await context.close();
});
