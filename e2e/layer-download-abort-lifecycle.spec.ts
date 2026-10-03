// Fresh audit evidence: the production builder times out a real CSV
// preparation, its transport abort interrupts the hardened DuckDB COPY, and
// the exact partial scratch file is reclaimed without waiting for either the
// server query bound or the prepared-ticket reaper. The browser clock alone
// moves across the 90-second client boundary; every filesystem and API probe
// below stays on real host/server time.
import path from "node:path";
import { performance } from "node:perf_hooks";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import Database from "better-sqlite3";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  patchLayer,
  routeHouse,
  trackConsole,
} from "./support";

const DATA_DIR = process.env.DEZFIL_DATA_DIR;
const SCRATCH_DIR = DATA_DIR
  ? path.join(path.resolve(DATA_DIR), "tiles", "scratch")
  : null;
const runId = Date.now().toString(36);
const longLayerName = `Abort proof ${runId}`;
const PREPARATION_TIMEOUT_MS = 90_000;
const CLIENT_BOUNDARY_CROSS_MS = PREPARATION_TIMEOUT_MS + 1;
const PROMPT_CLEANUP_BOUND_MS = 10_000;
const SPARSE_SCRATCH_BOUND_BYTES = 4 * 1024 * 1024;
const EXPORT_CSV_NAME = /^export-[0-9a-f-]{36}\.csv$/;
const NETWORK_MESSAGE = "Could not reach the server. Try the download again.";

// A small leading branch makes COPY produce observable bytes promptly. The
// trillion-row tail is intentionally non-finishing, but emits only one row per
// million hashes: even a broken cancellation road remains disk-bounded until
// the server's unchanged 60-second query timeout stops it.
const LONG_SPARSE_SQL = `WITH workload(i) AS (
  SELECT i FROM range(0, 2048) AS seed(i)
  UNION ALL
  SELECT i + 2048
  FROM range(0, 1000000000000) AS scan(i)
  WHERE hash(i) % 1000000 = 0
)
SELECT i,
       ST_Point((i % 360)::DOUBLE, (i % 180)::DOUBLE) AS geometry
FROM workload`;

const FOLLOWER_SQL = `SELECT 'follower' AS name,
       ST_Point(13.405, 52.52) AS geometry`;

interface ScratchFile {
  name: string;
  path: string;
  size: number;
}

async function csvScratchFiles(): Promise<ScratchFile[]> {
  if (!SCRATCH_DIR) return [];
  let names: string[];
  try {
    names = await readdir(SCRATCH_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const files = await Promise.all(
    names.filter((name) => EXPORT_CSV_NAME.test(name)).map(async (name) => {
      const filePath = path.join(SCRATCH_DIR, name);
      try {
        return { name, path: filePath, size: (await stat(filePath)).size };
      } catch (error) {
        // A production cleanup may win between readdir and stat.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }),
  );
  return files.filter((file): file is ScratchFile => file !== null);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Fixture-only state setup. The ordinary layer-write API inspects the full
 * result to validate geometry, which would correctly time out this purposely
 * non-finishing definition before the browser could test it. Updating the one
 * already-validated row keeps the operation under proof entirely production:
 * the builder, prepare route, hardened evaluator, COPY, and cancellation are
 * all untouched and unmocked. */
function storeLongSparseSql(layerId: string): void {
  if (!DATA_DIR) throw new Error("DEZFIL_DATA_DIR is required");
  const db = new Database(
    path.join(path.resolve(DATA_DIR), "metadata.sqlite"),
  );
  try {
    db.pragma("busy_timeout = 5000");
    const changed = db
      .prepare("UPDATE layers SET sql = ?, updated_at = ? WHERE id = ?")
      .run(LONG_SPARSE_SQL, new Date().toISOString(), layerId).changes;
    if (changed !== 1) {
      throw new Error(
        `expected one stored layer for ${layerId}, changed ${changed}`,
      );
    }
  } finally {
    db.close();
  }
}

function downloadFailure(page: Page, layerId: string): Locator {
  return page.locator(`[data-layer-download-failed="${layerId}:csv"]`);
}

function activeDownload(page: Page, layerId: string): Locator {
  return page.locator(`[data-layer-download-active="${layerId}:csv"]`);
}

async function openRowCsv(page: Page): Promise<Locator> {
  const card = page
    .getByRole("listitem")
    .filter({ hasText: longLayerName })
    .first();
  await card.getByRole("button", { name: "Layer menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Export data", exact: true })
    .click();
  const csv = page.getByRole("menuitem", { name: /^CSV\b/ });
  await expect(csv).toBeVisible();
  return csv;
}

function isExactPrepare(request: Request, layerId: string): boolean {
  const url = new URL(request.url());
  return (
    request.method() === "GET" &&
    url.pathname === `/api/layers/${layerId}/export/csv` &&
    url.search === "?__ui_prepare=1"
  );
}

test("a real timed-out prepare abort reclaims its exact scratch and leaves DuckDB usable", async ({
  page,
  context,
}) => {
  test.skip(
    !DATA_DIR,
    "DEZFIL_DATA_DIR is required so the audit can observe the production " +
      "server's exact layer-export scratch file.",
  );
  test.setTimeout(180_000);

  const consoleErrors = trackConsole(page);
  // This generic house policy only stubs the third-party basemap. Every local
  // request, including the preparation under proof, continues unmodified.
  await routeHouse(context, { basemapStyleStub: true });
  await page.clock.install({ time: Date.now() });

  const baseline = new Set((await csvScratchFiles()).map((file) => file.name));
  let mapId: string | null = null;
  const observed: { exactScratch: ScratchFile | null } = {
    exactScratch: null,
  };

  try {
    await page.goto("/maps");
    mapId = await createMap(page, `Layer abort lifecycle ${runId}`);
    await addLayer(
      page,
      mapId,
      "Follower anchor",
      "SELECT 'anchor' AS name, ST_Point(13.4, 52.5) AS geometry",
    );
    const layerId = await addLayer(
      page,
      mapId,
      longLayerName,
      FOLLOWER_SQL,
    );
    await patchLayer(page, layerId, { visible: false });

    // Let the builder finish its ordinary initial render against the small,
    // validated definition. Only then install the long stored SQL: the client
    // already has the hidden layer, while the preparation route below reads
    // the fresh definition. This avoids manufacturing an unrelated sibling
    // render query and leaves the one export under proof isolated.
    const initialRender = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `/api/layers/${layerId}/render`;
    });
    await page.goto(`/maps/${mapId}`);
    const initialRenderResponse = await initialRender;
    expect(initialRenderResponse.status()).toBe(200);
    await initialRenderResponse.finished();
    const longLayer = page
      .getByRole("listitem")
      .filter({ hasText: longLayerName })
      .first();
    await expect(
      longLayer.getByRole("button", { name: "Show layer" }),
    ).toBeVisible({ timeout: 30_000 });
    storeLongSparseSql(layerId);

    let prepareAnswered = false;
    let prepareFailure: string | null = null;
    page.on("response", (response) => {
      if (isExactPrepare(response.request(), layerId)) prepareAnswered = true;
    });
    page.on("requestfailed", (request) => {
      if (isExactPrepare(request, layerId)) {
        prepareFailure = request.failure()?.errorText ?? "request failed";
      }
    });

    const prepareArrived = page.waitForRequest((request) =>
      isExactPrepare(request, layerId),
    );
    const csv = await openRowCsv(page);
    await csv.click();
    await prepareArrived;
    await expect(activeDownload(page, layerId)).toBeVisible();

    // Discover this request's file by exact baseline difference, then require
    // bytes—not mere directory entry creation—while the response is still
    // genuinely held in production COPY.
    await expect
      .poll(
        async () => {
          const candidates = (await csvScratchFiles()).filter(
            (file) => !baseline.has(file.name) && file.size > 0,
          );
          if (candidates.length === 1) observed.exactScratch = candidates[0];
          return candidates.length;
        },
        { timeout: 20_000, intervals: [25, 50, 100, 250] },
      )
      .toBe(1);
    const exactScratch = observed.exactScratch;
    expect(exactScratch).not.toBeNull();
    expect(exactScratch!.size).toBeGreaterThan(0);
    expect(exactScratch!.size).toBeLessThan(SPARSE_SCRATCH_BOUND_BYTES);
    expect(prepareAnswered).toBe(false);

    const clientBefore = await page.evaluate(() => Date.now());
    const cleanupStartedAt = performance.now();
    await page.clock.fastForward(CLIENT_BOUNDARY_CROSS_MS);
    const clientAfter = await page.evaluate(() => Date.now());
    expect(clientAfter - clientBefore).toBeGreaterThanOrEqual(
      CLIENT_BOUNDARY_CROSS_MS,
    );

    // The abort must reach the server and reclaim this exact nonzero file on
    // real time, far inside both independent 60-second server backstops.
    await expect
      .poll(() => fileExists(exactScratch!.path), {
        timeout: PROMPT_CLEANUP_BOUND_MS,
        intervals: [25, 50, 100, 250],
      })
      .toBe(false);
    const cleanupElapsedRealMs = performance.now() - cleanupStartedAt;
    expect(cleanupElapsedRealMs).toBeLessThan(PROMPT_CLEANUP_BOUND_MS);
    await expect
      .poll(() => prepareFailure, { timeout: 5_000, intervals: [25, 50, 100] })
      .toMatch(/ERR_ABORTED|aborted|cancel/i);

    const note = downloadFailure(page, layerId);
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute("role", "alert");
    await expect(note).toContainText(NETWORK_MESSAGE);
    await expect(
      note.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();
    await expect(
      note.getByRole("button", { name: "Dismiss", exact: true }),
    ).toBeVisible();
    await expect(activeDownload(page, layerId)).toHaveCount(0);

    // A SQL-changing write exercises the same hardened query instance after
    // interruption. Its server-authored timestamp stays near the host's real
    // clock and therefore about 90 seconds behind the page-only fake clock.
    const follower = await page.evaluate(
      async ({ id, sql }) => {
        const response = await (async function readThenWriteSetup() {
const read = await fetch(`/api/layers/${id}`, { cache: "no-store" });
if (!read.ok) throw new Error(await read.text());
const shown = await read.json();
return fetch(`/api/layers/${id}`, {
          method: "PATCH",
          headers: { "X-Edit-Revision": shown.editRevision, "content-type": "application/json" },
          body: JSON.stringify({ sql }),
        });
})();
        return {
          status: response.status,
          body: (await response.json()) as {
            sql?: string;
            updatedAt?: string;
            error?: unknown;
          },
        };
      },
      { id: layerId, sql: FOLLOWER_SQL },
    );
    expect(follower.status, JSON.stringify(follower.body.error)).toBe(200);
    expect(follower.body.sql).toBe(FOLLOWER_SQL);
    const serverUpdatedAt = Date.parse(follower.body.updatedAt ?? "");
    expect(Number.isFinite(serverUpdatedAt)).toBe(true);
    expect(Math.abs(Date.now() - serverUpdatedAt)).toBeLessThan(10_000);
    expect(
      (await page.evaluate(() => Date.now())) - serverUpdatedAt,
    ).toBeGreaterThan(PREPARATION_TIMEOUT_MS - 5_000);

    // The recovery's own Retry is the follower action: it prepares and
    // redeems a fresh native attachment with bytes from the new real query.
    const downloadArrived = page.waitForEvent("download", { timeout: 30_000 });
    await note.getByRole("button", { name: "Retry", exact: true }).click();
    const download = await downloadArrived;
    expect(download.url()).not.toMatch(/^blob:/);
    expect(new URL(download.url()).searchParams.has("__ui_download")).toBe(
      true,
    );
    expect(download.suggestedFilename()).toBe(`${longLayerName}.csv`);
    const savedPath = await download.path();
    if (!savedPath) {
      throw new Error("native follower download has no saved file");
    }
    const saved = await readFile(savedPath, "utf8");
    expect(saved).toContain("follower");
    expect(saved).toContain("POINT");
    await expect(note).toHaveCount(0);
    await expect(activeDownload(page, layerId)).toHaveCount(0);

    await expect
      .poll(
        async () =>
          (await csvScratchFiles()).filter((file) => !baseline.has(file.name))
            .length,
        { timeout: 5_000, intervals: [25, 50, 100, 250] },
      )
      .toBe(0);

    const prepareUrl = new RegExp(
      `/api/layers/${layerId}/export/csv\\?__ui_prepare=1`,
    );
    const unexpected = consoleErrors.filter(
      (entry) =>
        !prepareUrl.test(entry.url ?? entry.text) &&
        !isAllowedConsoleError(entry.text, entry.url),
    );
    expect(unexpected).toEqual([]);
  } finally {
    // Departure is the independent fail-safe if an assertion stops the test
    // before the fake deadline. Never leave the long writer or its exact
    // artifact behind, even on a red run.
    await page.goto("/maps", { waitUntil: "commit", timeout: 10_000 }).catch(
      () => undefined,
    );
    const exactScratch = observed.exactScratch;
    if (exactScratch && (await fileExists(exactScratch.path))) {
      await expect
        .poll(() => fileExists(exactScratch!.path), {
          timeout: PROMPT_CLEANUP_BOUND_MS,
          intervals: [50, 100, 250],
        })
        .toBe(false)
        .catch(() => undefined);
      if (await fileExists(exactScratch.path)) {
        await rm(exactScratch.path, { force: true }).catch(() => undefined);
      }
    }
    // If the proof stopped before the exact file was identified, the baseline
    // still scopes cleanup to artifacts this serial test introduced.
    await expect
      .poll(
        async () =>
          (await csvScratchFiles()).filter((file) => !baseline.has(file.name))
            .length,
        { timeout: PROMPT_CLEANUP_BOUND_MS, intervals: [50, 100, 250] },
      )
      .toBe(0)
      .catch(() => undefined);
    for (const file of (await csvScratchFiles()).filter(
      (candidate) => !baseline.has(candidate.name),
    )) {
      await rm(file.path, { force: true }).catch(() => undefined);
    }
    if (mapId) {
      await page
        .evaluate(async (id) => {
          await (async function readThenWriteSetup() { const basis = await (await fetch(`/api/maps/${id}`)).json(); return fetch(`/api/maps/${id}`, { headers: { "X-Edit-Revision": basis.editRevision }, method: "DELETE" }); })();
        }, mapId)
        .catch(() => undefined);
    }
  }
});
