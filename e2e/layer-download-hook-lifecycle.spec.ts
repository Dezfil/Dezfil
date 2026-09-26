// Production-hook evidence for the lifecycle edges audited after 0093. The
// fixtures replace browser-global fetch only at the hook's private control
// URLs; React, Next navigation, the hook, and its visible recovery DOM are the
// production paths under test.
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  routeHouse,
  seedCsv,
  trackConsole,
  type ConsoleError,
} from "./support";

type StatusFixtureReply = "held" | "streaming";

interface DepartureBrowserHarness {
  realmId: string;
  prepareUrl: string;
  releaseUrl: string;
  prepareCalls: number;
  responseStatus: number | null;
  bodyReadStarted: boolean;
  bodyReleased: boolean;
  prepareAborted: boolean;
  firstPrepareAt: number | null;
  bodyReleasedAt: number | null;
  releaseUrls: string[];
  releaseTicketBody: () => void;
}

interface StatusBrowserHarness {
  statusPath: string;
  replies: StatusFixtureReply[];
  observations: StatusFixtureReply[];
  heldAborts: number;
}

declare global {
  interface Window {
    __dezfilDepartureHarness?: DepartureBrowserHarness;
    __dezfilStatusHarness?: StatusBrowserHarness;
  }
}

const runId = Date.now().toString(36);
const layerName = "Hook lifecycle points";
const PREPARATION_TIMEOUT_MS = 90_000;
const STATUS_TIMEOUT_MS = 5_000;
const STATUS_POLL_MS = 250;
const STATUS_RECOVERY_BOUNDARY_MS =
  STATUS_TIMEOUT_MS * 3 + STATUS_POLL_MS * 2;

function prepareUrl(layerId: string): string {
  return `/api/layers/${encodeURIComponent(layerId)}/export/csv?__ui_prepare=1`;
}

function failureNote(page: Page, layerId: string): Locator {
  return page.locator(`[data-layer-download-failed="${layerId}:csv"]`);
}

function activeNote(page: Page, layerId: string): Locator {
  return page.locator(`[data-layer-download-active="${layerId}:csv"]`);
}

async function openHeaderCsv(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Export" });
  await menu.getByRole("menuitem", { name: /Data/ }).click();
  const row = menu.locator("[class*=layerRow]", { hasText: layerName });
  await expect(row).toBeVisible();
  await row.hover();
  const csv = row.getByRole("menuitem", { name: "CSV", exact: true });
  await expect(csv).toBeVisible();
  return csv;
}

async function expectBuilderReady(
  page: Page,
  mapId: string,
  mapName: string,
  expectedLayerName?: string,
): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`/maps/${mapId}(?:\\?|$)`));
  await expect(
    page.getByRole("button", { name: mapName, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  if (expectedLayerName) {
    await expect(
      page.getByRole("button", {
        name: new RegExp(`^${expectedLayerName}`),
      }).first(),
    ).toBeVisible();
    await expect(page.getByText("2 features").first()).toBeVisible();
  }
}

async function seedBuilder(
  page: Page,
  suffix: string,
): Promise<{ mapId: string; mapName: string; layerId: string }> {
  await page.goto("/maps");
  const tableName = `hook_${runId}_${suffix}`;
  await seedCsv(
    page,
    tableName,
    "name,lon,lat\nAlpha,13.405,52.520\nBeta,13.377,52.516\n",
  );
  const mapName = `Hook lifecycle ${suffix} ${runId}`;
  const mapId = await createMap(page, mapName);
  const layerId = await addLayer(
    page,
    mapId,
    layerName,
    `SELECT name, ST_Point(lon, lat) AS geometry FROM "${tableName}"`,
  );
  await page.goto(`/maps/${mapId}`);
  await expectBuilderReady(page, mapId, mapName, layerName);
  return { mapId, mapName, layerId };
}

async function seedBuilderPair(page: Page): Promise<{
  mapAId: string;
  mapAName: string;
  mapBId: string;
  mapBName: string;
  layerId: string;
}> {
  await page.goto("/maps");
  const tableName = `hook_${runId}_departure`;
  await seedCsv(
    page,
    tableName,
    "name,lon,lat\nAlpha,13.405,52.520\nBeta,13.377,52.516\n",
  );
  const mapAName = `Hook departure A ${runId}`;
  const mapBName = `Hook departure B ${runId}`;
  const mapAId = await createMap(page, mapAName);
  const mapBId = await createMap(page, mapBName);
  const layerId = await addLayer(
    page,
    mapAId,
    layerName,
    `SELECT name, ST_Point(lon, lat) AS geometry FROM "${tableName}"`,
  );
  await page.goto(`/maps/${mapAId}`);
  await expectBuilderReady(page, mapAId, mapAName, layerName);
  return { mapAId, mapAName, mapBId, mapBName, layerId };
}

async function navigateThroughMapsTo(
  page: Page,
  mapId: string,
  mapName: string,
  realmId: string,
  expectedLayerName?: string,
): Promise<void> {
  const productNav = page.getByRole("navigation", {
    name: "Product navigation",
  });
  await productNav.getByRole("link", { name: "Maps", exact: true }).click();
  await expect(page).toHaveURL(/\/maps$/);
  expect(await departureRealmId(page)).toBe(realmId);

  // Map cards use Next's client router. Together with the rail's Next Link,
  // this changes builder ownership without creating a new Window realm.
  await page.getByLabel(`Open ${mapName}`, { exact: true }).click();
  await expectBuilderReady(page, mapId, mapName, expectedLayerName);
  expect(await departureRealmId(page)).toBe(realmId);
}

async function installDepartureHarness(
  page: Page,
  layerId: string,
  lateTicket: string,
): Promise<{ realmId: string; releaseUrl: string }> {
  const exactPrepareUrl = prepareUrl(layerId);
  const releaseUrl = `/api/layers/${encodeURIComponent(layerId)}/export/csv?__ui_status=${encodeURIComponent(lateTicket)}&__ui_release=1`;
  await page.evaluate(
    ({ exactPrepareUrl, releaseUrl, lateTicket }) => {
      const nativeFetch = window.fetch.bind(window);
      let ticketBody: ReadableStreamDefaultController<Uint8Array> | null =
        null;
      const harness: DepartureBrowserHarness = {
        realmId: crypto.randomUUID(),
        prepareUrl: exactPrepareUrl,
        releaseUrl,
        prepareCalls: 0,
        responseStatus: null,
        bodyReadStarted: false,
        bodyReleased: false,
        prepareAborted: false,
        firstPrepareAt: null,
        bodyReleasedAt: null,
        releaseUrls: [],
        releaseTicketBody: () => {
          if (!ticketBody) throw new Error("ticket response was not created");
          if (harness.bodyReleased) throw new Error("ticket body released twice");
          harness.bodyReleased = true;
          harness.bodyReleasedAt = performance.now();
          ticketBody.enqueue(
            new TextEncoder().encode(JSON.stringify({ ticket: lateTicket })),
          );
          ticketBody.close();
        },
      };
      window.__dezfilDepartureHarness = harness;

      window.fetch = async (input, init) => {
        const raw =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : input.toString();
        const url = new URL(raw, location.origin);
        const relative = `${url.pathname}${url.search}`;

        if (relative === exactPrepareUrl) {
          harness.prepareCalls += 1;
          if (harness.prepareCalls === 1) {
            harness.firstPrepareAt = performance.now();
            const signal = init?.signal;
            const recordAbort = () => {
              harness.prepareAborted = true;
            };
            if (signal?.aborted) recordAbort();
            else signal?.addEventListener("abort", recordAbort, { once: true });
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                ticketBody = controller;
              },
            });
            const response = new Response(body, {
              status: 200,
              headers: { "content-type": "application/json" },
            });
            harness.responseStatus = response.status;
            const readJson = response.json.bind(response);
            Object.defineProperty(response, "json", {
              value: () => {
                harness.bodyReadStarted = true;
                return readJson();
              },
            });
            return response;
          }

          // The post-navigation action is a new production-hook request. A
          // coded answer makes its independent settlement visible without
          // creating a native transfer for the synthetic late ticket.
          return Response.json(
            {
              error: {
                code: "sql_error",
                message: "retry sentinel",
              },
            },
            { status: 422 },
          );
        }

        if (relative === releaseUrl) {
          harness.releaseUrls.push(relative);
          return new Response(null, { status: 204 });
        }
        return nativeFetch(input, init);
      };
    },
    { exactPrepareUrl, releaseUrl, lateTicket },
  );
  const realmId = await departureRealmId(page);
  return { realmId, releaseUrl };
}

async function departureRealmId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const harness = window.__dezfilDepartureHarness;
    if (!harness) throw new Error("departure harness left its Window realm");
    return harness.realmId;
  });
}

async function departureSnapshot(page: Page): Promise<{
  prepareCalls: number;
  responseStatus: number | null;
  bodyReadStarted: boolean;
  bodyReleased: boolean;
  prepareAborted: boolean;
  firstPrepareAt: number | null;
  bodyReleasedAt: number | null;
  releaseUrls: string[];
}> {
  return page.evaluate(() => {
    const harness = window.__dezfilDepartureHarness;
    if (!harness) throw new Error("departure harness left its Window realm");
    return {
      prepareCalls: harness.prepareCalls,
      responseStatus: harness.responseStatus,
      bodyReadStarted: harness.bodyReadStarted,
      bodyReleased: harness.bodyReleased,
      prepareAborted: harness.prepareAborted,
      firstPrepareAt: harness.firstPrepareAt,
      bodyReleasedAt: harness.bodyReleasedAt,
      releaseUrls: [...harness.releaseUrls],
    };
  });
}

async function releaseDepartedTicketBody(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__dezfilDepartureHarness;
    if (!harness) throw new Error("departure harness left its Window realm");
    harness.releaseTicketBody();
  });
}

async function installStatusHarness(
  page: Page,
  layerId: string,
  replies: StatusFixtureReply[],
): Promise<void> {
  const statusPath = `/api/layers/${encodeURIComponent(layerId)}/export/csv`;
  await page.evaluate(
    ({ statusPath, replies }) => {
      const nativeFetch = window.fetch.bind(window);
      const harness: StatusBrowserHarness = {
        statusPath,
        replies,
        observations: [],
        heldAborts: 0,
      };
      window.__dezfilStatusHarness = harness;
      window.fetch = async (input, init) => {
        const raw =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : input.toString();
        const url = new URL(raw, location.origin);
        const isStatusObservation =
          url.pathname === statusPath &&
          url.searchParams.has("__ui_status") &&
          url.searchParams.get("__ui_release") !== "1";
        if (!isStatusObservation) return nativeFetch(input, init);

        const reply = harness.replies[harness.observations.length] ?? "held";
        harness.observations.push(reply);
        if (reply === "streaming") {
          return Response.json({ status: "streaming" });
        }
        const signal = init?.signal;
        const recordAbort = () => {
          harness.heldAborts += 1;
        };
        if (signal?.aborted) recordAbort();
        else signal?.addEventListener("abort", recordAbort, { once: true });
        return new Promise<Response>(() => {});
      };
    },
    { statusPath, replies },
  );
}

async function statusSnapshot(page: Page): Promise<{
  observations: StatusFixtureReply[];
  heldAborts: number;
}> {
  return page.evaluate(() => {
    const harness = window.__dezfilStatusHarness;
    if (!harness) throw new Error("status harness was not installed");
    return {
      observations: [...harness.observations],
      heldAborts: harness.heldAborts,
    };
  });
}

async function pauseBrowserClock(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1_000);
}

async function expectNoUnexpectedConsole(
  consoleErrors: ConsoleError[],
): Promise<void> {
  const unexpected = consoleErrors.filter(
    (entry) => !isAllowedConsoleError(entry.text, entry.url),
  );
  expect(unexpected).toEqual([]);
}

async function prepareClockedStatusTest(
  page: Page,
  context: BrowserContext,
  suffix: string,
  replies: StatusFixtureReply[],
): Promise<{ layerId: string; consoleErrors: ConsoleError[] }> {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.clock.install({ time: new Date("2026-08-11T09:00:00Z") });
  const { layerId } = await seedBuilder(page, suffix);
  await installStatusHarness(page, layerId, replies);
  await pauseBrowserClock(page);
  return { layerId, consoleErrors };
}

test("a late post-header ticket is released after A to B to A without resurrecting the old hook", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  const { mapAId, mapAName, mapBId, mapBName, layerId } =
    await seedBuilderPair(page);
  const lateTicket = "departure-ticket-aaaaaaaaaaaaaaaa";
  const { realmId, releaseUrl } = await installDepartureHarness(
    page,
    layerId,
    lateTicket,
  );

  const csv = await openHeaderCsv(page);
  await csv.click();
  await expect(activeNote(page, layerId)).toBeVisible();
  await expect
    .poll(async () => (await departureSnapshot(page)).bodyReadStarted)
    .toBe(true);
  const held = await departureSnapshot(page);
  expect(held.prepareCalls).toBe(1);
  expect(held.responseStatus).toBe(200);
  expect(held.bodyReleased).toBe(false);
  expect(held.prepareAborted).toBe(false);

  await navigateThroughMapsTo(page, mapBId, mapBName, realmId);
  await navigateThroughMapsTo(
    page,
    mapAId,
    mapAName,
    realmId,
    layerName,
  );
  await expect(activeNote(page, layerId)).toHaveCount(0);
  await expect(failureNote(page, layerId)).toHaveCount(0);
  expect((await departureSnapshot(page)).prepareAborted).toBe(false);

  await releaseDepartedTicketBody(page);
  await expect
    .poll(async () => (await departureSnapshot(page)).releaseUrls)
    .toEqual([releaseUrl]);
  const released = await departureSnapshot(page);
  expect(released.firstPrepareAt).not.toBeNull();
  expect(released.bodyReleasedAt).not.toBeNull();
  expect(released.prepareAborted).toBe(false);
  expect(released.bodyReleasedAt! - released.firstPrepareAt!).toBeLessThan(
    PREPARATION_TIMEOUT_MS,
  );
  await expect(activeNote(page, layerId)).toHaveCount(0);
  await expect(failureNote(page, layerId)).toHaveCount(0);

  const retryableCsv = await openHeaderCsv(page);
  await expect(retryableCsv).not.toHaveAttribute("aria-disabled", "true");
  await retryableCsv.click();
  await expect
    .poll(async () => (await departureSnapshot(page)).prepareCalls)
    .toBe(2);
  await expect(failureNote(page, layerId)).toContainText(
    "The SQL failed to parse or execute.",
  );
  await expectNoUnexpectedConsole(consoleErrors);
});

test("a valid production-hook status resets the held-observation run", async ({
  page,
  context,
}) => {
  const { layerId, consoleErrors } = await prepareClockedStatusTest(
    page,
    context,
    "reset",
    ["held", "streaming", "held", "held", "held"],
  );
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  const csv = await openHeaderCsv(page);
  await csv.click();
  await expect
    .poll(async () => (await statusSnapshot(page)).observations)
    .toEqual(["held"]);
  const download = await downloadPromise;
  expect(new URL(download.url()).searchParams.has("__ui_download")).toBe(true);

  await page.clock.runFor(STATUS_TIMEOUT_MS + STATUS_POLL_MS);
  await expect
    .poll(async () => (await statusSnapshot(page)).observations)
    .toEqual(["held", "streaming"]);
  await page.clock.runFor(STATUS_POLL_MS);
  await expect
    .poll(async () => (await statusSnapshot(page)).observations)
    .toEqual(["held", "streaming", "held"]);
  await expect(failureNote(page, layerId)).toHaveCount(0);
  await expect(activeNote(page, layerId)).toBeVisible();

  // The fourth status call is the old third held observation overall. Its
  // timeout must be only the second consecutive unconfirmed observation,
  // because the valid response reset the real hook's counter.
  await page.clock.runFor(STATUS_TIMEOUT_MS + STATUS_POLL_MS);
  await expect
    .poll(async () => (await statusSnapshot(page)).observations)
    .toEqual(["held", "streaming", "held", "held"]);
  await page.clock.runFor(STATUS_TIMEOUT_MS);
  await expect(failureNote(page, layerId)).toHaveCount(0);
  await expect(activeNote(page, layerId)).toBeVisible();

  await page.clock.runFor(STATUS_POLL_MS);
  await expect
    .poll(async () => (await statusSnapshot(page)).observations)
    .toEqual(["held", "streaming", "held", "held", "held"]);
  await expect(failureNote(page, layerId)).toHaveCount(0);

  await page.clock.runFor(STATUS_TIMEOUT_MS - 1);
  await expect(failureNote(page, layerId)).toHaveCount(0);
  await page.clock.runFor(1);
  const note = failureNote(page, layerId);
  await expect(note).toContainText(
    "The download could not be confirmed. Check your Downloads, then retry if needed.",
  );
  await expect(activeNote(page, layerId)).toHaveCount(0);
  expect((await statusSnapshot(page)).heldAborts).toBe(4);
  await expectNoUnexpectedConsole(consoleErrors);
});

test("three held production-hook observations recover at exactly 15,500 ms", async ({
  page,
  context,
}) => {
  const { layerId, consoleErrors } = await prepareClockedStatusTest(
    page,
    context,
    "boundary",
    ["held", "held", "held"],
  );
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  const csv = await openHeaderCsv(page);
  await csv.click();
  await expect
    .poll(async () => (await statusSnapshot(page)).observations)
    .toEqual(["held"]);
  const download = await downloadPromise;
  expect(new URL(download.url()).searchParams.has("__ui_download")).toBe(true);

  await page.clock.runFor(STATUS_RECOVERY_BOUNDARY_MS - 1);
  expect((await statusSnapshot(page)).observations).toEqual([
    "held",
    "held",
    "held",
  ]);
  expect((await statusSnapshot(page)).heldAborts).toBe(2);
  await expect(failureNote(page, layerId)).toHaveCount(0);
  await expect(activeNote(page, layerId)).toBeVisible();

  await page.clock.runFor(1);
  const note = failureNote(page, layerId);
  await expect(note).toContainText(
    "The download could not be confirmed. Check your Downloads, then retry if needed.",
  );
  expect((await statusSnapshot(page)).heldAborts).toBe(3);
  await expect(activeNote(page, layerId)).toHaveCount(0);
  await expectNoUnexpectedConsole(consoleErrors);
});
