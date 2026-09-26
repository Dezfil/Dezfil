// Soft import outcomes: the builder's catalog closes only when every
// file confirmed a layer — files that imported without one hold it open
// with named notes — and a CSV whose detected column names betray a
// broken read wears its advisory warning on every surface.
//
// The unconfirmed-layer fixture forwards the create so the server
// commits, then drops ONLY the answer (the lost-answer manner) — a
// blanket abort could not prove the authoritative reload.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import { buildGpkg } from "../test-support/gpkg";
import {
  consumeExpected,
  routeHouse,
  startFixtureServer,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const FIXTURE = path.join(__dirname, "fixtures", "broken-header.csv");

const gj = (name: string) => ({
  name: `${name}.geojson`,
  mimeType: "application/geo+json",
  buffer: Buffer.from(
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name },
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
        },
      ],
    }),
  ),
});

const attrCsv = (name: string) => ({
  name: `${name}.csv`,
  mimeType: "text/csv",
  buffer: Buffer.from("label,value\na,1\nb,2\n"),
});

async function mintGpkg(
  stem: string,
  layers: "one-spatial-plus-attr" | "two-spatial",
): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-gpkg-"));
  const file = path.join(dir, `${stem}.gpkg`);
  buildGpkg(
    file,
    layers === "one-spatial-plus-attr"
      ? [
          { name: "pts", kind: "points", rows: [[13.4, 52.5, "a"]] },
          { name: "lookup", kind: "attributes", rows: [["A", "Alpha"]] },
        ]
      : [
          { name: "pts", kind: "points", rows: [[13.4, 52.5, "a"]] },
          {
            name: "zones",
            kind: "polygons",
            rows: [
              [
                [13, 52],
                [14, 52],
                [14, 53],
                [13, 53],
                [13, 52],
              ],
            ],
          },
        ],
  );
  const buffer = await readFile(file);
  await rm(dir, { recursive: true, force: true });
  return { name: `${stem}.gpkg`, mimeType: "application/octet-stream", buffer };
}

async function openBuilderFiles(page: Page) {
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  await page.getByText("Files", { exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Add layer" })).toBeVisible();
}

async function newMap(page: Page) {
  await page.goto("/maps");
  // The toolbar's own button, exactly: the gallery's New tile shares the
  // words and made the loose match a strict-mode violation.
  await page.getByRole("button", { name: "New map", exact: true }).click();
  await expect(page).toHaveURL(/\/maps\//, { timeout: 30_000 });
}

async function tableNames(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    ((await (await fetch("/api/tables")).json()) as { name: string }[]).map(
      (t) => t.name,
    ),
  );
}

test("the field find, re-staged: a no-layer file holds the catalog open, named", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await newMap(page);
  await openBuilderFiles(page);

  const good = `so1good_${runId}`;
  const broken = `so1broken_${runId}`;
  await page.locator('input[type="file"]').setInputFiles([
    gj(good),
    {
      name: `${broken}.csv`,
      mimeType: "text/csv",
      buffer: readFileSync(FIXTURE),
    },
  ]);

  const dialog = page.getByRole("dialog", { name: "Add layer" });
  // The good file's layer lands while the catalog HOLDS:
  // the no-layer file is named with its table's outcome.
  await expect(
    dialog
      .getByRole("alert")
      .filter({ hasText: `${broken}.csv:` }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    dialog
      .getByRole("alert")
      .filter({ hasText: "imported as a table: no geometry for a layer" }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(good) }).first(),
  ).toBeAttached({ timeout: 30_000 });

  // The user leaves by choice; a fresh open carries no stale note.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await openBuilderFiles(page);
  await expect(
    page.getByRole("dialog", { name: "Add layer" }).getByRole("alert"),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("a single no-geometry file also holds the catalog; the Data screen still closes", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });

  // Builder: held open with the note.
  await newMap(page);
  await openBuilderFiles(page);
  const solo = `so2solo_${runId}`;
  await page.locator('input[type="file"]').setInputFiles([attrCsv(solo)]);
  const catalog = page.getByRole("dialog", { name: "Add layer" });
  await expect(
    catalog.getByRole("alert").filter({ hasText: `${solo}.csv:` }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(catalog).toBeVisible();
  await page.keyboard.press("Escape");

  // Data screen: the same shape closes at settlement — a table
  // is that host's finished product.
  await page.goto("/data");
  await page.getByRole("button", { name: "Add data" }).first().click();
  await expect(page.getByRole("dialog", { name: "Add data" })).toBeVisible();
  const dataSide = `so2data_${runId}`;
  await page.locator('input[type="file"]').setInputFiles([attrCsv(dataSide)]);
  await expect(page.getByRole("dialog", { name: "Add data" })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  await expect(page.getByRole("status")).toContainText(
    `${dataSide} is ready.`,
  );

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("a rejected layer create holds the catalog with domains distinct", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await newMap(page);

  // Reject exactly one layer create at the seam; uploads run untouched.
  let rejected = false;
  await page.route("**/api/maps/*/layers", async (route) => {
    if (route.request().method() !== "POST" || rejected) {
      return route.fallback();
    }
    rejected = true;
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "invalid_request", message: "Seeded rejection." },
      }),
    });
  });

  await openBuilderFiles(page);
  const spurned = `so3spurned_${runId}`;
  await page.locator('input[type="file"]').setInputFiles([gj(spurned)]);

  const dialog = page.getByRole("dialog", { name: "Add layer" });
  // The layer domain failed; the upload domain did not: the
  // catalog holds with the layer clause, and the table exists.
  await expect(
    dialog
      .getByRole("alert")
      .filter({ hasText: "adding the layer failed" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    dialog.getByRole("alert").filter({ hasText: `${spurned}.geojson:` }),
  ).toBeVisible();
  await expect
    .poll(async () => tableNames(page))
    .toEqual(expect.arrayContaining([spurned]));
  await page.keyboard.press("Escape");
  await consumeExpected(consoleErrors, /\/layers/);

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("an unconfirmed layer create: the answer is lost, the layer is real, nothing retries", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await newMap(page);
  const mapId = page.url().split("/maps/")[1];

  // Forward-then-drop (the lost-answer manner): the server commits the
  // layer; only the ANSWER dies. Map reads stay usable, so the
  // authoritative reload can show the truth.
  let lost = false;
  await page.route("**/api/maps/*/layers", async (route) => {
    if (route.request().method() !== "POST" || lost) return route.fallback();
    lost = true;
    await route.fetch();
    return route.abort("failed");
  });

  await openBuilderFiles(page);
  const ghost = `so4ghost_${runId}`;
  await page.locator('input[type="file"]').setInputFiles([gj(ghost)]);

  const dialog = page.getByRole("dialog", { name: "Add layer" });
  await expect(
    dialog
      .getByRole("alert")
      .filter({ hasText: "could not be confirmed" }),
  ).toBeVisible({ timeout: 30_000 });
  // The note stays an account of uncertainty — no rewrite to a definite
  // result — while the reloaded authoritative state shows the layer, and exactly ONE exists:
  // nothing retried.
  const layers = await page.evaluate(async (id) => {
    return (await (
      await fetch(`/api/maps/${id}/layers`)
    ).json()) as { name: string }[];
  }, mapId);
  expect(
    layers.filter((l) => l.name.startsWith(ghost)).length,
  ).toBe(1);
  await expect(
    dialog.getByRole("alert").filter({ hasText: "could not be confirmed" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await consumeExpected(consoleErrors, /\/layers/);

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("skips do not block closure, and neither does a partial-success file", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });

  // A container whose file confirmed its layer, with a skipped
  // attribute member: closes, which is the skip half of that rule.
  await newMap(page);
  await openBuilderFiles(page);
  const skippy = `so5skippy_${runId}`;
  await page
    .locator('input[type="file"]')
    .setInputFiles([await mintGpkg(skippy, "one-spatial-plus-attr")]);
  await expect(page.getByRole("dialog", { name: "Add layer" })).toHaveCount(
    0,
    { timeout: 30_000 },
  );

  // The gate-ratified carve-out: a two-table file where ONE layer create
  // is rejected still confirmed the other — the catalog closes.
  await newMap(page);
  const partial = `so5partial_${runId}`;
  let rejectedOne = false;
  await page.route("**/api/maps/*/layers", async (route) => {
    if (route.request().method() !== "POST" || rejectedOne) {
      return route.fallback();
    }
    const body = route.request().postDataJSON() as { name?: string };
    if (body.name?.endsWith("_zones")) {
      rejectedOne = true;
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "invalid_request", message: "Seeded rejection." },
        }),
      });
    }
    return route.fallback();
  });
  await openBuilderFiles(page);
  await page
    .locator('input[type="file"]')
    .setInputFiles([await mintGpkg(partial, "two-spatial")]);
  await expect(page.getByRole("dialog", { name: "Add layer" })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  expect(rejectedOne).toBe(true); // the seam actually fired
  await consumeExpected(consoleErrors, /\/layers/);

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("the warning end to end: import answer, card, list row, detail — and a warned spatial file still closes", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/data");

  // The tracked fixture through the real dialog: the import answer
  // carries the flag and the host closes (a table is the Data
  // screen's product).
  const warned = `so6warned_${runId}`;
  const answer = await page.evaluate(
    async ({ name, b64 }) => {
      const raw = atob(b64);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
      const fd = new FormData();
      fd.append("file", new File([arr], `${name}.csv`, { type: "text/csv" }));
      const r = await fetch("/api/tables", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      return (await r.json()) as { name: string; headerSuspect: boolean };
    },
    { name: warned, b64: readFileSync(FIXTURE).toString("base64") },
  );
  expect(answer.headerSuspect).toBe(true);

  // The listing carries it.
  const listed = await page.evaluate(async (n) => {
    const tables = (await (await fetch("/api/tables")).json()) as {
      name: string;
      headerSuspect: boolean;
    }[];
    return tables.find((t) => t.name === n)?.headerSuspect;
  }, answer.name);
  expect(listed).toBe(true);

  // The three Data Explorer surfaces: card chip… (the view
  // preference persists across sessions, so the grid is chosen
  // explicitly rather than assumed).
  await page.reload();
  await page.getByRole("button", { name: "Grid view" }).click();
  const card = page.locator("article").filter({ hasText: answer.name });
  await expect(
    card.getByText("Header looks broken", { exact: true }),
  ).toBeVisible();
  // …list row's inline note… (the view preference is server-stored;
  // the grid is restored after, as the data-in-polish suite does).
  await page.getByRole("button", { name: "List view" }).click();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: answer.name })
      .getByText("Header looks broken"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Grid view" }).click();
  // …and the detail page's chip.
  await page.goto(`/tables/${encodeURIComponent(answer.name)}`);
  await expect(
    page.getByText("Header looks broken", { exact: true }),
  ).toBeVisible();

  // A warned SPATIAL file remains layer-eligible and the warning alone
  // never holds the builder catalog.
  await newMap(page);
  await openBuilderFiles(page);
  const spatialWarn = `so6spatial_${runId}`;
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: `${spatialWarn}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(
        'name,lon,lat,"note, aside"\nA,13.4,52.5,x\nB,13.5,52.6,y\n',
      ),
    },
  ]);
  await expect(page.getByRole("dialog", { name: "Add layer" })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  await expect(
    page.getByRole("button", { name: new RegExp(spatialWarn) }).first(),
  ).toBeVisible({ timeout: 30_000 });

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("URL parity: a URL-imported broken CSV warns; the builder's URL path still closes", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  const fixtures = await startFixtureServer(31879, {
    files: {
      "broken-remote.csv": readFileSync(FIXTURE),
      "plain-remote.csv": Buffer.from("label,value\na,1\n"),
    },
  });
  try {
    await page.goto("/data");
    // the URL road computes the same verdict.
    const viaUrl = await page.evaluate(async (name) => {
      const r = await fetch("/api/imports/url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "http://127.0.0.1:31879/files/broken-remote.csv",
          name,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      return (await r.json()) as { headerSuspect: boolean };
    }, `so7url_${runId}`);
    expect(viaUrl.headerSuspect).toBe(true);

    // the builder catalog's URL pane keeps its close-on-table
    // manner even for a no-geometry CSV.
    await newMap(page);
    await page
      .getByRole("button", { name: "Add layer", exact: true })
      .click();
    await page.getByText("Files", { exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add layer" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tab", { name: "From URL" }).click();
    await dialog
      .getByRole("textbox")
      .first()
      .fill("http://127.0.0.1:31879/files/plain-remote.csv");
    await dialog.getByRole("button", { name: /Import/ }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await fixtures.close();
  }

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});
