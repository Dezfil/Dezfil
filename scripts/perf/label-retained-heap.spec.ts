/** Retained-heap measurement only; run from a supervising browser session.
 * Fixture strings and parsed snapshots live in Node, never the measured page.
 * Separate diagnostic arms instrument store calls; accounting arms do not.
 */
import { test, expect, type APIRequestContext, type Browser, type CDPSession, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { closeSync, openSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { inspectLabelRetainer } from "./heap-retainers.mjs";
import { pairValues, validateFilterOrder } from "./label-heap-summary.mjs";

const SCALES = [10_000, 100_000, 250_000];
const WARM = 5;
const UI_STEP = { timeout: 3_000 };
const UI_RETRY = { timeout: 60_000, intervals: [500, 1000, 2000] };
const RESPONSE_TIMEOUT = 120_000;
type Checkpoint = "beforeMount" | "mounted" | "afterRemoval" | "afterIdle" | "afterStyle";
type HeapSample = { bytes: number; ms: number };
type Wire = { kind: "request" | "response"; method: string; path: string; ms: number; status?: number; filters?: boolean };
type Retainer = ReturnType<typeof inspectLabelRetainer>;
type Build = { kind: string; layerId?: string; ms: number };
interface Arm {
  targetId: string;
  remainingId: string;
  heap: Record<Checkpoint, HeapSample>;
  events: Wire[];
  guard: { valid: boolean; reason: string | null };
  labelCounts: { mounted: string; filtered: string | null };
  retainer?: Retainer;
  afterStyleRetainer?: Retainer;
  buildTrace?: Build[];
}

async function api(request: APIRequestContext, method: string, path: string, data?: unknown) {
  const r = await request.fetch(path, { method, data });
  if (!r.ok()) throw new Error(`${method} ${path}: ${r.status()} ${await r.text()}`);
  const result = r.status() === 204 ? null : await r.json();
  await r.dispose();
  return result;
}

function csv(count: number) {
  const rows = ["label,lon,lat,riders,category,active"];
  for (let i = 0; i < count; i++) rows.push(`Point ${i},${13.2 + (i % 1000) * .0004},${52.4 + Math.floor(i / 1000) * .0004},${i % 1000},group${i % 7},${i % 2 === 0}`);
  return Buffer.from(rows.join("\n"));
}

function layerRow(page: Page, id: string) {
  return page.locator("li[data-selected]").filter({ has: page.locator(`[data-layer-select="${id}"]`) });
}

// Called inside a retry: give an opening panel time to arrive before choosing
// an explicitly unselected row. The state-qualified click cannot toggle an
// already-selected row off, even if selection changes while it is waiting.
async function showLayerPanel(row: Locator, control: Locator) {
  try {
    await expect(control).toBeVisible(UI_STEP);
  } catch {
    await expect(row).toHaveAttribute("data-selected", "false", UI_STEP);
    await row.locator(':scope[data-selected="false"] [data-layer-select]').click(UI_STEP);
    await expect(control).toBeVisible(UI_STEP);
  }
}

async function mutateViaUI(page: Page, matches: (request: Request) => boolean, interact: () => Promise<void>) {
  let sent = false;
  const observe = (request: Request) => { if (matches(request)) sent = true; };
  page.on("request", observe);
  // Arm once, before any interaction; a retry must not miss a fast response.
  const response = page.waitForResponse(r => matches(r.request()), { timeout: RESPONSE_TIMEOUT });
  try {
    const [result] = await Promise.all([
      response,
      expect(async () => {
        // A dispatched mutation awaits its real response, never a replay (in
        // particular, no duplicate layer POST or second opacity decrement).
        if (sent) return;
        await interact();
        await expect.poll(() => sent, UI_STEP).toBe(true);
      }).toPass(UI_RETRY),
    ]);
    expect(result.ok()).toBe(true);
    return result;
  } finally {
    page.off("request", observe);
  }
}

async function settled(page: Page) {
  await expect(page.getByText("Saving…", { exact: true })).toBeHidden();
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
  // Paint/attribute-upload dwell is identical in both arms. No route reload.
  await page.waitForTimeout(2000);
}

async function sample(cdp: CDPSession): Promise<HeapSample> {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const bytes = metrics.find(m => m.name === "JSHeapUsedSize")?.value;
  if (!bytes || !Number.isFinite(bytes)) throw new Error("Browser heap telemetry unavailable; not zero retention");
  return { bytes, ms: performance.now() };
}

async function snapshot(cdp: CDPSession, file: string, id: string) {
  const fd = openSync(file, "w");
  const chunk = ({ chunk }: { chunk: string }) => { writeSync(fd, chunk); };
  cdp.on("HeapProfiler.addHeapSnapshotChunk", chunk);
  try { await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false }); }
  finally { cdp.off("HeapProfiler.addHeapSnapshotChunk", chunk); closeSync(fd); }
  return inspectLabelRetainer(file, id);
}

async function instrumentStore(cdp: CDPSession, retainer: Retainer) {
  if (retainer.storeIds.length !== 1) throw new Error(`Cannot isolate label store (${retainer.storeIds.length} candidates); diagnostic inconclusive`);
  const { result } = await cdp.send("HeapProfiler.getObjectByHeapObjectId", { objectId: retainer.storeIds[0], objectGroup: "n31-diagnostic" });
  if (!result.objectId) throw new Error("Label store diagnostic handle unavailable");
  try {
    const r = await cdp.send("Runtime.callFunctionOn", {
      objectId: result.objectId,
      functionDeclaration: `function() {
        window.__n31BuildTrace = [];
        for (const kind of ['read', 'sweep']) {
          const original = this[kind];
          this[kind] = function(...args) {
            window.__n31BuildTrace.push({ kind, layerId: kind === 'read' ? args[0].id : undefined, ms: performance.now() });
            return original.apply(this, args);
          };
        }
      }`,
    });
    if (r.exceptionDetails) throw new Error("Diagnostic wrapper refused");
  } finally { await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "n31-diagnostic" }); }
}

async function runArm(browser: Browser, request: APIRequestContext, info: TestInfo, table: string, scale: number,
  repetition: number, treatment: boolean, diagnostic: boolean, skipFilter = false): Promise<Arm> {
  const armName = treatment ? "treatment" : "control";
  const prefix = `${scale}-${diagnostic ? "diagnostic" : repetition}-${armName}`;
  const map = await api(request, "POST", "/api/maps", { name: `N31 ${prefix}` });
  const remaining = await api(request, "POST", `/api/maps/${map.id}/layers`, { name: "Remaining", sql: `SELECT * FROM "${table}" LIMIT 1` });
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const events: Wire[] = [];
  page.on("request", r => {
    const path = new URL(r.url()).pathname;
    if (/^\/api\/(layers|maps)/.test(path)) events.push({ kind: "request", method: r.method(), path, ms: performance.now() });
  });
  page.on("response", r => {
    const req = r.request(), path = new URL(r.url()).pathname;
    if (!/^\/api\/(layers|maps)/.test(path)) return;
    const body = req.method() === "PATCH" ? req.postDataJSON() : null;
    events.push({ kind: "response", method: req.method(), path, status: r.status(), filters: Array.isArray(body?.filters), ms: performance.now() });
  });
  try {
    await cdp.send("HeapProfiler.enable");
    await cdp.send("Performance.enable");
    await page.goto(`/maps/${map.id}`, { waitUntil: "load" });
    const remainingRow = layerRow(page, remaining.id);
    const opacity = remainingRow.getByRole("slider", { name: "Layer opacity", exact: true });
    await expect(() => showLayerPanel(remainingRow, opacity)).toPass(UI_RETRY);
    await settled(page);
    const heap = {} as Record<Checkpoint, HeapSample>;
    const mark = async (kind: string) => {
      if (diagnostic) await page.evaluate((kind) => {
        const trace = (window as unknown as { __n31BuildTrace?: Build[] }).__n31BuildTrace;
        trace?.push({ kind, ms: performance.now() });
      }, kind);
    };
    heap.beforeMount = await sample(cdp);

    // Add via the builder after baseline so no initial mount effect can touch
    // the target store. Full loads are only at the beginning of each arm.
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add layer" });
    await dialog.getByRole("button", { name: /^Tables/ }).click();
    await dialog.getByRole("button", { name: table, exact: true }).click();
    const response = await mutateViaUI(page,
      r => r.method() === "POST" && new URL(r.url()).pathname === `/api/maps/${map.id}/layers`,
      async () => {
        await expect(dialog).toBeVisible(UI_STEP);
        const add = dialog.getByRole("button", { name: "Add layer", exact: true });
        await expect(add).toBeEnabled(UI_STEP);
        await add.click(UI_STEP);
      });
    const targetId = (await response.json()).id as string;
    await expect(dialog).toBeHidden();
    const row = layerRow(page, targetId);
    const labelSelect = row.getByRole("combobox", { name: "Label text", exact: true });
    await mutateViaUI(page,
      r => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/layers/${targetId}` && r.postDataJSON()?.style?.label?.attribute === "label",
      async () => {
        await showLayerPanel(row, labelSelect);
        await expect(labelSelect).toBeEnabled(UI_STEP);
        await labelSelect.selectOption("label", UI_STEP);
        await expect(labelSelect).toHaveValue("label", UI_STEP);
      });
    const count = page.locator("[data-count]");
    await expect(count).toContainText(`of ${scale.toLocaleString("en-US")} labels`);
    await settled(page);
    const current = await api(request, "GET", `/api/layers/${targetId}`);
    expect(current.style.label.attribute).toBe("label");
    expect(current.style.label.zoomFloor ?? null).toBeNull();
    expect(current.viz.type).not.toBe("cluster");
    const render = await api(request, "GET", `/api/layers/${targetId}/render`);
    expect(render.featureCount).toBe(scale);
    expect(render.geojson?.type).toBe("FeatureCollection");
    const labelCounts = { mounted: await count.innerText(), filtered: null as string | null };
    heap.mounted = await sample(cdp);
    if (diagnostic) await instrumentStore(cdp, await snapshot(cdp, info.outputPath(`${prefix}-mounted.heapsnapshot`), targetId));

    await mark("mounted-settled");
    if (treatment && !skipFilter) {
      await mutateViaUI(page,
        r => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/layers/${targetId}` && r.postDataJSON()?.filters?.some((f: { field: string }) => f.field === "riders"),
        async () => {
          await showLayerPanel(row, labelSelect);
          const addFilter = row.getByRole("button", { name: "+ Add filter", exact: true });
          await expect(addFilter).toBeVisible(UI_STEP);
          if ((await addFilter.getAttribute("aria-expanded", UI_STEP)) !== "true") await addFilter.click(UI_STEP);
          const riders = row.getByRole("button", { name: /riders/ }).last();
          await expect(riders).toBeVisible(UI_STEP);
          await riders.click(UI_STEP);
        });
      await mutateViaUI(page,
        r => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/layers/${targetId}` && r.postDataJSON()?.filters?.some((f: { field: string; max: number }) => f.field === "riders" && f.max === 499),
        async () => {
          const maximum = row.getByRole("spinbutton", { name: "riders maximum", exact: true });
          await showLayerPanel(row, maximum);
          await expect(maximum).toBeEditable(UI_STEP);
          await maximum.fill("499", UI_STEP);
          await maximum.blur(UI_STEP);
          await expect(maximum).toHaveValue("499", UI_STEP);
        });
      await expect(count).toContainText(`of ${(scale / 2).toLocaleString("en-US")} labels`);
      await settled(page);
      const filtered = await api(request, "GET", `/api/layers/${targetId}/render`);
      expect(filtered.liveFiltered).toBe(true);
      expect(filtered.featureCount).toBe(scale); // same inline collection, GPU window
      labelCounts.filtered = await count.innerText();
    }

    await mark("before-delete");
    await mutateViaUI(page,
      r => r.method() === "DELETE" && new URL(r.url()).pathname === `/api/layers/${targetId}`,
      async () => {
        await expect(row).toBeVisible(UI_STEP);
        const menuButton = row.getByRole("button", { name: "Layer menu", exact: true });
        await expect(menuButton).toBeVisible(UI_STEP);
        // The supervising treatment runs saw a dismissal ~40 ms after opening
        // following a live-filter edit. Reopen on retry, including if the
        // confirmation state was lost; never toggle an expanded menu closed.
        if ((await menuButton.getAttribute("aria-expanded", UI_STEP)) !== "true") await menuButton.click(UI_STEP);
        const confirm = page.getByRole("menuitem", { name: "Confirm delete", exact: true });
        if (!(await confirm.isVisible())) {
          const remove = page.getByRole("menuitem", { name: "Delete layer", exact: true });
          await expect(remove).toBeVisible(UI_STEP);
          await remove.click(UI_STEP);
        }
        await expect(confirm).toBeVisible(UI_STEP);
        await confirm.click(UI_STEP);
      });
    await expect(page.locator(`[data-layer-select="${targetId}"]`)).toHaveCount(0);
    await expect(() => showLayerPanel(remainingRow, opacity)).toPass(UI_RETRY);
    await settled(page);
    const order = validateFilterOrder(events, targetId, treatment);
    const guard = order.valid && treatment && !labelCounts.filtered
      ? { valid: false, reason: "filter label build unobserved" } : order;
    if (!skipFilter) expect(guard, "invalid run is not zero retention").toEqual({ valid: true, reason: null });
    await mark("after-removal-settled");
    heap.afterRemoval = await sample(cdp);
    const retainer = diagnostic ? await snapshot(cdp, info.outputPath(`${prefix}-removed.heapsnapshot`), targetId) : undefined;
    await page.waitForTimeout(30_000);
    heap.afterIdle = await sample(cdp);
    await mark("before-style-edit");
    await expect(opacity).toBeVisible(UI_STEP);
    const beforeStyle = await opacity.inputValue();
    await mutateViaUI(page,
      r => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/layers/${remaining.id}` && typeof r.postDataJSON()?.style?.opacity === "number" && r.postDataJSON().style.opacity !== Number(beforeStyle),
      async () => {
        await showLayerPanel(remainingRow, opacity);
        await expect(opacity).toBeEnabled(UI_STEP);
        // A detach after the preview but before blur retries only the commit.
        if ((await opacity.inputValue(UI_STEP)) === beforeStyle) await opacity.press("ArrowLeft", UI_STEP);
        await opacity.blur(UI_STEP);
        await expect(opacity).not.toHaveValue(beforeStyle, UI_STEP);
      });
    expect(await opacity.inputValue()).not.toBe(beforeStyle);
    await settled(page);
    await mark("after-style-settled");
    heap.afterStyle = await sample(cdp);
    const afterStyleRetainer = diagnostic ? await snapshot(cdp, info.outputPath(`${prefix}-swept.heapsnapshot`), targetId) : undefined;
    const buildTrace = diagnostic ? await page.evaluate(() => (window as unknown as { __n31BuildTrace: Build[] }).__n31BuildTrace) : undefined;
    return { targetId, remainingId: remaining.id, heap, events, guard, labelCounts, retainer, afterStyleRetainer, buildTrace };
  } finally {
    await context.close();
    await api(request, "DELETE", `/api/maps/${map.id}`);
  }
}

for (const scale of SCALES) test(`heap pairs at ${scale}`, async ({ browser, request }, info) => {
  test.setTimeout(1_800_000);
  const baseURL = info.project.use.baseURL;
  if (!baseURL || new URL(baseURL).port === "3000") throw new Error("Use an isolated production standalone on a non-3000 port");
  const measuredCommit = process.env.DEZFIL_MEASURED_COMMIT;
  if (!measuredCommit) throw new Error("DEZFIL_MEASURED_COMMIT must name the standalone's actual build commit");
  const tableName = `n31_${scale}_${Date.now()}`;
  const uploaded = await request.post("/api/tables", { multipart: { file: { name: `${tableName}.csv`, mimeType: "text/csv", buffer: csv(scale) } }, timeout: 120_000 });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);
  const table = (await uploaded.json()).name as string;
  await uploaded.dispose();
  const metadata = {
    measuredCommit, harnessCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseURL,
    machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, memory: os.totalmem() },
    node: process.version, browser: browser.version(), headed: true,
    cold: "First pair at this scale; fresh contexts/page loads; fixture already uploaded. Browser and server processes and OS caches may be warm from earlier scales. No OS cache eviction.",
    warm: "Five further pairs; shared browser/server processes and fixture; fresh contexts for every arm. Alternating pair order.",
    diagnostic: "Separate pair after accounting pairs; store wrappers record only call kind, layer id and timestamp; all remote handles released. Snapshots never interrupt measured idle intervals.",
    units: "JSHeapUsedSize bytes after HeapProfiler.collectGarbage; CPU JavaScript heap only, excludes GPU/native memory; timestamps monotonic ms in Node, build trace ms in page.",
  };
  for (let repetition = 0; repetition <= WARM + 1; repetition++) {
    const diagnostic = repetition === WARM + 1;
    const arms = {} as Record<"treatment" | "control", Arm>;
    const order = repetition % 2 === 0 ? [false, true] : [true, false];
    for (const treatment of order) arms[treatment ? "treatment" : "control"] = await runArm(browser, request, info, table, scale, repetition, treatment, diagnostic);
    const pair = { schema: 1, row: "label-retained-heap", kind: diagnostic ? "diagnostic" : "measurement", scale, repetition, order, metadata, arms };
    const file = info.outputPath(`pair-${scale}-${diagnostic ? "diagnostic" : repetition}.json`);
    await writeFile(file, JSON.stringify({ ...pair, values: pairValues(pair) }, null, 2) + "\n");
    console.log(JSON.stringify({ file, scale, repetition, kind: pair.kind, values: pairValues(pair) }));
  }
  // Optional named seed uses the REAL treatment road but omits the filter.
  // Run separately after the battery, so it cannot alter accounting pairs.
  if (process.env.DEZFIL_N31_SKIP_FILTER_GUARD === "1" && scale === 10_000) {
    const seed = await runArm(browser, request, info, table, scale, -1, true, false, true);
    expect(seed.guard).toEqual({ valid: false, reason: "settling filter PATCH not observed before DELETE" });
    await writeFile(info.outputPath("guard-skipped-filter.json"), JSON.stringify(seed, null, 2) + "\n");
  }
});
