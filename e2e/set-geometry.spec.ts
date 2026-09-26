// The set-geometry panel on the dataset page: the four drawn cases, the
// projection rule, Apply's gate, the first correction through the
// assumed chip and the second-change refusal, the panel's doors, the
// page after apply and the Data page card.
// Map criteria are proven by feature pixels at expected screen locations
// computed here from hard-coded coordinates projected through the
// painted camera the primitive stamps on its host, never through the
// app's own fit of the same choice; the inset by its marker. Styling is
// read against the tokens in both themes. Run with DEZFIL_BASE_URL at an
// isolated instance, never port 3000, and with the runbook's WebGL
// flags: without a context the primitive shows its own note and every
// map assertion here would be vacuous, so each first confirms a canvas.
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { mintShapefileZip } from "./mint-shapefile";
import { routeHouse, seedCsv, seedFile, trackConsole, type ConsoleError } from "./support";

const runId = Date.now().toString(36);
const T = (tag: string) => `sg_${runId}_${tag}`;

// ---- the fixtures: every expectation below is hard-coded, none derived
// through the app ----

/** Trajectories: WKT lines in an unnamed column, one broken row, so
 * lands it as No geometry with a weak candidate (the field case). The
 * first line's midpoint is the pixel probe. */
const TRIP_A = [8.5717, 50.0492] as const;
const TRIP_B = [8.6, 50.06] as const;
const TRIP_MID = [(TRIP_A[0] + TRIP_B[0]) / 2, (TRIP_A[1] + TRIP_B[1]) / 2] as const;
const trajectoriesCsv = () =>
  ["id,column01,column06,column07"]
    .concat([
      `1,"LINESTRING(${TRIP_A[0]} ${TRIP_A[1]}, ${TRIP_B[0]} ${TRIP_B[1]})",${TRIP_A[1]},${TRIP_A[0]}`,
      `2,"LINESTRING(8.55 50.03, 8.58 50.05)",50.03,8.55`,
      `3,"LINESTRING(8.56 50.04, 8.59 50.07)",50.04,8.56`,
      `4,not a line,50.05,8.57`,
    ])
    .join("\n");

/** An unnamed numeric pair whose values fit both degree ranges: a weak
 * ambiguous candidate (the strip and the hint). Swapped, the first point
 * lands on the Somali coast. The readings sit outside both degree ranges,
 * so no pair with them reads and `a`/`b`, adjacent, is the best candidate
 * own order: `id` alone fits any range, which
 * is what a wide numeric table looks like. */
const PAIR_LON = 8.5717;
const PAIR_LAT = 50.0492;
const pairCsv = () =>
  ["id,reading,a,b", `1,250.5,${PAIR_LON},${PAIR_LAT}`, "2,310.1,8.58,50.05", "3,412.3,8.56,50.04"].join("\n");

/** Berlin in ETRS89 / UTM 33N: bare x/y names, projected values. Under
 * 25833 the first point is 13.405 / 52.52 (known answer); the same
 * numbers read as zone 32 are 7.405 / 52.52, computed independently by an
 * inverse transverse Mercator that reproduces the zone-33 answer. */
const BERLIN_E = 391779.25925275;
const BERLIN_N = 5820072.159211026;
const BERLIN_33 = [13.405, 52.52] as const;
const BERLIN_32 = [7.405, 52.52] as const;
const berlinCsv = () =>
  ["id,street,x,y", `1001,Friedrichstraße 43,${BERLIN_E},${BERLIN_N}`, "1002,Torstraße 101,392500.5,5821000.25", "1003,Kantstraße 12,385000.75,5818000.5"].join("\n");

/** H3: one known cell (its boundary is known answer; the first
 * vertex of that boundary is the probe, on the drawn outline) beside a bad
 * one, so it lands weak. */
const H3_CELL = "8928308280fffff";
const H3_VERTEX = [-122.4172, 37.775198] as const;
const h3Csv = () => ["cell,residents", `${H3_CELL},1200`, `${H3_CELL},900`, "not-a-cell,5"].join("\n");

/** Broken rows: a WKT column missing today's name rule, three of twenty
 * unreadable (a missing bracket, an n/a, a bare pair), one row missing. */
const STATION = [8.6638, 50.1071] as const;
const stationsCsv = () => {
  const rows = ["name,geom_wkt,platforms"];
  for (let i = 0; i < 16; i += 1) rows.push(`S${i},"POINT(${(8.5 + i * 0.01).toFixed(3)} ${(50.05 + i * 0.005).toFixed(3)})",${i}`);
  rows.push(`Hbf,"POINT(${STATION[0]} ${STATION[1]})",25`);
  rows.push(`Bracket,"POINT(8.7 50.1",2`, `NA,n/a,3`, `Bare,"8.6, 50.1",4`);
  rows.push(`Missing,,1`);
  return rows.join("\n");
};

/** Consumed named WKT: today's name rule applies a column named `wkt`
 * whose values read in degree range, the source column is consumed and
 * the CRS is assumed (numbers that cannot be
 * degrees are never read as WGS 84, so a UTM-valued `wkt` lands weak).
 * The first correction declares them NAD83, the real-world case for a
 * degree-valued file with no CRS; 4269 to 4326 leaves Berlin where it is. */
const consumedWktCsv = () =>
  ["id,wkt", `1,"POINT(${BERLIN_33[0]} ${BERLIN_33[1]})"`, `2,"POINT(13.41 52.53)"`].join("\n");

/** Recordless native geometry: the import matrix's shapefile
 * without a .prj, five points at (7.0 + i * 0.01, 51.0 + i * 0.01) written
 * as degrees and landing with WGS 84 assumed and no record. Read as UTM 33N
 * metres they sit a few metres from the zone's false origin: the inverse
 * transverse Mercator (Snyder, GRS80, zone 33, k0 0.9996, false easting
 * 500 000) puts (7.0, 51.0) at 10.51132 E, 0.00046 N, the Gulf of Guinea,
 * computed apart from the app and agreeing with PROJ to 1e-8 degrees; the
 * five points are 4 cm apart there, one pixel at the fit's zoom. */
const SHP_MOVED = [10.5113, 0.00046] as const;

// The field-round door now opens Data preview. These map/placement proofs
// explicitly select Map preview after asserting that door behavior.
// ---- the readers ----

const api = async <T,>(page: Page, method: string, pathName: string, body?: unknown): Promise<T> =>
  page.evaluate(
    async ({ method, pathName, body }) => {
      const r = await fetch(pathName, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${text}`);
      return text ? (JSON.parse(text) as unknown) : null;
    },
    { method, pathName, body },
  ) as Promise<T>;

const inspect = (page: Page, name: string) =>
  api<{ geometryColumn: string | null; geometryRecord: { crs: { label: string } } | null; currentChoice: { epsg?: number } | null; mode: string }>(page, "GET", `/api/tables/${encodeURIComponent(name)}/geometry`);
const readTable = (page: Page, name: string) =>
  api<{ geometryColumn: string | null; geometryType: string | null; crsAssumed: boolean }>(page, "GET", `/api/tables/${encodeURIComponent(name)}`);

const toggleTheme = (page: Page) => page.getByRole("button", { name: "Switch between dark and light theme" });
const appliedTheme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? "light");
/** The page's controls fade into a new theme (the primary action's 0.13 s
 * background transition), so a colour read mid-fade belongs to neither
 * theme: wait for every CSS transition to end. Transitions only, never the
 * page's infinite spinners. */
const transitionsSettled = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined)));
  });
async function setTheme(page: Page, theme: "light" | "dark") {
  if ((await appliedTheme(page)) !== theme) {
    await toggleTheme(page).click();
    await expect.poll(() => appliedTheme(page)).toBe(theme);
    await transitionsSettled(page);
  }
}
/** A token's computed colour, painted on a probe in the page: as ink, or as a background. */
const paint = (page: Page, name: string, as: "color" | "backgroundColor") =>
  page.evaluate(
    ({ t, as }) => {
      const probe = document.createElement("div");
      probe.style[as] = `var(${t})`;
      document.body.append(probe);
      const got = getComputedStyle(probe)[as];
      probe.remove();
      return got;
    },
    { t: name, as },
  );
const token = (page: Page, name: string) => paint(page, name, "color");

const dock = (page: Page) => page.locator("[data-set-geometry-panel]");
const projectionField = (page: Page) => page.locator('[data-field="projection"]');
const applyButton = (page: Page) => dock(page).getByRole("button", { name: /^Apply(?:: checking…)?$/ });
const mapHost = (page: Page) => page.locator("[data-preview-map]");
const canvas = (page: Page) => page.locator(".maplibregl-canvas");

interface Camera { lng: number; lat: number; zoom: number; width: number; height: number }
async function paintedCamera(page: Page): Promise<Camera> {
  await expect(canvas(page).first()).toBeVisible();
  await expect.poll(async () => Number(await mapHost(page).getAttribute("data-features-landed")), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => mapHost(page).getAttribute("data-preview-camera"), { timeout: 20_000 }).not.toBeNull();
  // Past the fit's own moveend and the frame after it.
  await page.waitForTimeout(400);
  return JSON.parse((await mapHost(page).getAttribute("data-preview-camera")) ?? "{}") as Camera;
}
/** Web Mercator at the painted camera: where a hard-coded coordinate
 * should be on the map's host, in CSS pixels from its top left. */
function project(camera: Camera, lon: number, lat: number): { x: number; y: number } {
  const world = 512 * 2 ** camera.zoom;
  const px = (l: number) => ((l + 180) / 360) * world;
  const py = (la: number) => ((180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360))) / 360) * world;
  return { x: px(lon) - px(camera.lng) + camera.width / 2, y: py(lat) - py(camera.lat) + camera.height / 2 };
}
const INK = { light: [13, 125, 92], dark: [69, 197, 143] } as const;
/** Whether the preview ink is painted within a small window around each
 * point of the host, read from a screenshot decoded in the page. */
async function inkAt(page: Page, points: { x: number; y: number }[], theme: "light" | "dark", radius = 6): Promise<boolean[]> {
  const box = await mapHost(page).boundingBox();
  if (!box) throw new Error("the map host is not on screen");
  const shot = await page.screenshot({ clip: box });
  return page.evaluate(
    async ({ b64, points, ink, radius }) => {
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
      const scale = width / (bmp.width / (window.devicePixelRatio || 1));
      return points.map((p) => {
        for (let dy = -radius; dy <= radius; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            const x = Math.round((p.x + dx) * scale);
            const y = Math.round((p.y + dy) * scale);
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            const i = (y * width + x) * 4;
            if (Math.abs(data[i] - ink[0]) <= 40 && Math.abs(data[i + 1] - ink[1]) <= 40 && Math.abs(data[i + 2] - ink[2]) <= 40) return true;
          }
        }
        return false;
      });
    },
    { b64: shot.toString("base64"), points, ink: INK[theme], radius },
  );
}
async function expectInk(page: Page, theme: "light" | "dark", places: (readonly [number, number])[], present = true) {
  const camera = await paintedCamera(page);
  const points = places.map(([lon, lat]) => project(camera, lon, lat));
  for (const p of points) {
    expect(p.x, "the expected place is inside the host").toBeGreaterThan(0);
    expect(p.x).toBeLessThan(camera.width);
    expect(p.y).toBeGreaterThan(0);
    expect(p.y).toBeLessThan(camera.height);
  }
  await expect.poll(() => inkAt(page, points, theme), { timeout: 10_000 }).toEqual(points.map(() => present));
}
async function expectInset(page: Page, [lon, lat]: readonly [number, number]) {
  const inset = page.locator("[data-world-inset]");
  await expect(inset).toBeVisible();
  const [cLon, cLat] = ((await inset.getAttribute("data-inset-center")) ?? "0,0").split(",").map(Number);
  expect(cLon).toBeCloseTo(lon, 1);
  expect(cLat).toBeCloseTo(lat, 1);
  const marker = page.locator("[data-inset-marker]");
  expect(Number(await marker.getAttribute("cx"))).toBeCloseTo(((lon + 180) / 360) * 132, 0);
  expect(Number(await marker.getAttribute("cy"))).toBeCloseTo(((90 - lat) / 180) * 66, 0);
}
async function attach(page: Page, info: TestInfo, name: string) {
  await info.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}
/** The console is clean but for the allowlist and the errors a case induces on purpose: a status on one
 * route, named by the case itself so the tolerance never widens past it. Each induced status must have been
 * logged, so an entry that matches nothing is a red rather than a silent allowance. */
function clean(errors: ConsoleError[], induced: { status: number; url: RegExp }[] = []) {
  const matches = (e: ConsoleError, { status, url }: { status: number; url: RegExp }) => e.text.includes(`status of ${status}`) && e.url !== undefined && url.test(e.url);
  for (const entry of induced) {
    expect(errors.some((e) => matches(e, entry)), `the induced ${entry.status} on ${entry.url} was logged`).toBe(true);
  }
  expect(errors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !induced.some((entry) => matches(e, entry)))).toEqual([]);
}
async function openDataset(page: Page, name: string) {
  await page.goto(`/tables/${name}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}
const chooseFormat = (page: Page, label: string) => dock(page).getByRole("button", { name: label, exact: true }).click();

test.describe("set geometry", () => {
  test.beforeEach(async ({ context }) => {
    await routeHouse(context, { basemapStyleStub: true });
  });

  test("the field case: trajectories become Lines from their page, and the page, the card and the catalog read it after apply", async ({ page, context }, info) => {
    const errors = trackConsole(page);
    const name = T("trajectories");
    await page.goto("/data");
    await seedCsv(page, name, trajectoriesCsv());
    expect((await readTable(page, name)).geometryColumn, "the fixture lands as No geometry").toBeNull();
    await openDataset(page, name);

    // The panel's two doors, and no strip for a non-pair candidate.
    const primary = page.locator('[data-set-geometry-door="primary"]');
    await expect(primary).toBeVisible();
    await expect(page.locator('[data-set-geometry-door="plate"]')).toBeVisible();
    await expect(page.locator("[data-proposal-strip]")).toHaveCount(0);
    await attach(page, info, "doors-light");
    await setTheme(page, "dark");
    expect(await primary.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await token(page, "--accent"));
    await attach(page, info, "doors-dark");
    await setTheme(page, "light");

    // The trajectories case: the panel opens on the strong-looking column, the count says
    // lines, Apply on.
    await primary.click();
    await expect(dock(page)).toBeVisible();
    await expect(page.locator("[data-live-tag]")).toHaveText(/Preview of the choice/);
    await expect(dock(page).getByRole("button", { name: "WKT text" })).toHaveAttribute("aria-pressed", "true");
    await expect(dock(page)).toContainText("3 of 4 sampled rows read as lines.");
    await expect(dock(page)).toContainText("1 could not be read. They keep no geometry.");
    await expect(dock(page)).toContainText("Adds a geometry column. The original columns stay.");
    await expect(applyButton(page)).toBeEnabled();
    // The map draws the lines at the trip's own place, both themes (the pixels before apply are
    // the preview's).
    await expectInk(page, "light", [TRIP_MID]);
    await expect(page.locator("[data-choice-readout]")).toContainText("3 of 4 sampled rows");
    await expect(page.locator("[data-choice-readout]")).toContainText("LINESTRING");
    await attach(page, info, "panel-lines-light");
    await setTheme(page, "dark");
    await expectInk(page, "dark", [TRIP_MID]);
    await attach(page, info, "panel-lines-dark");
    await setTheme(page, "light");

    // the Data preview marks the unreadable row and tags the column, styled by the tokens in both
    // themes.
    await page.getByRole("tab", { name: "Data preview" }).click();
    const badRow = page.locator("tbody tr[data-bad]");
    await expect(badRow).toHaveCount(1);
    await expect(badRow).toContainText("not a line");
    await expect(page.locator("th[data-pick]")).toHaveText(/column01.*geometry/i);
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      expect(await page.locator("td[data-bad]").first().evaluate((el) => getComputedStyle(el).color), `${theme}: the marked cell`).toBe(await token(page, "--warn"));
      expect(await page.locator("th[data-pick]").evaluate((el) => getComputedStyle(el).backgroundColor), `${theme}: the tagged column`).toBe(await paint(page, "--accent-wash", "backgroundColor"));
      await attach(page, info, `grid-marks-${theme}`);
    }
    await setTheme(page, "light");
    await page.getByRole("tab", { name: "Map preview" }).click();

    // Cancel writes nothing and the page's own previews return.
    await dock(page).getByRole("button", { name: "Cancel" }).click();
    await expect(dock(page)).toHaveCount(0);
    await expect(page.locator("[data-live-tag]")).toHaveCount(0);
    await expect(page.locator("[data-choice-preview]")).toHaveCount(0);
    expect((await readTable(page, name)).geometryColumn).toBeNull();

    // Apply from the plate's door; the page re-reads.
    await page.locator('[data-set-geometry-door="plate"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await expect(applyButton(page)).toBeEnabled();
    await applyButton(page).click();
    await expect(dock(page)).toHaveCount(0);
    await expect(page.getByText("Lines", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add to a map" })).toBeVisible();
    await expect(page.locator('[data-set-geometry-door="primary"]')).toHaveCount(0);
    await expect(page.getByText("Geometry: column01 read as WKT text, WGS 84 assumed")).toBeVisible();
    await expect(page.locator('[data-set-geometry-door="change"]')).toHaveText("Change");
    await expect(page.locator('[data-set-geometry-door="crs"]')).toBeVisible();
    const after = await readTable(page, name);
    expect(after.geometryColumn).toBe("geometry");
    expect(after.geometryType).toBe("LINESTRING");
    // The page's own Map preview draws the dataset's lines at the trip's place.
    await expectInk(page, "light", [TRIP_MID]);
    await attach(page, info, "after-apply-light");
    await setTheme(page, "dark");
    await expectInk(page, "dark", [TRIP_MID]);
    await attach(page, info, "after-apply-dark");
    await setTheme(page, "light");
    // the Data preview shows the geometry column last, as text.
    await page.getByRole("tab", { name: "Data preview" }).click();
    const heads = await page.locator("thead th").allInnerTexts();
    expect(heads.at(-1)).toMatch(/^geometry/);
    expect(heads.some((h) => h.startsWith("column01"))).toBe(true);
    await expect(page.locator("tbody tr").first()).toContainText("LINESTRING");

    // the Data page card reads Lines, the assumption chip, and Add to a map on hover; no new
    // control.
    await page.goto("/data");
    const card = page.locator("article", { hasText: name }).first();
    await expect(card).toContainText("Lines");
    await expect(card).toContainText("WGS84 assumed");
    await expect(card.locator('[data-set-geometry-door]')).toHaveCount(0);
    await card.hover();
    await expect(card.locator('[data-hint="Add to a map"]')).toBeVisible();
    await attach(page, info, "card-after");
    clean(errors);
    await context.close();
  });

  test("a pair with its swap: the strip, the hint, the Somali coast and the inset", async ({ page, context }, info) => {
    const errors = trackConsole(page);
    const name = T("pair");
    await page.goto("/data");
    await seedCsv(page, name, pairCsv());
    await openDataset(page, name);
    // the strip for a weak pair candidate, with the drawn sentence; Not now removes it for the
    // visit and leaves both doors.
    const strip = page.locator("[data-proposal-strip]");
    await expect(strip).toContainText("a and b look like coordinates.");
    await expect(strip.locator('[data-set-geometry-door="strip"]')).toBeVisible();
    await attach(page, info, "strip-light");
    await setTheme(page, "dark");
    await attach(page, info, "strip-dark");
    await setTheme(page, "light");
    await strip.getByRole("button", { name: "Not now" }).click();
    await expect(strip).toHaveCount(0);
    await expect(page.locator('[data-set-geometry-door="primary"]')).toBeVisible();
    await expect(page.locator('[data-set-geometry-door="plate"]')).toBeVisible();
    await page.reload();
    await expect(page.locator("[data-proposal-strip]")).toBeVisible();
    // The strip's Set geometry opens the panel with that pair filled in.
    await page.locator('[data-set-geometry-door="strip"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await expect(dock(page)).toBeVisible();
    await expect(dock(page).getByRole("button", { name: "Coordinate pair" })).toHaveAttribute("aria-pressed", "true");
    await expect(dock(page).getByLabel("Longitude column")).toHaveValue("a");
    await expect(dock(page).getByLabel("Latitude column")).toHaveValue("b");
    // the hint from the candidate's two orientations; the points at the airport; then the swap
    // lands them on the Somali coast, the inset saying so.
    await expect(dock(page)).toContainText("Both columns fit both ranges. If the map is wrong, swap them.");
    await expectInk(page, "light", [[PAIR_LON, PAIR_LAT]]);
    await expectInset(page, [8.57, 50.0446]);
    await dock(page).getByRole("button", { name: "Swap the two columns" }).click();
    await expect(dock(page).getByLabel("Longitude column")).toHaveValue("b");
    await expect(dock(page).getByLabel("Latitude column")).toHaveValue("a");
    await expect(dock(page)).toContainText("3 of 3 sampled rows read as points.");
    await expectInk(page, "light", [[PAIR_LAT, PAIR_LON]]);
    await expectInset(page, [50.0446, 8.57]);
    await attach(page, info, "swap-somali-light");
    await setTheme(page, "dark");
    await expectInk(page, "dark", [[PAIR_LAT, PAIR_LON]]);
    await attach(page, info, "swap-somali-dark");
    await setTheme(page, "light");
    // The pair fields offer a text-typed column too: the id column is numeric, the reading numeric;
    // every column is offered.
    const offered = await dock(page).getByLabel("Longitude column").locator("option").allInnerTexts();
    expect(offered.map((o) => o.split(" · ")[0])).toEqual(["id", "reading", "a", "b"]);
    clean(errors);
    await context.close();
  });

  test("Berlin: numbers that are not degrees, then two projections, Other EPSG code and an unsupported code", async ({ page, context }, info) => {
    const errors = trackConsole(page);
    const name = T("berlin");
    await page.goto("/data");
    await seedCsv(page, name, berlinCsv());
    await openDataset(page, name);
    await page.locator('[data-set-geometry-door="primary"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await expect(dock(page)).toBeVisible();
    // the not-degrees notice, the field marked, the map's notice, zero, Apply off.
    await expect(dock(page).getByLabel("Longitude column")).toHaveValue("x");
    await expect(dock(page).getByLabel("Latitude column")).toHaveValue("y");
    await expect(dock(page).locator('[data-notice="not-degrees"]')).toContainText("These numbers are not degrees. Choose the projection they are in.");
    await expect(projectionField(page)).toHaveAttribute("data-attn", "true");
    await expect(dock(page)).toContainText("0 of 3 sampled rows can be read.");
    await expect(page.locator("[data-preview-refusal]")).toContainText("Nothing can be drawn until the projection is chosen.");
    await expect(applyButton(page)).toBeDisabled();
    await attach(page, info, "berlin-not-degrees");
    // 03 C: the list.
    const options = await projectionField(page).locator("option").allInnerTexts();
    expect(options.filter((o) => o !== "Choose a projection")).toEqual([
      "WGS 84 (EPSG:4326)", "Web Mercator (EPSG:3857)", "ETRS89 / UTM 32N (EPSG:25832)", "ETRS89 / UTM 33N (EPSG:25833)",
      "ETRS89 / LAEA Europe (EPSG:3035)", "British National Grid (EPSG:27700)", "NAD83 (EPSG:4269)", "Other EPSG code…",
    ]);
    // 25833 places the points at Berlin: the first point at its known answer.
    await projectionField(page).selectOption("25833");
    await expect(dock(page)).toContainText("3 of 3 sampled rows read as points.");
    await expect(applyButton(page)).toBeEnabled();
    await expect(page.locator("[data-choice-readout]")).toContainText("ETRS89 / UTM 33N");
    await expectInk(page, "light", [BERLIN_33]);
    await expectInset(page, [13.3606, 52.5142]);
    await attach(page, info, "berlin-25833-light");
    await setTheme(page, "dark");
    await expectInk(page, "dark", [BERLIN_33]);
    await attach(page, info, "berlin-25833-dark");
    await setTheme(page, "light");
    // The seeded case: a change to 25832 ignored and the 25833 geometry kept.
    // Detected by the
    // independently expected coordinates through the observed viewport, plus the inset: never by
    // the pixels of
    // two independently fitted maps differing.
    await projectionField(page).selectOption("25832");
    await expect(page.locator("[data-choice-readout]")).toContainText("ETRS89 / UTM 32N");
    await expectInk(page, "light", [BERLIN_32]);
    await expectInset(page, [7.3606, 52.5142]);
    const camera32 = await paintedCamera(page);
    expect(camera32.lng, "the fit sits at zone 32's longitude, not zone 33's").toBeCloseTo(BERLIN_32[0], 0);
    await attach(page, info, "berlin-25832");
    // Other EPSG code: the field, a resolved custom code, and an unsupported one refused as the API
    // words it.
    await projectionField(page).selectOption("other");
    const code = dock(page).getByLabel("EPSG code");
    await expect(code).toBeVisible();
    await code.fill("31467");
    await code.press("Enter");
    await expect(dock(page)).toContainText("3 of 3 sampled rows read as points.");
    await expect(page.locator("[data-choice-readout]")).toContainText("EPSG:31467");
    await code.fill("999999");
    await code.press("Enter");
    await expect(dock(page).locator('[data-notice="issue"]')).toContainText("EPSG:999999 cannot be transformed to WGS 84.");
    await expect(page.locator("[data-preview-refusal]")).toContainText("EPSG:999999 cannot be transformed to WGS 84.");
    await expect(applyButton(page)).toBeDisabled();
    // apply under 25833 and reopen: the code is kept and sent.
    await projectionField(page).selectOption("25833");
    await expect(applyButton(page)).toBeEnabled();
    await applyButton(page).click();
    await expect(dock(page)).toHaveCount(0);
    await expect(page.getByText(/Geometry: x, y read as Coordinate pair, ETRS89 \/ UTM 33N/)).toBeVisible();
    await expect(page.locator('[data-set-geometry-door="crs"]')).toHaveCount(0);
    expect((await inspect(page, name)).currentChoice?.epsg).toBe(25833);
    await page.locator('[data-set-geometry-door="change"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await expect(projectionField(page)).toHaveValue("25833");
    await expect(page.locator("[data-choice-readout]")).toContainText("ETRS89 / UTM 33N");
    await expectInk(page, "light", [BERLIN_33]);
    await expect(applyButton(page)).toBeEnabled();
    await applyButton(page).click();
    await expect(dock(page)).toHaveCount(0);
    expect((await inspect(page, name)).currentChoice?.epsg).toBe(25833);
    clean(errors);
    await context.close();
  });

  test("H3 cells: polygons at the cell, no projection field, and a format no row reads", async ({ page, context }, info) => {
    const errors = trackConsole(page);
    const name = T("h3");
    await page.goto("/data");
    await seedCsv(page, name, h3Csv());
    await openDataset(page, name);
    await page.locator('[data-set-geometry-door="primary"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await expect(dock(page)).toBeVisible();
    await expect(dock(page).getByRole("button", { name: "H3 cell" })).toHaveAttribute("aria-pressed", "true");
    await expect(projectionField(page)).toHaveCount(0);
    await expect(dock(page)).toContainText("2 of 3 sampled rows read as polygons.");
    await expectInk(page, "light", [H3_VERTEX]);
    await attach(page, info, "h3-light");
    await setTheme(page, "dark");
    await expectInk(page, "dark", [H3_VERTEX]);
    await attach(page, info, "h3-dark");
    await setTheme(page, "light");
    await chooseFormat(page, "GeoJSON");
    await expect(projectionField(page)).toHaveCount(0);
    await chooseFormat(page, "WKT text");
    await expect(projectionField(page)).toBeVisible();
    await expect(dock(page)).toContainText("0 of 3 sampled rows can be read.");
    await expect(page.locator("[data-preview-refusal]")).toContainText("No sampled row can be read this way.");
    await expect(applyButton(page)).toBeDisabled();
    await chooseFormat(page, "H3 cell");
    await expect(applyButton(page)).toBeEnabled();
    await applyButton(page).click();
    await expect(dock(page)).toHaveCount(0);
    expect((await readTable(page, name)).geometryType).toBe("POLYGON");
    clean(errors);
    await context.close();
  });

  test("broken rows: the unreadable clause, the marks, Apply on", async ({ page, context }, info) => {
    const errors = trackConsole(page);
    const name = T("stations");
    await page.goto("/data");
    await seedCsv(page, name, stationsCsv());
    await openDataset(page, name);
    await page.locator('[data-set-geometry-door="primary"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await expect(dock(page)).toBeVisible();
    await expect(dock(page).getByLabel("Column")).toHaveValue("geom_wkt");
    await expect(dock(page)).toContainText("17 of 21 sampled rows read as points.");
    await expect(dock(page)).toContainText("3 could not be read. They keep no geometry.");
    await expect(applyButton(page)).toBeEnabled();
    await expectInk(page, "light", [STATION]);
    await page.getByRole("tab", { name: "Data preview" }).click();
    const marked = page.locator("tbody tr[data-bad]");
    await expect(marked).toHaveCount(3);
    await expect(marked.nth(0)).toContainText("Bracket");
    await expect(marked.nth(1)).toContainText("NA");
    await expect(marked.nth(2)).toContainText("Bare");
    await expect(page.locator("tbody tr", { hasText: "Missing" })).not.toHaveAttribute("data-bad", /.*/);
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      expect(await page.locator("td[data-bad]").first().evaluate((el) => getComputedStyle(el).color), `${theme}: the mark`).toBe(await token(page, "--warn"));
      await attach(page, info, `broken-marks-${theme}`);
    }
    await setTheme(page, "light");
    await applyButton(page).click();
    await expect(dock(page)).toHaveCount(0);
    expect((await readTable(page, name)).geometryType).toBe("POINT");
    clean(errors);
    await context.close();
  });

  test("the projection rule and the assumed chip: implicit stays assumed, explicit WGS 84 declares, the chip is a door", async ({ page, context }, info) => {
    const errors = trackConsole(page);
    const name = T("rule");
    await page.goto("/data");
    await seedCsv(page, name, stationsCsv());
    await openDataset(page, name);
    await page.locator('[data-set-geometry-door="primary"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await applyButton(page).click();
    await expect(dock(page)).toHaveCount(0);
    // applied untouched, the dataset stays assumed and the chip is a door with the drawn tooltip.
    expect((await readTable(page, name)).crsAssumed).toBe(true);
    const chip = page.locator('[data-set-geometry-door="crs"]');
    await expect(chip).toHaveText(/WGS84 assumed/);
    await expect(chip.locator("svg")).toBeVisible();
    const tip = page.getByRole("tooltip");
    await expect(tip).toBeHidden();
    await chip.hover();
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("The file declared no CRS. WGS 84 was assumed.");
    await expect(tip).toContainText("Click to choose the projection.");
    await attach(page, info, "chip-hover-light");
    await setTheme(page, "dark");
    await chip.hover();
    expect(await chip.evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--warn"));
    await attach(page, info, "chip-hover-dark");
    await setTheme(page, "light");
    await page.mouse.move(0, 0);
    await expect(tip).toBeHidden();
    // The chip opens the panel with the projection field marked, on the current choice; the marked
    // field
    // holds no chosen code, so WGS 84 is a choice a person can make from it.
    await chip.click();
    await expect(dock(page)).toBeVisible();
    await expect(dock(page).getByLabel("Column")).toHaveValue("geom_wkt");
    await expect(projectionField(page)).toHaveAttribute("data-attn", "true");
    await expect(projectionField(page)).toHaveValue("");
    await expect(dock(page)).not.toContainText("Adds a geometry column.");
    await attach(page, info, "chip-opened");
    // Reapplied untouched, still assumed; explicitly selecting WGS 84 declares it and the chip
    // goes.
    await applyButton(page).click();
    await expect(dock(page)).toHaveCount(0);
    expect((await readTable(page, name)).crsAssumed).toBe(true);
    await chip.click();
    await projectionField(page).selectOption("4326");
    await expect(applyButton(page)).toBeEnabled();
    await applyButton(page).click();
    await expect(dock(page)).toHaveCount(0);
    expect((await readTable(page, name)).crsAssumed).toBe(false);
    await expect(page.locator('[data-set-geometry-door="crs"]')).toHaveCount(0);
    await expect(page.getByText("Geometry: geom_wkt read as WKT text, WGS 84")).toBeVisible();
    expect((await inspect(page, name)).currentChoice?.epsg).toBe(4326);
    // Reopened, the explicit 4326 stays declared: the field shows it and reapplying keeps it.
    await page.locator('[data-set-geometry-door="change"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await expect(projectionField(page)).toHaveValue("4326");
    await applyButton(page).click();
    await expect(dock(page)).toHaveCount(0);
    expect((await readTable(page, name)).crsAssumed).toBe(false);
    clean(errors);
    await context.close();
  });

  test("the first correction on consumed WKT, then the refusal on a second change", async ({ page, context }, info) => {
    const errors = trackConsole(page);
    const name = T("consumed");
    await page.goto("/data");
    await seedCsv(page, name, consumedWktCsv());
    const landed = await readTable(page, name);
    expect(landed.geometryColumn, "the name rule applied the column").not.toBeNull();
    expect(landed.crsAssumed).toBe(true);
    await openDataset(page, name);
    // the chip is the way in; the panel opens on the stored geometry column with the record's
    // format, the field marked and no preview sent.
    await page.locator('[data-set-geometry-door="crs"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await expect(dock(page)).toBeVisible();
    await expect(dock(page).getByRole("button", { name: "WKT text" })).toHaveAttribute("aria-pressed", "true");
    await expect(dock(page).getByLabel("Column")).toHaveValue("geometry");
    await expect(projectionField(page)).toHaveAttribute("data-attn", "true");
    await expect(projectionField(page)).toHaveValue("");
    await expect(page.locator("[data-choice-preview]")).toHaveCount(0);
    await expect(applyButton(page)).toBeDisabled();
    await attach(page, info, "consumed-opened");
    await projectionField(page).selectOption("4269");
    await expect(dock(page)).toContainText("2 of 2 sampled rows read as points.");
    await expect(page.locator("[data-choice-readout]")).toContainText("NAD83");
    await expectInk(page, "light", [BERLIN_33]);
    await expect(applyButton(page)).toBeEnabled();
    await applyButton(page).click();
    await expect(dock(page)).toHaveCount(0);
    await expect(page.locator('[data-set-geometry-door="crs"]')).toHaveCount(0);
    await expect(page.getByText(/Geometry: wkt read as WKT text, NAD83 \(EPSG:4269\)/)).toBeVisible();
    expect((await readTable(page, name)).crsAssumed).toBe(false);
    // A second change is refused as the API words it, the panel open with the choice intact: the
    // panel opens on the
    // stored column (nothing else is left to offer) and every attempt, including another
    // projection, answers the sentence.
    await page.locator('[data-set-geometry-door="change"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await expect(dock(page)).toBeVisible();
    await expect(dock(page).getByLabel("Column")).toHaveValue("geometry");
    await expect(dock(page).getByRole("alert")).toContainText("The original geometry source is no longer stored. A further change is unavailable.");
    await projectionField(page).selectOption("25832");
    await expect(dock(page).getByRole("alert")).toContainText("The original geometry source is no longer stored. A further change is unavailable.");
    await expect(applyButton(page)).toBeDisabled();
    await expect(dock(page).getByLabel("Column")).toHaveValue("geometry");
    await attach(page, info, "consumed-refused");
    clean(errors);
    await context.close();
  });

  test("Apply's gate, a stale revision and a refused dataset by address", async ({ page, context }) => {
    const errors = trackConsole(page);
    const name = T("stale");
    await page.goto("/data");
    await seedCsv(page, name, stationsCsv());
    await openDataset(page, name);
    await page.locator('[data-set-geometry-door="primary"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await expect(applyButton(page)).toBeEnabled();
    // a change to a format no row reads turns Apply off before the answer lands and keeps it off
    // after.
    await chooseFormat(page, "WKB hex");
    await expect(applyButton(page)).toBeDisabled();
    await expect(dock(page)).toContainText("0 of 21 sampled rows can be read.");
    await expect(applyButton(page)).toBeDisabled();
    await chooseFormat(page, "WKT text");
    await expect(applyButton(page)).toBeEnabled();
    // the dataset changes under the open panel (a set through the API); Apply is refused with the
    // API's sentence, the panel re-reads and the next attempt goes through.
    const before = await inspect(page, name);
    await api(page, "PUT", `/api/tables/${encodeURIComponent(name)}/geometry`, { expectedRevision: (before as unknown as { revision: string }).revision, choice: { format: "wkt", columns: ["geom_wkt"], epsg: 4326 } });
    await applyButton(page).click();
    await expect(dock(page).getByRole("alert")).toContainText("The dataset changed. Inspect its geometry again before continuing.");
    await expect(dock(page)).toBeVisible();
    await expect(applyButton(page)).toBeEnabled({ timeout: 20_000 });
    await applyButton(page).click();
    await expect(dock(page)).toHaveCount(0);
    expect((await inspect(page, name)).mode).toBe("set");
    // a dataset the API refuses, reached by address, shows the page as shipped with the refusal.
    // The run route answers 202 with the run under `run` (its Location header names the run's resource); the runs read wraps its answer the same way.
    const { run } = await api<{ run: { id: string } }>(page, "POST", "/api/operations/run", { operation: "sql_step", parameters: { sql: `SELECT 1 AS n`, name: T("derived") } });
    await expect.poll(async () => (await api<{ run: { state: string } }>(page, "GET", `/api/operations/runs/${run.id}`)).run.state, { timeout: 30_000 }).toMatch(/succeeded|failed/);
    const derived = (await api<{ run: { state: string; output?: { name: string } } }>(page, "GET", `/api/operations/runs/${run.id}`)).run.output?.name;
    expect(derived, "the derived dataset").toBeTruthy();
    await page.goto(`/tables/${derived}?geometry=set`);
    await expect(page.getByRole("heading", { level: 1, name: derived! })).toBeVisible();
    // The page's own refusal note, not Next's empty route announcer, which also carries role="alert".
    await expect(page.locator('[role="alert"][data-tone="danger"]')).toContainText("Set geometry is available for file uploads and URL imports. SQL and workflow datasets take geometry from their SQL; PostGIS tables bring their own.");
    await expect(dock(page)).toHaveCount(0);
    await expect(page.locator("[data-set-geometry-door]")).toHaveCount(0);
    // The two 409s this case provokes on purpose, both on the geometry resource: Apply against the
    // stale revision
    // (input_changed) and the refused dataset's inspection by address (geometry_not_supported).
    clean(errors, [
      { status: 409, url: new RegExp(`/api/tables/${name}/geometry$`) },
      { status: 409, url: new RegExp(`/api/tables/${derived!}/geometry$`) },
    ]);
    await context.close();
  });

  test("the first correction on recordless native geometry: a shapefile without a .prj, then the refusal on a second change", async ({ page, context }, info) => {
    const errors = trackConsole(page);
    const name = T("shp");
    await page.goto("/data");
    await seedFile(page, `${name}.zip`, await mintShapefileZip({ includePrj: false }), "application/zip");
    const landed = await readTable(page, name);
    const stored = landed.geometryColumn;
    expect(stored, "the shapefile's geometry is the stored column").not.toBeNull();
    expect(landed.crsAssumed, "no .prj: WGS 84 assumed").toBe(true);
    expect((await inspect(page, name)).geometryRecord, "recordless: nothing was written about how it was read").toBeNull();
    await openDataset(page, name);
    // no record, so no record line and no Change door; the chip is the way in. The panel opens on
    // the stored
    // column as WKB hex, the field marked and empty, no preview sent, Apply off; no candidate,
    // record or source is invented.
    await expect(page.locator('[data-set-geometry-door="change"]')).toHaveCount(0);
    await page.locator('[data-set-geometry-door="crs"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await expect(dock(page)).toBeVisible();
    await expect(dock(page).getByRole("button", { name: "WKB hex", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dock(page).getByLabel("Column")).toHaveValue(stored!);
    await expect(projectionField(page)).toHaveAttribute("data-attn", "true");
    await expect(projectionField(page)).toHaveValue("");
    await expect(page.locator("[data-choice-preview]")).toHaveCount(0);
    await expect(applyButton(page)).toBeDisabled();
    await attach(page, info, "native-opened");
    // 25833 reads the degree-sized numbers as metres: the geometry moves to the independently
    // expected place, and the fit with it.
    await projectionField(page).selectOption("25833");
    await expect(dock(page)).toContainText("5 of 5 sampled rows read as points.");
    await expect(page.locator("[data-choice-readout]")).toContainText("ETRS89 / UTM 33N");
    await expectInk(page, "light", [SHP_MOVED]);
    await expectInset(page, SHP_MOVED);
    const camera = await paintedCamera(page);
    expect(camera.lng, "the fit sits in the Gulf of Guinea, not the Ruhr").toBeCloseTo(SHP_MOVED[0], 1);
    expect(camera.lat).toBeCloseTo(SHP_MOVED[1], 1);
    await attach(page, info, "native-25833-light");
    await setTheme(page, "dark");
    await expectInk(page, "dark", [SHP_MOVED]);
    await attach(page, info, "native-25833-dark");
    await setTheme(page, "light");
    await expect(applyButton(page)).toBeEnabled();
    await applyButton(page).click();
    await expect(dock(page)).toHaveCount(0);
    // The chip is gone, the record names the source CRS, and the page's own Map preview draws the
    // moved geometry.
    await expect(page.locator('[data-set-geometry-door="crs"]')).toHaveCount(0);
    await expect(page.getByText(new RegExp(`Geometry: ${stored} read as WKB hex, ETRS89 / UTM 33N \\(EPSG:25833\\)`))).toBeVisible();
    expect((await readTable(page, name)).crsAssumed).toBe(false);
    await expectInk(page, "light", [SHP_MOVED]);
    await attach(page, info, "native-after-apply");
    // The original is gone; the second change is refused as the API words it, and Apply stays off.
    await page.locator('[data-set-geometry-door="change"]').click();
    await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Map preview" }).click();
    await expect(dock(page)).toBeVisible();
    await expect(dock(page).getByRole("alert")).toContainText("The original geometry source is no longer stored. A further change is unavailable.");
    await expect(applyButton(page)).toBeDisabled();
    await attach(page, info, "native-refused");
    clean(errors);
    await context.close();
  });
});
