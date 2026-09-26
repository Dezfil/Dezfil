// Old-defect-sensitive browser journey: every in-builder layer-data door
// fails safely in place, bounded control requests release the exact action,
// Retry uses a native attachment, and the builder stays intact. The assistant
// model exchange is deterministic fixture NDJSON; its layer download still
// uses the real route.
import { readFileSync } from "node:fs";
import {
  expect,
  test,
  type Download,
  type Locator,
  type Page,
} from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  consumeExpected,
  routeHouse,
  seedCsv,
  trackConsole,
} from "./support";

type LayerFormat = "geoparquet" | "geojson" | "csv";

interface PrepareFault {
  format: LayerFormat;
  kind: "coded" | "malformed";
  raw: string;
  arrived?: () => void;
  release?: Promise<void>;
}

/** A ticket has already been issued; its next three completion observations
 * are held beyond the client's own boundary. The fixture does not answer the
 * requests to manufacture a failure; their release happens only after the
 * recovery is already visible. */
interface HeldStatusObservations {
  format: LayerFormat;
  observations: number;
  arrivalTimes: number[];
  firstArrived: () => void;
  thirdArrived: () => void;
  release: Promise<void>;
}

interface NonOkStatusResponses {
  format: LayerFormat;
  raw: string;
  observations: number;
  thirdArrived: () => void;
}

const runId = Date.now().toString(36);
const tableName = `dlr_${runId}`;
const layerName = "Recovery points";
const STATUS_OBSERVATION_TIMEOUT_MS = 5_000;
const STATUS_OBSERVATION_COUNT = 3;
const STATUS_POLL_INTERVAL_MS = 250;
// Three 5-second observations plus the two existing 250 ms poll gaps: 15,500
// ms of deterministic product budget. The extra two seconds below is test-only
// browser scheduling and recovery-render headroom, not a wider product bound.
const STATUS_CONTROL_BUDGET_MS =
  STATUS_OBSERVATION_TIMEOUT_MS * STATUS_OBSERVATION_COUNT +
  STATUS_POLL_INTERVAL_MS * (STATUS_OBSERVATION_COUNT - 1);
const BROWSER_RECOVERY_RENDER_MARGIN_MS = 2_000;

function failureNote(
  page: Page,
  layerId: string,
  format: LayerFormat,
): Locator {
  return page.locator(`[data-layer-download-failed="${layerId}:${format}"]`);
}

function activeNote(page: Page, layerId: string, format: LayerFormat): Locator {
  return page.locator(`[data-layer-download-active="${layerId}:${format}"]`);
}

async function expectWorkspaceIntact(
  page: Page,
  builderUrl: string,
): Promise<void> {
  expect(page.url()).toBe(builderUrl);
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(`^${layerName}`) }).first(),
  ).toBeVisible();
  await expect(page.getByText("2 features").first()).toBeVisible();
}

async function expectRecoverableFailure(
  page: Page,
  layerId: string,
  format: LayerFormat,
  message: string,
  raw?: string,
): Promise<Locator> {
  const note = failureNote(page, layerId, format);
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute("role", "alert");
  await expect(note).toContainText(message);
  if (raw !== undefined) {
    await expect(note).not.toContainText(raw);
    await expect(page.locator("body")).not.toContainText(raw);
  }
  await expect(
    note.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await expect(
    note.getByRole("button", { name: "Dismiss", exact: true }),
  ).toBeVisible();
  return note;
}

async function retryNative(page: Page, note: Locator): Promise<Download> {
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await note.getByRole("button", { name: "Retry", exact: true }).click();
  const download = await downloadPromise;
  expect(download.url()).not.toMatch(/^blob:/);
  expect(new URL(download.url()).searchParams.has("__ui_download")).toBe(true);
  return download;
}

async function expectInertLayerDownloadAction(
  page: Page,
  action: Locator,
): Promise<void> {
  const muted = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--fg-muted)";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await action.hover();
  await expect(action).toHaveCSS("cursor", "not-allowed");
  await expect(action).toHaveCSS("color", muted);
  await expect(action).toHaveCSS("text-decoration-line", "none");
}

async function openHeaderFormat(page: Page, label: string): Promise<Locator> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Export" });
  await menu.getByRole("menuitem", { name: /Data/ }).click();
  const row = menu.locator("[class*=layerRow]", { hasText: layerName });
  await expect(row).toBeVisible();
  await row.hover();
  const action = row.getByRole("menuitem", { name: label, exact: true });
  await expect(action).toBeVisible();
  return action;
}

async function openRowFormat(page: Page, label: string): Promise<Locator> {
  const card = page
    .getByRole("listitem")
    .filter({ hasText: layerName })
    .first();
  await card.getByRole("button", { name: "Layer menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Export data", exact: true })
    .click();
  const action = page.getByRole("menuitem", {
    name: new RegExp(`^${label}\\b`),
  });
  await expect(action).toBeVisible();
  return action;
}

async function readDownload(download: Download): Promise<Buffer> {
  const file = await download.path();
  if (!file) throw new Error("native layer download has no saved file");
  return readFileSync(file);
}

test.describe.configure({ mode: "serial" });

test("all layer-data doors recover in place through native downloads", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });

  await page.goto("/maps");
  await seedCsv(
    page,
    tableName,
    "name,lon,lat\nAlpha,13.405,52.520\nBeta,13.377,52.516\n",
  );
  const mapId = await createMap(page, `Layer download recovery ${runId}`);
  const layerId = await addLayer(
    page,
    mapId,
    layerName,
    `SELECT name, ST_Point(lon, lat) AS geometry FROM "${tableName}"`,
  );

  let fault: PrepareFault | null = null;
  let heldStatus: HeldStatusObservations | null = null;
  let nonOkStatus: NonOkStatusResponses | null = null;
  const prepareCounts = new Map<LayerFormat, number>();
  await page.route("**/api/layers/**", async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(
      new RegExp(`^/api/layers/${layerId}/export/(geoparquet|geojson|csv)$`),
    );
    const format = match?.[1] as LayerFormat | undefined;
    if (!format) {
      await route.continue();
      return;
    }

    const statusTicket = url.searchParams.get("__ui_status");
    const isRelease = url.searchParams.get("__ui_release") === "1";
    if (
      statusTicket &&
      !isRelease &&
      heldStatus?.format === format
    ) {
      const selected = heldStatus;
      selected.observations += 1;
      selected.arrivalTimes.push(Date.now());
      if (selected.observations === 1) selected.firstArrived();
      if (selected.observations === STATUS_OBSERVATION_COUNT) {
        heldStatus = null;
        selected.thirdArrived();
      }
      await selected.release;
      // Every fetch has already been cancelled by the product boundary. The
      // late route action only lets Playwright settle its fixture callback;
      // it is deliberately too late to cause the claimed recovery.
      await route.continue().catch(() => undefined);
      return;
    }
    if (statusTicket && !isRelease && nonOkStatus?.format === format) {
      const selected = nonOkStatus;
      selected.observations += 1;
      if (selected.observations === STATUS_OBSERVATION_COUNT) {
        nonOkStatus = null;
        selected.thirdArrived();
      }
      await route.fulfill({
        status: 502,
        contentType: "text/html",
        body: `<html><body>${selected.raw}</body></html>`,
      });
      return;
    }

    if (url.searchParams.get("__ui_prepare") !== "1") {
      await route.continue();
      return;
    }
    prepareCounts.set(format, (prepareCounts.get(format) ?? 0) + 1);
    if (!fault || fault.format !== format) {
      await route.continue();
      return;
    }

    const selected = fault;
    fault = null;
    selected.arrived?.();
    if (selected.release) await selected.release;
    if (selected.kind === "coded") {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "sql_error",
            message: selected.raw,
            detail: `/tmp/${selected.raw}.duckdb`,
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 502,
      contentType: "text/html",
      body: `<html><body>${selected.raw}</body></html>`,
    });
  });

  let assistantMessages = 0;
  await page.route("**/api/assistant", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        provider: "fixture",
        model: "fixture-export-model",
        stepBudget: 4,
      }),
    });
  });
  // the fixture owns a reservation and its recovery receipt as well as
  // events, so the real pane never consumes an unbound synthetic exchange.
  const assistantRunId = "fixture-export-run";
  await page.route("**/api/assistant/runs", (route) => route.fulfill({
    json: { id: assistantRunId, state: "reserved", text: "", actions: [], incomplete: false },
  }));
  await page.route("**/api/assistant/pending", (route) => route.fulfill({ json: { pending: [] } }));
  await page.route(`**/api/assistant/runs/${assistantRunId}`, (route) => route.fulfill({ json: {
    id: assistantRunId, state: "completed", text: "The layer export is ready.", incomplete: false,
    actions: [{ id: "fixture-layer-export", tool: "export_layer_data", status: "succeeded",
      args: { id: layerId, format: "geoparquet" }, effects: { readOnly: true, writes: [] } }],
  } }));
  await page.route("**/api/assistant/messages", async (route) => {
    assistantMessages += 1;
    expect(route.request().postDataJSON().runId).toBe(assistantRunId);
    const events = [
      {
        type: "tool_call",
        id: "fixture-layer-export",
        tool: "export_layer_data",
        args: { id: layerId, format: "geoparquet" },
      },
      {
        type: "tool_result",
        id: "fixture-layer-export",
        tool: "export_layer_data",
        ok: true,
        body: { attachment: "prepared by fixture" },
      },
      { type: "message", text: "The layer export is ready." },
      { type: "done", reason: "end" },
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    });
  });

  await page.goto(`/maps/${mapId}`);
  await expect(page.getByText("2 features").first()).toBeVisible({
    timeout: 30_000,
  });
  const builderUrl = page.url();
  const prepareConsole = (format: LayerFormat) =>
    new RegExp(`/api/layers/${layerId}/export/${format}\\?__ui_prepare=1`);
  const statusConsole = (format: LayerFormat) =>
    new RegExp(`/api/layers/${layerId}/export/${format}\\?__ui_status=`);
  await test.step("header door: coded failure, persistent safe rail, exact Retry download", async () => {
    const raw = "HEADER_RAW_BINDER_SECRET";
    fault = { format: "csv", kind: "coded", raw };
    const csv = await openHeaderFormat(page, "CSV");
    await csv.click();
    await expect(page.getByRole("menu", { name: "Export" })).toHaveCount(0);

    const note = await expectRecoverableFailure(
      page,
      layerId,
      "csv",
      "The SQL failed to parse or execute.",
      raw,
    );
    await consumeExpected(consoleErrors, prepareConsole("csv"));
    await expectWorkspaceIntact(page, builderUrl);
    const download = await retryNative(page, note);
    expect(download.suggestedFilename()).toBe(`${layerName}.csv`);
    const text = (await readDownload(download)).toString("utf8");
    expect(text).toContain("Alpha");
    expect(text).toContain("POINT");
    await expect(activeNote(page, layerId, "csv")).toHaveCount(0);
    await expectWorkspaceIntact(page, builderUrl);
  });

  await test.step("row door: coded failure and exact Retry download", async () => {
    const raw = "ROW_RAW_ENGINE_SECRET";
    fault = { format: "geojson", kind: "coded", raw };
    const geojson = await openRowFormat(page, "GeoJSON");
    await geojson.click();
    await expect(
      page.getByRole("menuitem", { name: "Export data", exact: true }),
    ).toHaveCount(0);

    const note = await expectRecoverableFailure(
      page,
      layerId,
      "geojson",
      "The SQL failed to parse or execute.",
      raw,
    );
    await consumeExpected(consoleErrors, prepareConsole("geojson"));
    await expectWorkspaceIntact(page, builderUrl);
    const download = await retryNative(page, note);
    expect(download.suggestedFilename()).toBe(`${layerName}.geojson`);
    const body = JSON.parse(
      (await readDownload(download)).toString("utf8"),
    ) as {
      type: string;
      features: { properties: { name?: string } }[];
    };
    expect(body.type).toBe("FeatureCollection");
    expect(
      body.features.map((feature) => feature.properties.name).sort(),
    ).toEqual(["Alpha", "Beta"]);
    await expect(activeNote(page, layerId, "geojson")).toHaveCount(0);
    await expectWorkspaceIntact(page, builderUrl);
  });

  let assistantDoor: Locator | undefined;
  await test.step("assistant door: fixture events reach the real coded failure and Retry download", async () => {
    await page.getByRole("button", { name: "Open assistant" }).click();
    await expect(page.getByText("fixture-export-model")).toBeVisible();
    const input = page.getByPlaceholder("Ask the assistant…");
    await input.fill("Export this layer as GeoParquet");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    assistantDoor = page.getByRole("button", {
      name: "Download the GeoParquet file",
      exact: true,
    });
    await expect(assistantDoor).toBeVisible();
    expect(assistantMessages).toBe(1);

    const raw = "ASSISTANT_RAW_FILESYSTEM_SECRET";
    fault = { format: "geoparquet", kind: "coded", raw };
    await assistantDoor.click();
    const note = await expectRecoverableFailure(
      page,
      layerId,
      "geoparquet",
      "The SQL failed to parse or execute.",
      raw,
    );
    await consumeExpected(consoleErrors, prepareConsole("geoparquet"));
    await expectWorkspaceIntact(page, builderUrl);
    const download = await retryNative(page, note);
    expect(download.suggestedFilename()).toBe(`${layerName}.parquet`);
    const bytes = await readDownload(download);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("PAR1");
    expect(bytes.subarray(-4).toString("ascii")).toBe("PAR1");
    await expect(activeNote(page, layerId, "geoparquet")).toHaveCount(0);
    await expectWorkspaceIntact(page, builderUrl);
  });

  await test.step("a held malformed row prepare makes every matching door visibly inert and stays safely recoverable", async () => {
    let releaseMalformed!: () => void;
    let markArrived!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseMalformed = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      markArrived = resolve;
    });
    const raw = "MALFORMED_HTML_TMP_SECRET";
    fault = {
      format: "geoparquet",
      kind: "malformed",
      raw,
      arrived: markArrived,
      release: released,
    };
    const before = prepareCounts.get("geoparquet") ?? 0;
    const rowGeoParquet = await openRowFormat(page, "GeoParquet");
    await rowGeoParquet.click();
    await arrived;
    await expect(activeNote(page, layerId, "geoparquet")).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Export data", exact: true }),
    ).toHaveCount(0);

    // Reopen through another door while the row action is held. The exact
    // layer+format is inert, while a different format remains available.
    const sameGeoParquet = await openHeaderFormat(page, "GeoParquet");
    await expect(sameGeoParquet).toHaveAttribute("aria-disabled", "true");
    await expectInertLayerDownloadAction(page, sameGeoParquet);
    const menu = page.getByRole("menu", { name: "Export" });
    const headerRow = menu.locator("[class*=layerRow]", { hasText: layerName });
    const otherFormat = headerRow.getByRole("menuitem", {
      name: "GeoJSON",
      exact: true,
    });
    await expect(otherFormat).not.toHaveAttribute("aria-disabled", "true");
    await sameGeoParquet.focus();
    await page.keyboard.press("Enter");
    await sameGeoParquet.dispatchEvent("click");
    await page.waitForTimeout(100);
    expect(prepareCounts.get("geoparquet")).toBe(before + 1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu", { name: "Export" })).toHaveCount(0);

    const rowAgain = await openRowFormat(page, "GeoParquet");
    await expect(rowAgain).toHaveAttribute("aria-disabled", "true");
    await expectInertLayerDownloadAction(page, rowAgain);
    await rowAgain.dispatchEvent("click");
    expect(prepareCounts.get("geoparquet")).toBe(before + 1);
    await page.keyboard.press("Escape");

    // The pane is a working surface that an outside click does
    // not close, so using an export menu leaves it open and its transcript
    // on screen. This step used to press "Open assistant" here, which the
    // pane's own door has not read since, and timed out before the
    // assertions below.
    await expect(page.getByRole("button", { name: "Open assistant" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close assistant" }).first()).toBeVisible();
    assistantDoor = page.getByRole("button", {
      name: "Download the GeoParquet file",
      exact: true,
    });
    await expect(assistantDoor).toBeVisible();
    await expect(assistantDoor).toBeDisabled();
    await expectInertLayerDownloadAction(page, assistantDoor);
    await assistantDoor.dispatchEvent("click");
    expect(prepareCounts.get("geoparquet")).toBe(before + 1);

    releaseMalformed();
    const note = await expectRecoverableFailure(
      page,
      layerId,
      "geoparquet",
      "An unexpected server error occurred.",
      raw,
    );
    await consumeExpected(consoleErrors, prepareConsole("geoparquet"));
    await expectWorkspaceIntact(page, builderUrl);
    await note.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(note).toHaveCount(0);
    await expectWorkspaceIntact(page, builderUrl);
  });

  await test.step("non-OK status responses keep raw bodies out of authored recovery prose", async () => {
    let markThirdArrived!: () => void;
    const thirdArrived = new Promise<void>((resolve) => {
      markThirdArrived = resolve;
    });
    const raw = "TRANSFER_STATUS_RAW_TMP_SECRET";
    const before = prepareCounts.get("csv") ?? 0;
    const responses: NonOkStatusResponses = {
      format: "csv",
      raw,
      observations: 0,
      thirdArrived: markThirdArrived,
    };
    nonOkStatus = responses;

    const csv = await openHeaderFormat(page, "CSV");
    await csv.click();
    await thirdArrived;
    expect(responses.observations).toBe(STATUS_OBSERVATION_COUNT);
    expect(prepareCounts.get("csv")).toBe(before + 1);

    const note = await expectRecoverableFailure(
      page,
      layerId,
      "csv",
      "The download could not be confirmed. Check your Downloads, then retry if needed.",
      raw,
    );
    for (let count = 0; count < STATUS_OBSERVATION_COUNT; count += 1) {
      await consumeExpected(consoleErrors, statusConsole("csv"));
    }
    await expectWorkspaceIntact(page, builderUrl);
    await note.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(note).toHaveCount(0);
    await expectWorkspaceIntact(page, builderUrl);
  });

  await test.step("three genuinely held status observations settle one action without disturbing another, then Retry redownloads natively", async () => {
    let markFirstArrived!: () => void;
    const firstArrived = new Promise<void>((resolve) => {
      markFirstArrived = resolve;
    });
    let markThirdArrived!: () => void;
    const thirdArrived = new Promise<void>((resolve) => {
      markThirdArrived = resolve;
    });
    let releaseStatusHolds!: () => void;
    const statusHoldsReleased = new Promise<void>((resolve) => {
      releaseStatusHolds = resolve;
    });
    const before = prepareCounts.get("csv") ?? 0;
    const transfer: HeldStatusObservations = {
      format: "csv" as const,
      observations: 0,
      arrivalTimes: [],
      firstArrived: markFirstArrived,
      thirdArrived: markThirdArrived,
      release: statusHoldsReleased,
    };
    heldStatus = transfer;

    const originalDownloadPromise = page.waitForEvent("download", {
      timeout: 60_000,
    });
    const csv = await openHeaderFormat(page, "CSV");
    await csv.click();
    await firstArrived;
    const firstStatusAt = transfer.arrivalTimes[0];
    expect(transfer.observations).toBe(1);
    expect(prepareCounts.get("csv")).toBe(before + 1);
    await expect(activeNote(page, layerId, "csv")).toBeVisible();

    // Keep a different format's preparation genuinely active while CSV's
    // status reads time out. CSV is inert, GeoJSON remains available, and
    // the CSV settlement below must not clear the GeoJSON action.
    let releaseOtherPrepare!: () => void;
    const otherPrepareReleased = new Promise<void>((resolve) => {
      releaseOtherPrepare = resolve;
    });
    let markOtherArrived!: () => void;
    const otherArrived = new Promise<void>((resolve) => {
      markOtherArrived = resolve;
    });
    const otherRaw = "CONCURRENT_GEOJSON_PREPARE_SECRET";
    fault = {
      format: "geojson",
      kind: "malformed",
      raw: otherRaw,
      arrived: markOtherArrived,
      release: otherPrepareReleased,
    };

    const sameCsv = await openHeaderFormat(page, "CSV");
    await expect(sameCsv).toHaveAttribute("aria-disabled", "true");
    await expectInertLayerDownloadAction(page, sameCsv);
    const heldMenu = page.getByRole("menu", { name: "Export" });
    const heldRow = heldMenu.locator("[class*=layerRow]", {
      hasText: layerName,
    });
    const otherGeoJSON = heldRow.getByRole("menuitem", {
      name: "GeoJSON",
      exact: true,
    });
    await expect(otherGeoJSON).not.toHaveAttribute("aria-disabled", "true");
    await otherGeoJSON.click();
    await otherArrived;
    await expect(activeNote(page, layerId, "csv")).toBeVisible();
    await expect(activeNote(page, layerId, "geojson")).toBeVisible();

    await thirdArrived;
    expect(transfer.observations).toBe(3);
    expect(
      transfer.arrivalTimes[1] - transfer.arrivalTimes[0],
    ).toBeGreaterThanOrEqual(STATUS_OBSERVATION_TIMEOUT_MS);
    expect(
      transfer.arrivalTimes[2] - transfer.arrivalTimes[1],
    ).toBeGreaterThanOrEqual(STATUS_OBSERVATION_TIMEOUT_MS);
    await expect(failureNote(page, layerId, "csv")).toBeVisible({
      timeout:
        STATUS_OBSERVATION_TIMEOUT_MS + BROWSER_RECOVERY_RENDER_MARGIN_MS,
    });

    const note = await expectRecoverableFailure(
      page,
      layerId,
      "csv",
      "The download could not be confirmed. Check your Downloads, then retry if needed.",
    );
    const recoveryElapsedMs = Date.now() - firstStatusAt;
    expect(recoveryElapsedMs).toBeGreaterThanOrEqual(
      STATUS_OBSERVATION_TIMEOUT_MS * STATUS_OBSERVATION_COUNT,
    );
    expect(recoveryElapsedMs).toBeLessThan(
      STATUS_CONTROL_BUDGET_MS + BROWSER_RECOVERY_RENDER_MARGIN_MS,
    );
    await expect(activeNote(page, layerId, "csv")).toHaveCount(0);
    await expect(activeNote(page, layerId, "geojson")).toBeVisible();
    await expectWorkspaceIntact(page, builderUrl);

    // Status uncertainty never owns or cancels the native attachment. Prove
    // the original transfer, not just the later Retry, while all three timed-
    // out fixture callbacks are still held.
    const originalDownload = await originalDownloadPromise;
    expect(originalDownload.url()).not.toMatch(/^blob:/);
    expect(
      new URL(originalDownload.url()).searchParams.has("__ui_download"),
    ).toBe(true);
    expect(originalDownload.suggestedFilename()).toBe(`${layerName}.csv`);
    const originalText = (await readDownload(originalDownload)).toString(
      "utf8",
    );
    expect(originalText).toContain("Alpha");
    expect(originalText).toContain("POINT");

    // The three route promises remained unanswered through the visible
    // recovery. Release only now, then settle the independent GeoJSON arm.
    releaseStatusHolds();
    releaseOtherPrepare();
    const otherNote = await expectRecoverableFailure(
      page,
      layerId,
      "geojson",
      "An unexpected server error occurred.",
      otherRaw,
    );
    await consumeExpected(consoleErrors, prepareConsole("geojson"));
    await otherNote
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect(otherNote).toHaveCount(0);

    const download = await retryNative(page, note);
    expect(download.suggestedFilename()).toBe(`${layerName}.csv`);
    const text = (await readDownload(download)).toString("utf8");
    expect(text).toContain("Alpha");
    expect(text).toContain("POINT");
    await expect(activeNote(page, layerId, "csv")).toHaveCount(0);
    await expectWorkspaceIntact(page, builderUrl);
  });

  const unexpected = consoleErrors.filter(
    (entry) => !isAllowedConsoleError(entry.text, entry.url),
  );
  expect(unexpected).toEqual([]);
});
