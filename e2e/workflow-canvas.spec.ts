import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
import { test, expect, type Page, type Request } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { seedCsv, trackConsole } from "./support";

/**
 * The canvas, reading: the browser flow for what the API says and the
 * canvas draws — opening writes nothing, placement, saves on a completed
 * move and on Arrange with the whisper's Retry, the edge and state
 * fixtures, the stage, the minimap, the pane, each read's failure, true
 * emptiness, and forty nodes. Every fixture is authored through the API
 * so the page renders what it is told.
 */

const runId = Date.now().toString(36);
const table = `cv_stations_${runId}`;
const other = `cv_cafes_${runId}`;

type Json = Record<string, unknown>;

async function api(page: Page, method: string, path: string, body?: unknown, basis?: EditBasis): Promise<Json> {
  return page.evaluate(
    async ({ method, path, body, basis }) => {
      const r = await fetch(path, {
        method,
        headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text}`);
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    },
    { method, path, body, basis },
  );
}

async function newRecipe(page: Page, name: string, origin?: "builder"): Promise<string> {
  const made = await api(page, "POST", "/api/recipes", origin ? { name, origin } : { name });
  return (made.recipe as { id: string }).id;
}

async function addSql(page: Page, id: string, sql: string, name: string): Promise<string> {
  const added = await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/steps`, body: { operation: "sql_step", parameters: { sql, name } } })).then(result => result.json);
  return (added.step as { id: string }).id;
}

async function readLayout(page: Page, id: string): Promise<Json> {
  return (await api(page, "GET", `/api/recipes/${id}/layout`)).layout as Json;
}

async function readRecipe(page: Page, id: string): Promise<Json> {
  return (await api(page, "GET", `/api/recipes/${id}`)).recipe as Json;
}

/** Every layout write the page makes, by URL. */
function watchWrites(page: Page): Request[] {
  const writes: Request[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && /\/api\//.test(r.url())) writes.push(r);
  });
  return writes;
}

async function settled(page: Page) {
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  // The library measures, then fits: give the first fit its frame.
  await page.waitForTimeout(400);
}

const nodes = (page: Page) => page.locator("[data-node]");
const edges = (page: Page) => page.locator(".react-flow__edge");
const member = (page: Page, text: string) => page.locator("[data-node]").filter({ hasText: text }).first();
const viewportTransform = (page: Page) =>
  page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);

async function dragBy(page: Page, target: ReturnType<typeof member>, dx: number, dy: number) {
  const box = await target.locator("[data-v='badge']").boundingBox();
  if (!box) throw new Error("no tile to drag");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + (dx * i) / 6, y + (dy * i) / 6);
  await page.mouse.up();
}

test("opening writes nothing, then moves and Arrange write the layout; the failure arm and Retry", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await page.goto("/workflows");
  await seedCsv(page, table, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  const id = await newRecipe(page, `Chain ${runId}`);
  const one = await addSql(page, id, `SELECT name FROM ${table}`, `${table}_one`);
  const two = await addSql(page, id, `SELECT count(*) AS n FROM ${table}_one`, `${table}_two`);
  const writes = watchWrites(page);

  await test.step("a never-arranged chain opens arranged by dependency, and nothing is written", async () => {
    const recipeBefore = await readRecipe(page, id);
    const layoutBefore = await readLayout(page, id);
    expect(layoutBefore.updatedAt).toBeNull();
    await page.goto(`/workflows/${id}`);
    await settled(page);
    await expect(nodes(page)).toHaveCount(3);
    await expect(edges(page)).toHaveCount(2);
    const xs = await Promise.all(
      [table, `${table}_one`, `${table}_two`].map(async (t) => (await member(page, t).boundingBox())!.x),
    );
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(writes.filter((r) => /\/layout$/.test(r.url()))).toEqual([]);
    expect(await readLayout(page, id)).toEqual(layoutBefore);
    expect(await readRecipe(page, id)).toEqual(recipeBefore);
  });

  await test.step("a builder-made recipe opens the same way", async () => {
    const built = await newRecipe(page, `Built ${runId}`, "builder");
    await addSql(page, built, `SELECT name FROM ${table}`, `${table}_built`);
    await page.goto(`/workflows/${built}`);
    await settled(page);
    await expect(nodes(page)).toHaveCount(2);
    expect((await readLayout(page, built)).updatedAt).toBeNull();
  });

  await test.step("a written layout places what it names; the rest goes beside the graph, without a write", async () => {
    await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "PUT", path: `/api/recipes/${id}/layout`, body: {
      steps: { [one]: { x: 600, y: 400 } },
      sources: { [table]: { x: 100, y: 400 } },
      notes: [{ id: "n1", x: 0, y: 0, w: 200, h: 100, color: "yellow", text: "kept" }],
    } })).then(result => result.json);
    const before = await readLayout(page, id);
    const seen = writes.length;
    await page.goto(`/workflows/${id}`);
    await settled(page);
    const oneBox = (await member(page, `${table}_one`).boundingBox())!;
    const twoBox = (await member(page, `${table}_two`).boundingBox())!;
    // The unplaced node stands beside the graph: to the right of the placed one.
    expect(twoBox.x).toBeGreaterThan(oneBox.x + 100);
    expect(writes.slice(seen).filter((r) => /\/layout$/.test(r.url()))).toEqual([]);
    expect(await readLayout(page, id)).toEqual(before);
  });

  await test.step("moving one node writes its position and keeps the others and the notes (e)", async () => {
    const recipeBefore = await readRecipe(page, id);
    await dragBy(page, member(page, `${table}_two`), 160, 0);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const after = await readLayout(page, id);
    const steps = after.steps as Record<string, { x: number; y: number }>;
    expect(steps[one]).toEqual({ x: 600, y: 400 });
    expect(steps[two]).toBeDefined();
    expect((after.sources as Record<string, unknown>)[table]).toEqual({ x: 100, y: 400 });
    expect(after.notes).toEqual([{ id: "n1", x: 0, y: 0, w: 200, h: 100, color: "yellow", text: "kept" }]);
    const recipeAfter = await readRecipe(page, id);
    expect(recipeAfter.steps).toEqual(recipeBefore.steps);
    expect(String(recipeAfter.updatedAt) > String(recipeBefore.updatedAt)).toBe(true);
  });

  await test.step("Arrange moves every member, keeps the notes, fits, and reopening finds it", async () => {
    const before = await readLayout(page, id);
    await page.getByRole("button", { name: "Arrange by dependency" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const after = await readLayout(page, id);
    expect(after.notes).toEqual(before.notes);
    const steps = after.steps as Record<string, { x: number; y: number }>;
    const sources = after.sources as Record<string, { x: number; y: number }>;
    expect(sources[table]).not.toEqual({ x: 100, y: 400 });
    expect(steps[one].x).toBeGreaterThan(sources[table].x);
    expect(steps[two].x).toBeGreaterThan(steps[one].x);
    await page.reload();
    await settled(page);
    const xs = await Promise.all(
      [table, `${table}_one`, `${table}_two`].map(async (t) => (await member(page, t).boundingBox())!.x),
    );
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
  });

  await test.step("reduced motion suppresses Arrange's animation", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Arrange by dependency" }).click();
    expect(await page.locator("[data-workflow-canvas][data-animating]").count()).toBe(0);
    await page.emulateMedia({ reducedMotion: null });
  });

  await test.step("a failed save keeps the arrangement and Retry writes it", async () => {
    await page.route("**/api/recipes/*/layout", (route) =>
      route.request().method() === "PUT" ? route.abort() : route.continue(),
    );
    const beforeBox = (await member(page, `${table}_two`).boundingBox())!;
    await dragBy(page, member(page, `${table}_two`), 0, 120);
    await expect(page.getByText("Couldn’t save")).toBeVisible();
    const retry = page.getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible();
    const held = (await member(page, `${table}_two`).boundingBox())!;
    expect(held.y).toBeGreaterThan(beforeBox.y + 60);
    await page.unroute("**/api/recipes/*/layout");
    await retry.click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const after = (await readLayout(page, id)).steps as Record<string, { x: number; y: number }>;
    expect(after[two].y).toBeGreaterThan(after[one].y);
  });

  // The failure arm aborted a layout write on purpose; the browser logs
  // that abort as a resource failure. Everything else must be clean.
  const induced = (e: { text: string; url?: string }) =>
    /\/api\/recipes\/[^/]+\/layout$/.test(e.url ?? "") && /ERR_FAILED/.test(e.text);
  expect(consoleErrors.filter((e) => !induced(e) && !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});

test("edges, states, the stage, the minimap, the pane, failures, emptiness and forty nodes", async ({ page }) => {
  test.setTimeout(360_000);
  const consoleErrors = trackConsole(page);
  await page.goto("/workflows");
  await seedCsv(page, table, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  await seedCsv(page, other, "name,stars\nkaffee,4\n");
  const writes = watchWrites(page);

  await test.step("a named-input node's edges enter labelled ports, two ports from one table are two edges; the SQL node has none (b, c)", async () => {
    const id = await newRecipe(page, `Ports ${runId}`);
    await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/steps`, body: {
      operation: "join_by_key",
      parameters: { left: table, right: table, left_key: "name", right_key: "name", name: `${table}_self` },
    } })).then(result => result.json);
    await addSql(page, id, `SELECT * FROM ${table}_self`, `${table}_sql`);
    await page.goto(`/workflows/${id}`);
    await settled(page);
    await expect(nodes(page)).toHaveCount(3);
    await expect(edges(page)).toHaveCount(3);
    const join = member(page, `${table}_self`);
    await expect(join.getByLabel(/^Rows to enrich/)).toHaveCount(1);
    await expect(join.getByLabel(/^Rows to take values from/)).toHaveCount(1);
    const sql = member(page, `${table}_sql`);
    await expect(sql.getByLabel("Reads what its query names")).toHaveCount(1);
    expect(await sql.locator(".react-flow__handle").count()).toBe(2);
  });

  await test.step("a missing source is drawn missing with a broken edge and its reader cannot run; states wear their badges", async () => {
    const gone = `cv_gone_${runId}`;
    await seedCsv(page, gone, "name\nx\n");
    const id = await newRecipe(page, `States ${runId}`);
    await addSql(page, id, `SELECT name FROM ${gone}`, `${gone}_reader`);
    const failing = await addSql(page, id, `SELECT nope FROM ${table}`, `${table}_failing`);
    // The tables route is keyed by name.
    await api(page, "DELETE", `/api/tables/${gone}`);
    // The failing node runs and fails; the reader cannot run.
    await api(page, "POST", `/api/recipes/${id}/steps/${failing}/run`);
    await expect
      .poll(async () => ((await readRecipe(page, id)).steps as Json[])[1].latestAttempt, { timeout: 30_000 })
      .toMatchObject({ state: "failed" });
    await page.goto(`/workflows/${id}`);
    await settled(page);
    const src = member(page, gone);
    await expect(src).toHaveAttribute("data-missing", "true");
    await expect(src).toContainText("missing");
    await expect(page.locator(".react-flow__edge g[data-broken]")).toHaveCount(1);
    await expect(member(page, `${gone}_reader`)).toHaveAttribute("data-state", "cannot run");
    await expect(member(page, `${table}_failing`)).toHaveAttribute("data-state", "run failed");
    await expect(page.getByRole("group", { name: /cannot run/ }).first()).toBeVisible();
  });

  await test.step("the stage: zoom changes the scale, fit contains, the view toggles; far zoom drops the secondary text (c)", async () => {
    const id = await newRecipe(page, `Stage ${runId}`);
    await addSql(page, id, `SELECT name FROM ${table}`, `${table}_stage`);
    await page.goto(`/workflows/${id}`);
    await settled(page);
    // The zoom readout under the stack was removed on a field-round
    // ruling; the scale is the viewport's own.
    await expect(page.locator("[data-zoom-readout]")).toHaveCount(0);
    const t0 = await viewportTransform(page);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(() => viewportTransform(page)).not.toBe(t0);
    await page.getByRole("button", { name: "Framed view" }).click();
    await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-view", "framed");
    await page.getByRole("button", { name: "Fill the screen" }).click();
    await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-view", "full");
    for (let i = 0; i < 6; i++) await page.getByRole("button", { name: "Zoom out" }).click();
    await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-lod", "far");
    const out = member(page, `${table}_stage`).locator("[class*='tOut']").first();
    expect(await out.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
    await expect(member(page, `${table}_stage`).locator("[class*='tName']")).toBeVisible();
    await page.getByRole("button", { name: "Fit to view" }).click();
    await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-lod", "near");
  });

  await test.step("the minimap is absent at five members and present at six, and moves the view", async () => {
    const five = await newRecipe(page, `Five ${runId}`);
    // One source and four nodes: five members.
    let prev = table;
    for (let i = 0; i < 4; i++) {
      const name = `${table}_f${i}`;
      await addSql(page, five, `SELECT * FROM ${prev}`, name);
      prev = name;
    }
    await page.goto(`/workflows/${five}`);
    await settled(page);
    await expect(nodes(page)).toHaveCount(5);
    await expect(page.locator("[data-minimap]")).toHaveCount(0);
    await addSql(page, five, `SELECT * FROM ${other}`, `${table}_f4`);
    await page.reload();
    await settled(page);
    await expect(nodes(page)).toHaveCount(7);
    const minimap = page.locator("[data-minimap]");
    await expect(minimap).toBeVisible();
    const t0 = await viewportTransform(page);
    const box = (await minimap.boundingBox())!;
    await page.mouse.click(box.x + 10, box.y + 10);
    expect(await viewportTransform(page)).not.toBe(t0);
  });

  await test.step("the stack's toggle hides the minimap and shows it again; hidden is remembered across a reload (word after)", async () => {
    const toggle = page.locator("[data-canvas-stage] [data-minimap-toggle]");
    await expect(toggle).toHaveAttribute("aria-label", "Hide minimap");
    await toggle.click();
    await expect(page.locator("[data-minimap]")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-label", "Show minimap");
    await page.reload();
    await settled(page);
    await expect(page.locator("[data-minimap]")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-label", "Show minimap");
    await toggle.click();
    await expect(page.locator("[data-minimap]")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-label", "Hide minimap");
  });

  await test.step("under six members the button still does what it says: Show draws the map, and a choice holds in every workflow (2026-08-30)", async () => {
    const toggle = page.locator("[data-canvas-stage] [data-minimap-toggle]");
    // A two-member workflow: the choice made above ("shown") holds there.
    const small = await newRecipe(page, `Small ${runId}`);
    await addSql(page, small, `SELECT * FROM ${table}`, `${table}_small`);
    await page.goto(`/workflows/${small}`);
    await settled(page);
    await expect(nodes(page)).toHaveCount(2);
    await expect(page.locator("[data-minimap]")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-label", "Hide minimap");
    await toggle.click();
    await expect(page.locator("[data-minimap]")).toHaveCount(0);
    // With no choice ever made, the six-member rule decides, and the
    // button offers Show, which shows.
    await page.evaluate(() => localStorage.removeItem("dezfil.workflow.minimap"));
    await page.reload();
    await settled(page);
    await expect(page.locator("[data-minimap]")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-label", "Show minimap");
    await toggle.click();
    await expect(page.locator("[data-minimap]")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-label", "Hide minimap");
    await page.reload();
    await settled(page);
    await expect(page.locator("[data-minimap]")).toBeVisible();
    // Back to the rule for the steps that follow.
    await page.evaluate(() => localStorage.removeItem("dezfil.workflow.minimap"));
  });

  await test.step("keyboard: a node and a source select and move by keys, and the move saves", async () => {
    const id = await newRecipe(page, `Keys ${runId}`);
    await addSql(page, id, `SELECT name FROM ${table}`, `${table}_keys`);
    await page.goto(`/workflows/${id}`);
    await settled(page);
    for (const text of [`${table}_keys`, table]) {
      const target = page.locator(".react-flow__node").filter({ hasText: text }).first();
      await target.focus();
      await page.keyboard.press("Enter");
      const before = (await target.boundingBox())!;
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect.poll(async () => (await target.boundingBox())!.x).toBeGreaterThan(before.x);
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    const layout = await readLayout(page, id);
    expect(Object.keys(layout.steps as object)).toHaveLength(1);
    expect(Object.keys(layout.sources as object)).toEqual([table]);
  });

  await test.step("the pane: Sources in two groups without this workflow's outputs, on-canvas rows centre; Tools lists the catalog; searches filter; nothing writes", async () => {
    // Another workflow's output is a Tool output here; this workflow's own
    // live output is not listed at all.
    const elsewhere = await newRecipe(page, `Elsewhere ${runId}`);
    const theirs = await addSql(page, elsewhere, `SELECT name FROM ${table}`, `${table}_theirs`);
    await api(page, "POST", `/api/recipes/${elsewhere}/steps/${theirs}/run`);
    const id = await newRecipe(page, `Pane ${runId}`);
    const step = await addSql(page, id, `SELECT name FROM ${table}`, `${table}_pane`);
    await api(page, "POST", `/api/recipes/${id}/steps/${step}/run`);
    for (const r of [elsewhere, id]) {
      await expect
        .poll(async () => ((await readRecipe(page, r)).steps as Json[])[0].output, { timeout: 30_000 })
        .not.toBeNull();
    }
    await page.goto(`/workflows/${id}`);
    await settled(page);
    const pane = page.locator("[data-canvas-pane]");
    await expect(pane.getByText("Workspace tables")).toBeVisible();
    await expect(pane.getByText("Tool outputs")).toBeVisible();
    await expect(pane.locator(`[data-table="${table}_theirs"]`)).toHaveCount(1);
    await expect(pane.locator(`[data-table="${table}_pane"]`)).toHaveCount(0);
    const onCanvas = pane.getByRole("button", { name: `${table}, on canvas: centre the view on it` });
    await expect(onCanvas).toBeVisible();
    await page.getByRole("button", { name: "Zoom in" }).click();
    const t0 = await viewportTransform(page);
    await onCanvas.click();
    await expect.poll(() => viewportTransform(page)).not.toBe(t0);
    await pane.getByRole("searchbox", { name: "Search sources" }).fill(other);
    await expect(pane.locator(`[data-table="${other}"]`)).toHaveCount(1);
    await expect(pane.locator(`[data-table="${table}"]`)).toHaveCount(0);
    await pane.getByRole("tab", { name: /^Tools/ }).click();
    const catalog = (await api(page, "GET", "/api/operations")).operations as Json[];
    await expect(pane.locator("[data-tool]")).toHaveCount(catalog.length);
    const unavailable = catalog.find((o) => (o.availability as Json | undefined)?.available === false);
    if (unavailable) {
      await expect(pane.locator(`[data-tool="${unavailable.id}"]`)).toContainText(
        String((unavailable.availability as Json).reason).slice(0, 20),
      );
    }
    await pane.getByRole("searchbox", { name: "Search tools" }).fill("buffer");
    await expect(pane.locator("[data-tool]")).toHaveCount(1);
    const seen = writes.length;
    await pane.getByRole("tab", { name: /^Sources/ }).click();
    expect(writes.slice(seen)).toEqual([]);
  });

  await test.step("each read can fail: the page fails with Retry, writes nothing, and Retry reaches content", async () => {
    const id = await newRecipe(page, `Fails ${runId}`);
    await addSql(page, id, `SELECT name FROM ${table}`, `${table}_fails`);
    for (const pattern of [`**/api/recipes/${id}`, `**/api/recipes/${id}/layout`, "**/api/tables", "**/api/operations"]) {
      await page.route(pattern, (route) => (route.request().method() === "GET" ? route.abort() : route.continue()));
      const seen = writes.length;
      await page.goto(`/workflows/${id}`);
      const retry = page.getByRole("button", { name: "Try again" });
      await expect(retry).toBeVisible();
      await expect(page.locator("[data-workflow-canvas]")).toHaveCount(0);
      expect(writes.slice(seen)).toEqual([]);
      await page.unroute(pattern);
      await retry.click();
      await settled(page);
      await expect(nodes(page)).toHaveCount(2);
    }
  });

  await test.step("a recipe without nodes shows the empty state, unless its layout positions a loose table", async () => {
    const bare = await newRecipe(page, `Bare ${runId}`);
    await page.goto(`/workflows/${bare}`);
    await settled(page);
    await expect(page.getByText("No nodes yet")).toBeVisible();
    await expect(nodes(page)).toHaveCount(0);
    await readThenWriteBrowserSetup(page, `/api/recipes/${bare}`, () => ({ method: "PUT", path: `/api/recipes/${bare}/layout`, body: { sources: { [other]: { x: 40, y: 40 } } } })).then(result => result.json);
    await page.reload();
    await settled(page);
    await expect(page.getByText("No nodes yet")).toHaveCount(0);
    await expect(member(page, other)).toHaveAttribute("data-loose", "true");
  });

  await test.step("forty nodes open, fit, and navigate", async () => {
    const big = await newRecipe(page, `Forty ${runId}`);
    await page.evaluate(
      async ({ big, table }) => {
        let prev = table;
        for (let i = 0; i < 40; i++) {
          const name = `${table}_n${i}`;
          const r = await (async function readThenWriteWorkflowSetup() { const basis = await (await fetch(`/api/recipes/${big}`)).json(); return fetch(`/api/recipes/${big}/steps`, {
            method: "POST",
            headers: { "X-Edit-Revision": basis.editRevision, "content-type": "application/json" },
            body: JSON.stringify({ operation: "sql_step", parameters: { sql: `SELECT * FROM ${prev}`, name } }),
          }); })();
          if (!r.ok) throw new Error(await r.text());
          prev = i % 5 === 4 ? table : name;
        }
      },
      { big, table },
    );
    await page.goto(`/workflows/${big}`);
    await settled(page);
    await expect(nodes(page)).toHaveCount(41);
    await expect(page.locator("[data-minimap]")).toBeVisible();
    await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-lod", "far");
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Fit to view" }).click();
  });

  // The failure arms aborted four reads on purpose; the browser logs each
  // abort as a resource failure. Everything else must be clean.
  const induced = (e: { text: string; url?: string }) =>
    /\/api\/(recipes\/[^/]+(\/layout)?|tables|operations)$/.test(e.url ?? "") && /ERR_FAILED/.test(e.text);
  expect(consoleErrors.filter((e) => !induced(e) && !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});
