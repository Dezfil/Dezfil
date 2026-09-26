// Multi-file upload: the batch journeys. Every entry point takes the
// full file set; the batch runs sequentially with per-file outcomes; a
// failure fails only its file; hosts settle on the batch; a lost answer
// is unconfirmed, never a silent loss; dismissal stops what has not
// started and reports it.
//
// The lost-answer fixture is scoped (plan risk 2): the upload request
// is forwarded so the server commits, then its ANSWER is dropped —
// while the listing requests stay untouched, so the authoritative
// refresh the criterion demands is measurable in the same journey.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import { buildGpkg } from "../test-support/gpkg";
import { consumeExpected, routeHouse, trackConsole } from "./support";

const runId = Date.now().toString(36);

const point = (name: string, lon: number, lat: number) => ({
  type: "Feature",
  properties: { name },
  geometry: { type: "Point", coordinates: [lon, lat] },
});

function geojsonBytes(names: string[]): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "FeatureCollection",
      features: names.map((n, i) => point(n, i, i)),
    }),
  );
}

const gj = (name: string, features = 2) => ({
  name: `${name}.geojson`,
  mimeType: "application/geo+json",
  buffer: geojsonBytes(
    Array.from({ length: features }, (_, i) => `${name}-${i}`),
  ),
});

async function tableNames(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    ((await (await fetch("/api/tables")).json()) as { name: string }[]).map(
      (t) => t.name,
    ),
  );
}

async function openAddData(page: Page) {
  await page.getByRole("button", { name: "Add data" }).first().click();
  await expect(page.getByRole("dialog", { name: "Add data" })).toBeVisible();
}

test("a mixed batch: order, two distinct failures visible together, host stays open", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);
  await page.goto("/data");
  await openAddData(page);

  const okA = `mub1a_${runId}`;
  const okB = `mub1b_${runId}`;
  await page.locator('input[type="file"]').setInputFiles([
    gj(okA),
    {
      name: "not-geodata.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("nope"),
    },
    {
      name: "broken.geojson",
      mimeType: "application/geo+json",
      buffer: Buffer.from("{ this is not json"),
    },
    gj(okB, 3),
  ]);

  const dialog = page.getByRole("dialog", { name: "Add data" });
  // Both good files import despite the failures between them —
  // the batch is never atomic across files.
  await expect
    .poll(async () => tableNames(page), { timeout: 30_000 })
    .toEqual(expect.arrayContaining([okA, okB]));

  // BOTH failures stand simultaneously, each named under its own file: a last-error-only display
  // fails here.
  const alerts = dialog.getByRole("alert");
  await expect(
    alerts.filter({ hasText: "not-geodata.txt:" }),
  ).toBeVisible();
  await expect(alerts.filter({ hasText: "broken.geojson:" })).toBeVisible();
  await expect(
    alerts.filter({ hasText: /Unsupported file type/ }),
  ).toBeVisible();

  // A batch with failures leaves the host open.
  await expect(dialog).toBeVisible();
  await consumeExpected(consoleErrors, /\/api\/tables/);
  await consumeExpected(consoleErrors, /\/api\/tables/);

  // Closing drops the settled display; the next open starts fresh.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await openAddData(page);
  await expect(
    page.getByRole("dialog", { name: "Add data" }).getByRole("alert"),
  ).toHaveCount(0);

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("an all-successful batch closes the host with a whole-batch outcome; same stems dedup in order", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);
  await page.goto("/data");
  await openAddData(page);

  // Two files with the SAME stem in one batch: drop order
  // decides — the first keeps the unsuffixed name. Distinct feature
  // counts prove which file became which table.
  const twin = `mub2twin_${runId}`;
  await page.locator('input[type="file"]').setInputFiles([
    gj(twin, 2),
    gj(twin, 3),
  ]);

  // The host closes only at settlement, with one whole-batch outcome
  // — not at the first table.
  await expect(page.getByRole("dialog", { name: "Add data" })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  await expect(page.getByRole("status")).toContainText("2 tables ready.");

  const rows = await page.evaluate(async () =>
    ((await (await fetch("/api/tables")).json()) as {
      name: string;
      rowCount: number;
    }[]).map((t) => [t.name, t.rowCount]),
  );
  const byName = new Map(rows as [string, number][]);
  expect(byName.get(twin)).toBe(2);
  expect(byName.get(`${twin}_2`)).toBe(3);

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("mid-batch drops append; the visible and accessible status carry file, phase and position", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);
  await page.goto("/data");
  await openAddData(page);

  // Hold the FIRST upload's answer at the route layer: the batch is
  // observable mid-flight without depending on disk or network speed.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  await page.route("**/api/tables", async (route) => {
    if (route.request().method() !== "POST" || held) return route.fallback();
    held = true;
    await gate;
    return route.continue();
  });

  const first = `mub3a_${runId}`;
  const second = `mub3b_${runId}`;
  const third = `mub3c_${runId}`;
  await page
    .locator('input[type="file"]')
    .setInputFiles([gj(first), gj(second)]);

  // While the first file is in flight, another selection APPENDS and
  // raises the total — and the position tells the truth.
  await expect(page.getByText(/1 of 2/)).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles([gj(third)]);
  await expect(page.getByText(/1 of 3/)).toBeVisible();
  // The accessible status names the file, the phase and the position
  // — the progressbar's label is the screen-reader's truth.
  await expect(
    page.getByRole("progressbar", {
      name: new RegExp(`${first}.*\\(1 of 3\\)`),
    }),
  ).toBeVisible();

  release();
  await expect(page.getByRole("dialog", { name: "Add data" })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  await expect(page.getByRole("status")).toContainText("3 tables ready.");
  await expect
    .poll(async () => tableNames(page))
    .toEqual(expect.arrayContaining([first, second, third]));

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("a lost answer is unconfirmed, not failed: the batch continues and the listing tells the truth", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);
  await page.goto("/data");
  await openAddData(page);

  // The scoped lost-answer fixture: the first POST is forwarded — the
  // server commits — and its answer is dropped on the floor. Listing
  // requests stay untouched, so the authoritative refresh runs.
  let lost = false;
  await page.route("**/api/tables", async (route) => {
    if (route.request().method() !== "POST" || lost) return route.fallback();
    lost = true;
    await route.fetch();
    return route.abort("failed");
  });

  const ghost = `mub4ghost_${runId}`;
  const after = `mub4after_${runId}`;
  await page
    .locator('input[type="file"]')
    .setInputFiles([gj(ghost), gj(after)]);

  const dialog = page.getByRole("dialog", { name: "Add data" });
  // The lost file reports as unconfirmed under its name — never as a
  // definite failure — and the queue continued past it.
  await expect(
    dialog.getByRole("alert").filter({ hasText: `${ghost}.geojson:` }),
  ).toContainText(/unconfirmed/i);
  await expect(
    dialog.getByRole("alert").filter({ hasText: "may still have imported" }),
  ).toBeVisible();
  await expect
    .poll(async () => tableNames(page), { timeout: 30_000 })
    .toEqual(expect.arrayContaining([after]));

  // The server DID commit — the refreshed authoritative listing shows
  // the "lost" table (impossible under a blanket
  // offline fixture).
  await expect
    .poll(async () => tableNames(page))
    .toEqual(expect.arrayContaining([ghost]));

  // An unconfirmed outcome keeps the host open and was not
  // retried: exactly one table landed for the lost file.
  await expect(dialog).toBeVisible();
  const names = await tableNames(page);
  expect(names.filter((n) => n.startsWith(ghost)).length).toBe(1);

  await consumeExpected(consoleErrors, /\/api\/tables/);
  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("dismissal mid-batch: queued files never start, the in-flight outcome lands outside", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);
  await page.goto("/data");
  await openAddData(page);

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let postCount = 0;
  let heldSecond = false;
  await page.route("**/api/tables", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    postCount += 1;
    if (postCount === 2 && !heldSecond) {
      heldSecond = true;
      await gate;
    }
    return route.continue();
  });

  const landed = `mub5a_${runId}`;
  const inflight = `mub5b_${runId}`;
  const stopped = `mub5c_${runId}`;
  // The in-flight file is malformed, so its post-dismissal outcome is
  // a FAILURE — which must land outside the closed host NAMED by file, not as a bare count.
  await page.locator('input[type="file"]').setInputFiles([
    gj(landed),
    {
      name: `${inflight}.geojson`,
      mimeType: "application/geo+json",
      buffer: Buffer.from("{ not geojson at all"),
    },
    gj(stopped),
  ]);

  // Wait until the second file is the one in flight, then dismiss.
  await expect(page.getByText(/2 of 3/)).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Add data" })).toHaveCount(0);
  // The dismissal names what it stopped.
  await expect(page.getByRole("status")).toContainText(
    "Stopped. 1 queued file was not started.",
  );

  release();
  // The in-flight file's outcome lands OUTSIDE the closed host, NAMED
  // by file, with the not-started account.
  const outcome = page.getByRole("status");
  await expect(outcome).toContainText(`${inflight}.geojson failed`, {
    timeout: 30_000,
  });
  await expect(outcome).toContainText("1 not started");
  await expect
    .poll(async () => tableNames(page))
    .toEqual(expect.arrayContaining([landed]));

  // The stopped file was never requested; neither it nor the failed
  // in-flight file landed.
  expect(postCount).toBe(2);
  const names = await tableNames(page);
  expect(names).not.toEqual(expect.arrayContaining([stopped]));
  expect(names).not.toEqual(expect.arrayContaining([inflight]));

  await consumeExpected(consoleErrors, /\/api\/tables/);
  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("drop-anywhere carries every dropped file into a running batch", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);
  await page.goto("/data");

  const dropA = `mub6a_${runId}`;
  const dropB = `mub6b_${runId}`;
  await page.evaluate(
    ({ a, b, bytesA, bytesB }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([bytesA], `${a}.geojson`));
      dt.items.add(new File([bytesB], `${b}.geojson`));
      const target = document.querySelector("[class*='screen']");
      if (!target) throw new Error("no screen drop target");
      target.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    {
      a: dropA,
      b: dropB,
      bytesA: geojsonBytes(["a1", "a2"]).toString("utf8"),
      bytesB: geojsonBytes(["b1"]).toString("utf8"),
    },
  );

  // The dialog opens onto the running batch and settles it whole.
  await expect(page.getByRole("dialog", { name: "Add data" })).toBeVisible();
  await expect
    .poll(async () => tableNames(page), { timeout: 30_000 })
    .toEqual(expect.arrayContaining([dropA, dropB]));
  await expect(page.getByRole("dialog", { name: "Add data" })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  await expect(page.getByRole("status")).toContainText("2 tables ready.");

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("skips from two container files stay visible together, each under its source file", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);
  await page.goto("/data");
  await openAddData(page);

  // Two GeoPackages, each with one attribute-only member the import
  // skips: the settle outcome must attribute BOTH skips to their own
  // source files simultaneously — one file's skips can no
  // longer overwrite the other's.
  const mint = async (stem: string, member: string) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mu-gpkg-"));
    const file = path.join(dir, `${stem}.gpkg`);
    buildGpkg(file, [
      {
        name: "pts",
        kind: "points",
        rows: [[7.1, 51.1, "a"]],
      },
      { name: member, kind: "attributes", rows: [["A", "Alpha"]] },
    ]);
    const buffer = await readFile(file);
    await rm(dir, { recursive: true, force: true });
    return { name: `${stem}.gpkg`, mimeType: "application/octet-stream", buffer };
  };
  const gpA = `mub8a_${runId}`;
  const gpB = `mub8b_${runId}`;
  await page
    .locator('input[type="file"]')
    .setInputFiles([
      await mint(gpA, "first_lookup"),
      await mint(gpB, "second_lookup"),
    ]);

  // Skips do not fail their files: the batch is clean, the host closes
  // at settlement, and the one outcome carries
  // both skips with their sources.
  await expect(page.getByRole("dialog", { name: "Add data" })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  const notice = page.getByRole("status");
  await expect(notice).toContainText("Skipped 2 members");
  await expect(notice).toContainText(`${gpA}.gpkg: first_lookup`);
  await expect(notice).toContainText(`${gpB}.gpkg: second_lookup`);
  // A single-spatial-layer container keeps the file's own stem.
  await expect
    .poll(async () => tableNames(page))
    .toEqual(expect.arrayContaining([gpA, gpB]));

  // The open-host half: when a failure keeps the
  // host OPEN, the skips must show inside it — the close-time notice
  // alone would lose them.
  const gpC = `mub8c_${runId}`;
  await openAddData(page);
  await page.locator('input[type="file"]').setInputFiles([
    await mint(gpC, "third_lookup"),
    {
      name: "wedge.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("nope"),
    },
  ]);
  const dialog = page.getByRole("dialog", { name: "Add data" });
  await expect(
    dialog.getByRole("alert").filter({ hasText: "wedge.txt:" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    dialog
      .getByRole("alert")
      .filter({ hasText: `${gpC}.gpkg: third_lookup` }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await consumeExpected(consoleErrors, /\/api\/tables/);
  await page.keyboard.press("Escape");

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("the builder catalog: a file batch lands one layer per spatial table, framed as one", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");
  await page.getByRole("button", { name: /New map/ }).click();
  await expect(page).toHaveURL(/\/maps\//, { timeout: 30_000 });

  const layA = `mub7a_${runId}`;
  const layB = `mub7b_${runId}`;
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  await page.getByText("Files", { exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Add layer" })).toBeVisible();
  await page
    .locator('input[type="file"]')
    .setInputFiles([gj(layA), gj(layB, 3)]);

  // The catalog closes at settlement and every file's table
  // became a layer — reported as one whole-batch outcome. The
  // notice is transient and the builder holds other live regions, so
  // it is read first and by content.
  await expect(page.getByRole("dialog", { name: "Add layer" })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  await expect(page.getByText(/Added 2 layers to this map/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(layA) }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: new RegExp(layB) }).first(),
  ).toBeVisible();

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});
