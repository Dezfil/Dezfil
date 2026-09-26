// The statistics verbs in the drawer.
//
// **Again, the point is what is *not* in the diff.** Three verbs were added to
// the catalog and no UI code was written for any of them: the picker files them
// under a group heading it read from the catalog, their forms render from their
// declared parameters — including a checkbox and an enum whose companion field
// is conditional — and their rows read the API's own sentence.
//
// So this file exercises the two things the earlier file could not: a **boolean**
// parameter authored from the form, and a verb whose output is drawn as H3
// cells. The hexagons landing on Berlin rather than in the Gulf of Guinea is
// the browser-visible half of the axis-order hazard the unit suite pins.
//
// Environment: the documented gate (isolated server, fresh data dir).
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { addLayer, createMap, routeHouse, seedFile, trackConsole } from "./support";

const runId = Date.now().toString(36);
const sightings = `stats_${runId}`;
const WIDE = { width: 1440, height: 900 };

/** Twelve points in three tight groups near Berlin, plus one on its own — so a
 * hotspot has cells of unequal weight and clustering has something to join. */
function sightingsCsv(): string {
  const rows = ["name,lon,lat,weight"];
  ([
    [13.4, 52.5, 5],
    [13.5, 52.5, 4],
    [13.45, 52.6, 2],
  ] as [number, number, number][]).forEach(([lon, lat, n], c) => {
    for (let i = 0; i < n; i += 1) {
      rows.push(`c${c}p${i},${lon + i * 0.0005},${lat + i * 0.0005},${i + 1}`);
    }
  });
  rows.push("alone,13.9,52.9,1");
  return rows.join("\n") + "\n";
}

async function seedMap(page: Page): Promise<string> {
  await page.goto("/data");
  await seedFile(page, `${sightings}.csv`, sightingsCsv(), "text/csv");
  await page.goto("/maps");
  const mapId = await createMap(page, `stats ${runId}`);
  await addLayer(page, mapId, `Sightings ${runId}`, `SELECT * FROM ${sightings}`);
  return mapId;
}

test("the statistics verbs are offered, authored and drawn, with no UI of their own", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);

  await test.step("the picker files all three under a group it read from the catalog", async () => {
    if ((await page.locator('li[data-selected="true"]').count()) === 0) {
    await page.locator("[data-layer-select]").first().click();
  }
  await page.locator("[data-tools-control]").click();
        await expect(page.locator("[data-operation-picker]")).toBeVisible();
    for (const id of ["h3_cell", "hotspot", "cluster_by_distance"]) {
      await expect(
        page.locator(`[data-operation='${id}']`),
        `the picker offers ${id}`,
      ).toHaveCount(1);
    }
    await expect(
      page.locator("[data-operation-picker]").getByText("Statistics", {
        exact: true,
      }),
    ).toBeVisible();
  });

  const hexed = `hexed_${runId}`;
  await test.step("a boolean parameter: assign cells, redrawn as the cells themselves", async () => {
    await page.locator("[data-operation='h3_cell']").click();
    await expect(page.locator("[data-parameter-form]")).toBeVisible();
    // The resolution arrives with the catalog's default already in it.
    await expect(page.locator("[data-param='resolution']")).toHaveValue("8");
    await page.locator("[data-param='resolution']").fill("7");
    // The checkbox is the parameter shape this spec adds to the drawer's
    // repertoire: off by default (G4), and turned on here so the result draws
    // as cells rather than as the input's own points.
    const boundary = page.locator("[data-param='boundary']");
    await expect(boundary).not.toBeChecked();
    // The switch is seen, not assumed: a native checkbox in
    // track-and-thumb clothing, meeting the Wheelhouse 24px hit floor,
    // whose track visibly changes state — a revert to the bare checkbox
    // fails here, not at a field round again.
    await expect(boundary).toHaveAttribute("role", "switch");
    const off = await boundary.evaluate((el) => {
      const style = getComputedStyle(el, "::after");
      const thumb = getComputedStyle(el, "::before");
      const box = el.getBoundingClientRect();
      return {
        track: style.backgroundColor,
        radius: style.borderRadius,
        thumbW: thumb.width,
        thumbRadius: thumb.borderRadius,
        thumbShift: thumb.transform,
        h: box.height,
        w: box.width,
      };
    });
    expect(off.radius).toBe("999px");
    expect(off.h).toBeGreaterThanOrEqual(24);
    expect(off.w).toBeGreaterThanOrEqual(24);
    // The thumb is a real drawn circle, and checking moves it — losing ::before would keep the
    // track alive and this red.
    expect(off.thumbW).toBe("16px");
    expect(off.thumbRadius).toBe("999px");
    await boundary.check();
    // Polled, not read at once: the track's colour is mid-transition the
    // instant after the click, and t=0 still computes the off grey.
    await expect
      .poll(() =>
        boundary.evaluate((el) => getComputedStyle(el, "::after").backgroundColor),
      )
      .not.toBe(off.track);
    await expect
      .poll(() =>
        boundary.evaluate((el) => getComputedStyle(el, "::before").transform),
      )
      .not.toBe(off.thumbShift);
    await page.locator("[data-output-name]").fill(hexed);
    await page.locator("[data-form-run]").click();
    await expect(page.locator("[data-run-notice]")).toContainText(hexed, {
      timeout: 90_000,
    });
  });

  const hot = `hot_${runId}`;
  await test.step("a hotspot scores the cells and says how many neighbours it used", async () => {
    await page.locator("[data-run-another]").click();
    await page.locator("[data-operation='hotspot']").click();
    await expect(page.locator("[data-parameter-form]")).toBeVisible();
    // The list arrives on focus, then the row picks.
    await page.locator("[data-parameter-form] input[type='search']").first().click();
    await page.locator(`[data-table-row='${sightings}']`).click();
    await page.locator("[data-param='resolution']").fill("7");
    await page.locator("[data-output-name]").fill(hot);
    await page.locator("[data-form-run]").click();
    await expect(page.locator("[data-run-notice]")).toContainText(hot, {
      timeout: 90_000,
    });
  });

  await test.step("a refusal reaches the user as a sentence, not a stack", async () => {
    // Resolution 16 is outside H3's own range. The engine answers *null* there
    // rather than failing, so a run that reached it would succeed with a column
    // of nothing — which is why it never leaves the form: with `min`/`max`
    // served by the catalog, the range is said at the field itself and no dry
    // run fires on a value the form already knows is refused.
    await page.locator("[data-run-another]").click();
    await page.locator("[data-operation='h3_cell']").click();
    await page.locator("[data-parameter-form] input[type='search']").first().click();
    await page.locator(`[data-table-row='${sightings}']`).click();
    // The default resolution (8) legitimately dry-runs at pick time, so the
    // violation is not "a request" but "a request carrying 16" — the value
    // the form already knows the catalog refuses.
    let askedWithSixteen = false;
    await page.route("**/api/operations/run**", (route) => {
      if (/"resolution"\s*:\s*16\b/.test(route.request().postData() ?? "")) {
        askedWithSixteen = true;
      }
      return route.continue();
    });
    await page.locator("[data-param='resolution']").fill("16");
    await page.locator("[data-output-name]").fill(`refused_${runId}`);
    await expect(page.locator("[data-bounds-problem='resolution']")).toContainText(
      /0 to 15/,
    );
    await expect(page.locator("[data-form-run]")).toBeDisabled();
    // The dry run debounces 350 ms, so an absence read at once would pass
    // even if a request were scheduled — the interception outlives the
    // debounce before it speaks.
    await page.waitForTimeout(900);
    // The gate held without a request — the refusal is the form's own.
    expect(askedWithSixteen).toBe(false);
    await page.unroute("**/api/operations/run**");
  });

  await test.step("the cells draw where the points are, not where transposed axes would put them", async () => {
    const bounds = await page.evaluate(async (table: string) => {
      // The geometry column is named by whichever ingest path made the table —
      // `geometry` from the CSV builder, `geom` from a verb that writes its
      // own — so it is read rather than assumed.
      const described = await fetch(`/api/tables/${table}`, { cache: "no-store" });
      const { geometryColumn } = (await described.json()) as {
        geometryColumn: string;
      };
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT ST_XMin(ST_Extent_Agg("${geometryColumn}")) AS min_lon,
                       ST_YMin(ST_Extent_Agg("${geometryColumn}")) AS min_lat
                FROM ${table}`,
        }),
      });
      const body = (await response.json()) as {
        preview: { min_lon: number; min_lat: number }[];
      };
      return body.preview[0];
    }, hexed);
    // Berlin. A boundary built from transposed coordinates lands near 52°E 13°N
    // — a different continent, and a difference no row count would show.
    expect(Number(bounds.min_lon)).toBeGreaterThan(12);
    expect(Number(bounds.min_lon)).toBeLessThan(15);
    expect(Number(bounds.min_lat)).toBeGreaterThan(51);
    expect(Number(bounds.min_lat)).toBeLessThan(54);
  });

  await test.step("both outputs are ordinary datasets in the workspace", async () => {
    const tables = await page.evaluate(async () => {
      const response = await fetch("/api/tables", { cache: "no-store" });
      return ((await response.json()) as {
        name: string;
        geometryType: string | null;
      }[]).map((t) => [t.name, t.geometryType]);
    });
    expect(tables).toContainEqual([hexed, expect.stringMatching(/polygon/i)]);
    expect(tables).toContainEqual([hot, expect.stringMatching(/polygon/i)]);
  });

  // The refusal never leaves the form, so no 400 is provoked and no
  // allowance is carried — a late request's failure would surface here.
  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});
