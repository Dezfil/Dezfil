import type { EditBasis } from "../src/lib/edit-basis";
// Column matching inside Add data: the step for a CSV with no strong
// match, on the upload road and the URL road, for one file and for a
// batch that waits file by file, over controls and API.
// The step draws no map, so nothing here needs WebGL. Every expected
// value is written apart from the code under test: the fixtures under
// e2e/fixtures/column-matching-*.csv are read, the API's own read of a
// landed table is the truth the step is compared to, and each case names
// the console errors it induces itself, which is none. Run with
// DEZFIL_BASE_URL at an isolated instance, never port 3000; the URL case
// needs DEZFIL_EGRESS_ALLOWLIST=127.0.0.1 on that instance, like the
// import matrix.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import { FIXTURES_DIR, routeHouse, startFixtureServer, trackConsole, type ConsoleError } from "./support";

const runId = Date.now().toString(36);
const T = (tag: string) => `cm_${tag}_${runId}`;

const fixture = (file: string) => readFileSync(path.join(FIXTURES_DIR, file));
/** A headerless CSV with a reading out of degree range and one adjacent
 * degree pair (column02, column03): pair rule lists that adjacent pair
 * first, while the fallback's column order would pick column00 and
 * column01, so a prefilled step proves it read the API's candidates. Both
 * columns fit both degree ranges, so the candidate lists both
 * orientations: the pair the panel would hint on, and the step must not.
 * Eleven columns, so the padded names come from the reader, as fixture
 * has it (the reader pads only past ten); the seven behind the pair are
 * numbers outside both degree ranges, so they form no pair. */
const PAIR = { file: "column-matching-pair.csv", columns: ["column02", "column03"] };
/** A headerless CSV whose text column reads as WKT in two of three rows: a
 * weak WKT candidate, so the step's first format is not always a pair. */
const WEAK_WKT = "column-matching-weak-wkt.csv";
/** A named `wkt` column that reads in every row: strong, applied at
 * upload, never sees the step. */
const STRONG = "column-matching-strong.csv";
/** An attribute table: no candidate at all, the step opens on the fallback. */
const ATTRIBUTES = "column-matching-attributes.csv";

const csv = (name: string, file: string) => ({ name: `${name}.csv`, mimeType: "text/csv", buffer: fixture(file) });

const api = async <T,>(page: Page, method: string, pathName: string, body?: unknown, basis?: EditBasis): Promise<T> =>
  page.evaluate(
    async ({ method, pathName, body, basis }) => {
      const r = await fetch(pathName, { method, headers: { ...(body ? { "content-type": "application/json" } : undefined), ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${text}`);
      return text ? (JSON.parse(text) as unknown) : null;
    },
    { method, pathName, body, basis },
  ) as Promise<T>;
type Inspection = { geometryColumn: string | null; currentChoice: { format: string; columns: string[]; epsg?: number } | null; mode: string; candidates: { format: string; columns: string[]; orientations?: { lon: string; lat: string }[] }[] };
const inspect = (page: Page, name: string) => api<Inspection>(page, "GET", `/api/tables/${encodeURIComponent(name)}/geometry`);
const readTable = (page: Page, name: string) => api<{ geometryColumn: string | null; geometryType: string | null }>(page, "GET", `/api/tables/${encodeURIComponent(name)}`);

const dialog = (page: Page) => page.getByRole("dialog", { name: "Add data" });
const step = (page: Page) => dialog(page).locator("[data-column-matching]");
const confirm = (page: Page) => dialog(page).getByRole("button", { name: "Confirm" });
const cancel = (page: Page) => dialog(page).getByRole("button", { name: "Cancel" });
const notice = (page: Page) => page.getByRole("status");
async function openAddData(page: Page) {
  await page.getByRole("button", { name: "Add data" }).first().click();
  await expect(dialog(page)).toBeVisible();
}
/** The step is open for the named file: the wide form, the header naming
 * the step and the file, the frame in the pane's place. */
async function expectStepFor(page: Page, file: string) {
  await expect(step(page)).toBeVisible({ timeout: 30_000 });
  await expect(dialog(page)).toHaveAttribute("data-wide", "true");
  await expect(dialog(page)).toContainText("Column matching");
  await expect(dialog(page)).toContainText(file);
  await expect(dialog(page).getByRole("tablist")).toHaveCount(0);
}
/** The console is clean but for the allowlist and the errors a case induces on purpose, named by the case itself
 * each induced status must have been logged, so an entry that matches nothing is a red. */
function clean(errors: ConsoleError[], induced: { status: number; url: RegExp }[] = []) {
  const matches = (e: ConsoleError, { status, url }: { status: number; url: RegExp }) => e.text.includes(`status of ${status}`) && e.url !== undefined && url.test(e.url);
  for (const entry of induced) {
    expect(errors.some((e) => matches(e, entry)), `the induced ${entry.status} on ${entry.url} was logged`).toBe(true);
  }
  expect(errors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !induced.some((entry) => matches(e, entry)))).toEqual([]);
}

test.describe("column matching", () => {
  test("the field case: a weak pair CSV opens the step filled in from the API's first candidate, and Confirm lands it as points on the card", async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context);
    await page.goto("/data");
    const name = T("pair");
    await openAddData(page);
    await page.locator('input[type="file"]').setInputFiles(csv(name, PAIR.file));

    // the step, in the wide form, for this file; the table exists behind it (default 2).
    await expectStepFor(page, `${name}.csv`);
    const before = await inspect(page, name);
    expect(before.geometryColumn, "the table landed without geometry").toBeNull();

    // filled in with the API's first candidate in its first listed orientation, which is not the
    // fallback's column order; the projection implicit, WGS 84 shown.
    const first = before.candidates[0];
    expect(first.format).toBe("pair");
    expect([...first.columns].sort()).toEqual(PAIR.columns);
    expect(first.orientations?.length, "the fixture's pair is genuinely ambiguous").toBeGreaterThan(1);
    await expect(step(page).getByRole("button", { name: "Coordinate pair" })).toHaveAttribute("aria-pressed", "true");
    await expect(step(page).getByLabel("Longitude column")).toHaveValue(first.orientations![0].lon);
    await expect(step(page).getByLabel("Latitude column")).toHaveValue(first.orientations![0].lat);
    await expect(step(page).getByLabel("Projection")).toHaveValue("4326");
    // no pair hint in the step, for the pair the panel would hint on.
    await expect(step(page)).not.toContainText("Both columns fit both ranges");
    // the grid over the answer's rows with the picks tagged; the count; Confirm on.
    await expect(step(page)).toContainText("3 of 3 sampled rows read as points.");
    await expect(step(page)).toContainText("Preview of the first 3 rows");
    await expect(step(page).locator("th[data-pick]")).toHaveCount(2);
    // The footer is the step's frame, beside the controls and the grid, not inside them.
    await expect(dialog(page)).toContainText("Adds a geometry column. The original columns stay.");
    await expect(step(page)).not.toContainText("wait for this step");
    await expect(confirm(page)).toBeEnabled();

    // Confirm sets it; the clean batch of one closes the host with today's notice; the card reads
    // it.
    await confirm(page).click();
    await expect(dialog(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(notice(page)).toContainText(`${name} is ready.`);
    const after = await inspect(page, name);
    expect(after.geometryColumn).toBe("geometry");
    expect(after.mode).toBe("set");
    expect(after.currentChoice).toMatchObject({ format: "pair", columns: [first.orientations![0].lon, first.orientations![0].lat] });
    expect((await api<{ crsAssumed: boolean }>(page, "GET", `/api/tables/${name}`)).crsAssumed, "an untouched Confirm sends no code: the dataset stays assumed").toBe(true);
    await expect(page.locator(`[data-table-card="${name}"]`)).toContainText(/point/i, { timeout: 15_000 });
    clean(errors);
  });

  test("a batch of three waits file by file: the note, Cancel advancing, the strong file passing, the weak WKT's own step, and the close leaving plain tables with their doors", async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context);
    await page.goto("/data");
    const [a, b, c] = [T("b1"), T("b2"), T("b3")];
    let posts = 0;
    await page.route("**/api/tables", async (route) => {
      if (route.request().method() === "POST") posts += 1;
      return route.fallback();
    });
    await openAddData(page);
    await page.locator('input[type="file"]').setInputFiles([csv(a, PAIR.file), csv(b, STRONG), csv(c, WEAK_WKT)]);

    // the step holds the batch; the note names the files waiting behind.
    await expectStepFor(page, `${a}.csv`);
    await expect(step(page)).toContainText(`2 more files wait for this step: ${b}.csv, ${c}.csv`);
    await page.waitForTimeout(1500);
    expect(posts, "the next upload has not started while the step is open").toBe(1);

    // Cancel writes nothing and advances; the strong file lands with no step; the weak WKT stops.
    await cancel(page).click();
    await expectStepFor(page, `${c}.csv`);
    await expect.poll(() => posts).toBe(3);
    expect((await inspect(page, a)).geometryColumn, "Cancel wrote nothing").toBeNull();
    expect((await readTable(page, b)).geometryColumn, "the strong file landed with its geometry").toBe("geometry");
    await expect(step(page).getByRole("button", { name: "WKT text" })).toHaveAttribute("aria-pressed", "true");
    await expect(step(page)).toContainText("2 of 3 sampled rows read as lines.");
    await expect(step(page)).toContainText("1 could not be read. They keep no geometry.");
    await expect(step(page)).not.toContainText("wait for this step");
    await expect(confirm(page)).toBeEnabled();

    // Escape with the last step pending closes it plain; the batch's account is today's.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(notice(page)).toContainText("3 tables ready.");
    expect((await inspect(page, c)).geometryColumn).toBeNull();
    // the plain table is fixable on its page doors.
    await page.goto(`/tables/${a}`);
    await expect(page.getByRole("heading", { level: 1, name: a })).toBeVisible();
    await expect(page.locator('[data-set-geometry-door="primary"]')).toBeVisible();
    clean(errors);
  });

  test("drop-anywhere: the real drop-to-dialog lifecycle with the earliest controlled response opens the step for the dropped file and holds the file behind it", async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context);
    await page.goto("/data");
    // The Data screen renders inside a suspense boundary and can arrive
    // after the load event; the drop goes to it once its heading is there.
    await expect(page.getByRole("heading", { level: 1, name: "Data" })).toBeVisible();
    const [a, b] = [T("d1"), T("d2")];
    // The first upload's answer is delivered the instant the server has
    // it, with no delay the test adds: the
    // Data page starts the queue before it asks the dialog to open, and
    // whether the dialog's gate is in place by the time an answer can
    // arrive is what this case establishes rather than assumes.
    let posts = 0;
    await page.route("**/api/tables", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts += 1;
      const response = await route.fetch();
      return route.fulfill({ response });
    });
    await page.evaluate(
      ({ a, b, bytesA, bytesB }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([bytesA], `${a}.csv`, { type: "text/csv" }));
        dt.items.add(new File([bytesB], `${b}.csv`, { type: "text/csv" }));
        const target = document.querySelector("[class*='screen']");
        if (!target) throw new Error("no screen drop target");
        target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      { a, b, bytesA: fixture(PAIR.file).toString("utf8"), bytesB: fixture(STRONG).toString("utf8") },
    );
    await expect(dialog(page)).toBeVisible();
    await expectStepFor(page, `${a}.csv`);
    await expect(step(page)).toContainText(`1 more file waits for this step: ${b}.csv`);
    await page.waitForTimeout(1500);
    expect(posts, "the batch waits behind the dropped file's step").toBe(1);
    await cancel(page).click();
    await expect.poll(() => posts).toBe(2);
    await expect(dialog(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(notice(page)).toContainText("2 tables ready.");
    clean(errors);
  });

  test("a held set: Escape and the close control are inert until the set answers, and the outcome reported is the set's", async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context);
    await page.goto("/data");
    const name = T("held");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = 0;
    await page.route(`**/api/tables/${name}/geometry`, async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      held += 1;
      await gate;
      return route.fallback();
    });
    await openAddData(page);
    await page.locator('input[type="file"]').setInputFiles(csv(name, PAIR.file));
    await expectStepFor(page, `${name}.csv`);
    await expect(confirm(page)).toBeEnabled();
    await confirm(page).click();
    await expect.poll(() => held).toBe(1);
    // every way out is inert while the set is in flight.
    await page.keyboard.press("Escape");
    await dialog(page).getByRole("button", { name: "Close" }).click();
    await expect(cancel(page)).toBeDisabled();
    await page.waitForTimeout(500);
    await expect(dialog(page)).toBeVisible();
    await expect(step(page)).toBeVisible();
    expect((await inspect(page, name)).geometryColumn, "nothing committed while held").toBeNull();
    release();
    await expect(dialog(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(notice(page)).toContainText(`${name} is ready.`);
    expect((await inspect(page, name)).geometryColumn).toBe("geometry");
    clean(errors);
  });

  test("the URL road opens the same step; after Confirm the choice replays on refresh", async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context);
    const name = T("url");
    const fixtures = await startFixtureServer(31879, { files: { [`${name}.csv`]: fixture(PAIR.file) } });
    try {
      await page.goto("/data");
      await openAddData(page);
      await page.getByRole("tab", { name: "From URL" }).click();
      await page.getByLabel("File URL").fill(`${fixtures.origin}/files/${name}.csv`);
      await expect(page.getByLabel("Table name")).toHaveValue(name);
      await page.getByRole("button", { name: /Import as table/ }).click();

      // the same step, the host not yet handed the table (the dialog is still here).
      await expectStepFor(page, `${name}.csv`);
      await expect(step(page)).toContainText("3 of 3 sampled rows read as points.");
      await expect(confirm(page)).toBeEnabled();
      await confirm(page).click();
      // The hand-off, once, at the step's end: the host closes on it with today's notice.
      await expect(dialog(page)).toHaveCount(0, { timeout: 30_000 });
      await expect(notice(page)).toContainText(`${name} is ready.`);
      const set = await inspect(page, name);
      expect(set.mode).toBe("set");
      expect(set.geometryColumn).toBe("geometry");
      // the choice replays on a refresh of the URL import.
      await api(page, "POST", `/api/tables/${name}/refresh`);
      const refreshed = await inspect(page, name);
      expect(refreshed.mode).toBe("set");
      expect(refreshed.geometryColumn).toBe("geometry");
      expect(refreshed.currentChoice).toEqual(set.currentChoice);
    } finally {
      await fixtures.close();
    }
    clean(errors);
  });

  test("an attribute CSV with no candidate stops too: the step opens on the fallback with Confirm off, and Cancel leaves the plain table", async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context);
    await page.goto("/data");
    const name = T("attr");
    await openAddData(page);
    await page.locator('input[type="file"]').setInputFiles(csv(name, ATTRIBUTES));
    await expectStepFor(page, `${name}.csv`);
    expect((await inspect(page, name)).candidates, "the fixture carries no candidate").toEqual([]);
    // the first format with the first columns it accepts, in column order.
    await expect(step(page).getByRole("button", { name: "Coordinate pair" })).toHaveAttribute("aria-pressed", "true");
    await expect(step(page).getByLabel("Longitude column")).toHaveValue("label");
    await expect(step(page).getByLabel("Latitude column")).toHaveValue("amount");
    // nothing reads, Confirm off.
    await expect(step(page)).toContainText("0 of 3 sampled rows can be read.");
    await expect(confirm(page)).toBeDisabled();
    await cancel(page).click();
    await expect(dialog(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(notice(page)).toContainText(`${name} is ready.`);
    expect((await inspect(page, name)).geometryColumn).toBeNull();
    clean(errors);
  });
});
