import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { seedCsv, trackConsole } from "./support";

/**
 * Runs on the canvas: Run all with its confirmation, the run's states
 * across the tiles and the dock, the outcome line, a node's own run, Run
 * from here, the diamond's failed and not-run members, cancel on a slow
 * statement, a run found in flight on open and across a reload, the
 * unsettled member read-only, the refusals, the results band and its
 * Messages log. The oracle for every state is the API's own answer — the
 * run record, the recipe read, the runs list — captured independently.
 */

const runId = Date.now().toString(36);
const stations = `rn_stations_${runId}`;

type Json = Record<string, unknown>;
type Member = { stepId: string; state: string; name: string | null; stoppedBy: string | null; attempt: { state: string; error: { message: string } | null } | null };
type Run = { id: string; kind: string; outcome: string | null; members: Member[]; startedAt: string; finishedAt: string | null };

// The engine's own endless statement (its cascade tests hold the lane with it).
const ENDLESS = "SELECT count(*) AS n FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3";

async function api(page: Page, method: string, path: string, body?: unknown, basis?: EditBasis): Promise<{ status: number; json: Json }> {
  return page.evaluate(
    async ({ method, path, body, basis }) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    },
    { method, path, body, basis },
  );
}
const ok = async (page: Page, method: string, path: string, body?: unknown, basis?: EditBasis): Promise<Json> => {
  const r = await api(page, method, path, body, basis);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json;
};
// A failed step must not leave a slow run holding the lane for the tests
// that follow: every recipe made here has its run in flight cancelled after.
const made: string[] = [];
const newRecipe = async (page: Page, name: string) => {
  const id = ((await ok(page, "POST", "/api/recipes", { name })).recipe as { id: string }).id;
  made.push(id);
  return id;
};
const addSql = async (page: Page, id: string, sql: string, name: string) =>
  ((await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/steps`, body: { operation: "sql_step", parameters: { sql, name } } })).then(result => result.json)).step as { id: string }).id;
const readRecipe = async (page: Page, id: string) => (await ok(page, "GET", `/api/recipes/${id}`)).recipe as Json & { steps: (Json & { id: string; conditions: string[]; proposedParameters: Json | null; output: Json | null })[] };
const listRuns = async (page: Page, id: string) => (await ok(page, "GET", `/api/recipes/${id}/runs`)).runs as Run[];
const readRun = async (page: Page, id: string, run: string) => (await ok(page, "GET", `/api/recipes/${id}/runs/${run}`)).run as Run;

async function settled(page: Page) {
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  await page.waitForTimeout(400);
}
const member = (page: Page, name: string) => page.locator(`[data-node][data-name="${name}"]`).first();
const tileOf = (m: Locator) => m.locator("[data-v]").first();
const panel = (page: Page) => page.locator("[data-node-panel]");
const dock = (page: Page) => page.locator("[data-run-dock]");
const runAll = (page: Page) => page.locator("[data-run-action='run-all']");
const cancelBtn = (page: Page) => page.locator("[data-run-action='cancel']");
const confirmDialog = (page: Page) => page.locator("[data-run-confirm]");
const band = (page: Page) => page.locator("[data-results-band]");
async function selectTile(page: Page, name: string) {
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Fit to view" }).click();
  await page.waitForTimeout(350);
  await tileOf(member(page, name)).click();
}
test.afterEach(async ({ page }) => {
  for (const id of made.splice(0)) {
    const runs = await api(page, "GET", `/api/recipes/${id}/runs`);
    for (const run of ((runs.json.runs as Run[] | undefined) ?? []).filter((r) => r.outcome === null)) {
      await api(page, "POST", `/api/recipes/${id}/runs/${run.id}/cancel`);
    }
  }
});

async function seed(page: Page) {
  await page.goto("/workflows");
  await seedCsv(page, stations, "name,riders,lon,lat\nalex,10450,13.4133,52.5219\nhbf,22310,13.3696,52.5251\nzoo,9000,13.3327,52.5072\n");
}

test("Run all: the confirmation, the run across the tiles and the dock, the outcome, the band and its log; a node's own run; Run from here", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await seed(page);
  const id = await newRecipe(page, `Runs ${runId}`);
  const a = await addSql(page, id, `SELECT name FROM ${stations}`, `${stations}_a`);
  const b = await addSql(page, id, `SELECT * FROM ${stations}_a`, `${stations}_b`);
  const c = await addSql(page, id, `SELECT * FROM ${stations}_b`, `${stations}_c`);
  await page.goto(`/workflows/${id}`);
  await settled(page);

  await test.step("the band starts collapsed and the log is empty before any run", async () => {
    await expect(band(page)).toHaveAttribute("data-collapsed", "true");
    await expect(band(page).locator("[data-band-count]")).toHaveText("0");
  });

  await test.step("a click anywhere on the collapsed bar opens the band; the top edge dragged down collapses it and dragged up opens it, there is no chevron; open, the bar's empty area is inert", async () => {
    // The bar's empty area: between the tabs and the placeholder.
    const emptyPoint = async () => {
      const tabs = (await band(page).locator("[role='tablist']").boundingBox())!;
      const lead = (await band(page).locator("[data-band-lead]").boundingBox())!;
      return { x: (tabs.x + tabs.width + lead.x) / 2, y: lead.y + lead.height / 2 };
    };
    // The separator dragged by the pointer: down past the collapse line
    // leaves the band on its bar, up from the bar opens it (on: "drag it
    // completely downwards to collapse").
    const dragSeparator = async (dy: number) => {
      const sep = (await band(page).locator("[data-band-separator]").boundingBox())!;
      const x = sep.x + sep.width / 2, y = sep.y + sep.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + dy / 2, { steps: 4 });
      await page.mouse.move(x, y + dy, { steps: 4 });
      await page.mouse.up();
    };
    // There is no chevron any more (the field round's word).
    await expect(band(page).locator("[data-band-toggle]")).toHaveCount(0);
    let at = await emptyPoint();
    await page.mouse.click(at.x, at.y);
    await expect(band(page)).not.toHaveAttribute("data-collapsed", "true");
    // The default height, never a remembered one.
    expect(await band(page).locator("[data-band-card]").evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(250);
    await dragSeparator(400);
    await expect(band(page)).toHaveAttribute("data-collapsed", "true");
    await dragSeparator(-160);
    await expect(band(page)).not.toHaveAttribute("data-collapsed", "true");
    await dragSeparator(400);
    await expect(band(page)).toHaveAttribute("data-collapsed", "true");
    await band(page).locator("[data-band-lead]").click();
    await expect(band(page)).not.toHaveAttribute("data-collapsed", "true");
    await band(page).locator("[data-band-separator]").focus();
    await page.keyboard.press("Home");
    await expect(band(page)).toHaveAttribute("data-collapsed", "true");
    // With nothing selected the Data tab is unavailable: a dead spot no more.
    const data = band(page).locator("[data-band-tab='data']");
    await expect(data).toBeDisabled();
    await data.click({ force: true });
    await expect(band(page)).not.toHaveAttribute("data-collapsed", "true");
    await expect(band(page)).toHaveAttribute("data-band-shown", "messages");
    // Open, the empty area does nothing: the tabs are the bar's controls.
    at = await emptyPoint();
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(200);
    await expect(band(page)).not.toHaveAttribute("data-collapsed", "true");
    await band(page).locator("[data-band-separator]").focus();
    await page.keyboard.press("Home");
    await expect(band(page)).toHaveAttribute("data-collapsed", "true");
  });

  await test.step("Run all asks once, listing the three in the API's order with their datasets; dismissing starts nothing", async () => {
    const recipeBefore = await readRecipe(page, id);
    await runAll(page).click();
    const dialog = confirmDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-plan-kind", "run_all");
    const rows = dialog.locator("[data-plan-list] li");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator("code")).toHaveText(`${stations}_a`);
    await expect(rows.nth(2).locator("code")).toHaveText(`${stations}_c`);
    await dialog.locator("[data-cancel-run]").click();
    await expect(dialog).toHaveCount(0);
    expect(await listRuns(page, id)).toEqual([]);
    expect((await readRecipe(page, id)).steps).toEqual(recipeBefore.steps);
  });

  await test.step("confirming starts exactly the three, the tiles wear the record's words, the dock counts, the outcome line stays", async () => {
    await runAll(page).click();
    await confirmDialog(page).locator("[data-confirm-run]").click();
    await expect.poll(async () => (await listRuns(page, id)).length).toBe(1);
    const run = (await listRuns(page, id))[0];
    expect(run.members.map((m) => m.stepId)).toEqual([a, b, c]);
    // The run ends: the outcome line names it and stays; every tile wears the recipe's state.
    await expect(dock(page)).toHaveAttribute("data-run-dock", "ended", { timeout: 60_000 });
    await expect(dock(page)).toHaveText("Completed · 3 nodes");
    const final = await readRun(page, id, run.id);
    expect(final.outcome).toBe("completed");
    expect(final.members.every((m) => m.attempt?.state === "succeeded")).toBe(true);
    for (const name of [`${stations}_a`, `${stations}_b`, `${stations}_c`]) {
      await expect(member(page, name)).toHaveAttribute("data-state", "up to date");
    }
    const recipe = await readRecipe(page, id);
    expect(recipe.steps.every((s) => s.conditions.includes("current"))).toBe(true);
    await expect(runAll(page)).toBeVisible();
  });

  await test.step("the band opened on the session's first run; the log's entries equal the record's events, newest first", async () => {
    await expect(band(page)).not.toHaveAttribute("data-collapsed", "true");
    const run = (await listRuns(page, id))[0];
    // Independently: the run's start, three member starts, three outcomes, the run's outcome.
    const expected = 1 + run.members.filter((m) => m.attempt?.state).length * 2 + 1;
    await expect(band(page).locator("[data-band-count]")).toHaveText(String(expected));
    const entries = band(page).locator("[data-band-entries] li");
    await expect(entries).toHaveCount(expected);
    await expect(entries.first()).toContainText("Completed");
    await expect(entries.last()).toContainText("Run all · 3 nodes");
    // This node narrows to the selected node; an entry's node selects it.
    await selectTile(page, `${stations}_b`);
    await band(page).locator("[data-band-scope='node']").click();
    await expect(band(page).locator("[data-band-entries] li")).toHaveCount(2);
    await band(page).locator("[data-band-scope='all']").click();
    await band(page).locator(`[data-band-node='${a}']`).first().click();
    await expect(panel(page)).toHaveAttribute("aria-label", "SQL step, node");
    await expect(member(page, `${stations}_a`)).toHaveAttribute("data-sel", "true");
    // Collapsed and reopened, the state survives a reload; the height does
    // not (every workflow opens at the default).
    await band(page).locator("[data-band-separator]").focus();
    await page.keyboard.press("Home");
    await expect(band(page)).toHaveAttribute("data-collapsed", "true");
    await page.reload();
    await settled(page);
    await expect(band(page)).toHaveAttribute("data-collapsed", "true");
    await expect(band(page).locator("[data-band-count]")).toHaveText(String(expected));
    await band(page).locator("[data-band-lead]").click();
    await expect(band(page)).not.toHaveAttribute("data-collapsed", "true");
    expect(await band(page).locator("[data-band-card]").evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(250);
  });

  await test.step("Run again on a produced node is its own run with one member; a change typed just before is saved first and runs", async () => {
    await selectTile(page, `${stations}_c`);
    const sql = panel(page).getByLabel(/^sql/);
    await sql.fill(`SELECT name, 1 AS marked FROM ${stations}_b`);
    await panel(page).locator("[data-run-node]").click();
    await expect.poll(async () => (await listRuns(page, id)).length).toBe(2);
    const single = (await listRuns(page, id))[0];
    expect(single.kind).toBe("single");
    expect(single.members.map((m) => m.stepId)).toEqual([c]);
    await expect(dock(page)).toHaveAttribute("data-run-dock", "ended", { timeout: 60_000 });
    await expect(dock(page)).toHaveText("Completed · 1 node");
    // The attempt ran the edited definition: the dataset answers a query only it can.
    const marked = await ok(page, "POST", "/api/query", { sql: `SELECT count(*) AS n FROM ${stations}_c WHERE marked = 1` });
    expect(Number((marked.preview as Json[])[0].n)).toBe(3);
    expect((await readRecipe(page, id)).steps.find((s) => s.id === c)?.proposedParameters).toBeNull();
  });

  await test.step("Run from here on the middle node asks, names the middle and the leaf, and runs those two", async () => {
    await selectTile(page, `${stations}_b`);
    await expect(panel(page).getByText("Run from here also runs the 1 node after it.")).toBeVisible();
    await panel(page).locator("[data-run-from]").click();
    const dialog = confirmDialog(page);
    await expect(dialog).toHaveAttribute("data-plan-kind", "from_step");
    // The run is named for the node as the canvas names it: its operation and its dataset.
    await expect(dialog.locator("strong").first()).toHaveText(`Run from SQL step · ${stations}_b`);
    await expect(dialog.locator("[data-plan-list] li")).toHaveCount(2);
    await dialog.locator("[data-confirm-run]").click();
    await expect.poll(async () => (await listRuns(page, id)).length).toBe(3);
    const from = (await listRuns(page, id))[0];
    expect(from.members.map((m) => m.stepId)).toEqual([b, c]);
    await expect(dock(page)).toHaveAttribute("data-run-dock", "ended", { timeout: 60_000 });
  });

  await test.step("an empty workflow says there is nothing to run", async () => {
    const empty = await newRecipe(page, `Empty ${runId}`);
    await page.goto(`/workflows/${empty}`);
    await settled(page);
    await runAll(page).click();
    await expect(page.locator("[data-run-refusal]")).toContainText("Nothing to run yet");
    expect(await listRuns(page, empty)).toEqual([]);
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});

test("the diamond: a failed member says why, its dependent is not run, the independent branch succeeds; the log says each; a proposal applied by a run", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await seed(page);
  const id = await newRecipe(page, `Diamond ${runId}`);
  const base = await addSql(page, id, `SELECT name FROM ${stations}`, `${stations}_base`);
  // A statement that parses and names an existing table but fails when run:
  // the node is not *cannot run* (that word is for a missing table); its
  // attempt fails, and the recipe says *run failed* after.
  const bad = await addSql(page, id, `SELECT CAST(name AS INTEGER) AS n FROM ${stations}`, `${stations}_bad`);
  const dep = await addSql(page, id, `SELECT * FROM ${stations}_bad`, `${stations}_dep`);
  const ind = await addSql(page, id, `SELECT name FROM ${stations}_base`, `${stations}_ind`);
  await page.goto(`/workflows/${id}`);
  await settled(page);
  await runAll(page).click();
  await confirmDialog(page).locator("[data-confirm-run]").click();
  await expect(dock(page)).toHaveAttribute("data-run-dock", "ended", { timeout: 60_000 });
  await expect(dock(page)).toHaveText("Partly completed · 2 of 4 succeeded");
  const run = (await listRuns(page, id))[0];
  const by = (stepId: string) => run.members.find((m) => m.stepId === stepId)!;
  expect(by(bad).state).toBe("failed");
  const message = by(bad).attempt?.error?.message ?? "";
  expect(message.length).toBeGreaterThan(10);
  expect(by(dep).state).toBe("not_run");
  expect(by(dep).attempt).toBeNull();
  expect(by(dep).stoppedBy).toBe(bad);
  expect(by(ind).state).toBe("succeeded");
  // After the run the tiles wear the recipe's states — published
  // precedence, restated here by hand as the oracle: un-runnable before
  // un-current, a failed attempt before never run.
  const recipe = await readRecipe(page, id);
  const wordOf = (stepId: string) => {
    const st = recipe.steps.find((s) => s.id === stepId)!;
    const attempt = (st.latestAttempt as { state?: string } | null)?.state;
    if (st.conditions.includes("broken")) return "cannot run";
    if (attempt === "failed") return "run failed";
    if (st.conditions.includes("never_run")) return "never run";
    if (st.conditions.includes("stale")) return "stale";
    return "up to date";
  };
  expect(wordOf(bad)).toBe("run failed");
  expect(wordOf(ind)).toBe("up to date");
  await expect(member(page, `${stations}_bad`)).toHaveAttribute("data-state", "run failed");
  await expect(member(page, `${stations}_ind`)).toHaveAttribute("data-state", "up to date");
  await expect(member(page, `${stations}_dep`)).toHaveAttribute("data-state", wordOf(dep));
  // The panel and the log carry the API's message and the not-run cause.
  await selectTile(page, `${stations}_bad`);
  await expect(panel(page).locator("[data-callout='failed']")).toContainText(message.slice(0, 40));
  const entries = band(page).locator("[data-band-entries] li");
  await expect(entries.filter({ hasText: `${stations}_bad failed.` })).toHaveCount(1);
  await expect(entries.filter({ hasText: `${stations}_bad failed.` })).toContainText(message.slice(0, 40));
  await expect(entries.filter({ hasText: `${stations}_dep not run. ${stations}_bad did not succeed.` })).toHaveCount(1);
  await expect(entries.first()).toContainText("Partly completed · 2 of 4 succeeded");
  // A proposal on the produced base: a run applies it when it succeeds.
  await selectTile(page, `${stations}_base`);
  await panel(page).getByLabel(/^sql/).fill(`SELECT name, riders FROM ${stations}`);
  await expect(member(page, `${stations}_base`)).toHaveAttribute("data-state", "edited");
  await panel(page).locator("[data-run-node]").click();
  await expect(dock(page)).toHaveAttribute("data-run-dock", "ended", { timeout: 60_000 });
  await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.id === base)?.proposedParameters).toBeNull();
  await expect(member(page, `${stations}_base`)).toHaveAttribute("data-state", "up to date");
  void ind;
  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});

test("a slow statement: waiting and running across the tiles, the unsettled member read-only, a run found in flight on open and after a reload, cancel, the refusals", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  // The refusals this test asks for headlessly (a second start while one is
  // in flight) are 409s the browser logs; exactly those are its own.
  let induced = 0;
  await seed(page);
  const id = await newRecipe(page, `Slow ${runId}`);
  // fast → slow → after: the fast member succeeds before the cancel and is
  // kept; the slow one is interrupted; the last is never admitted.
  const fast = await addSql(page, id, `SELECT name FROM ${stations}`, `${stations}_fast`);
  const slow = await addSql(page, id, `${ENDLESS} AND EXISTS (SELECT 1 FROM ${stations}_fast)`, `${stations}_slow`);
  const after = await addSql(page, id, `SELECT * FROM ${stations}_slow`, `${stations}_after`);
  const aside = await addSql(page, id, `SELECT name FROM ${stations}`, `${stations}_aside`);
  await page.goto(`/workflows/${id}`);
  await settled(page);

  await test.step("during the run the slow member is running, its dependent waiting; the unsettled member is read-only and cannot be removed or linked into", async () => {
    // Run from the fast node: it, the slow one and its dependent are the
    // run's members; the aside node is not named, so it stays editable.
    await selectTile(page, `${stations}_fast`);
    await panel(page).locator("[data-run-from]").click();
    await confirmDialog(page).locator("[data-confirm-run]").click();
    await expect(cancelBtn(page)).toBeVisible();
    await expect(dock(page)).toHaveAttribute("data-run-dock", "running");
    await expect(member(page, `${stations}_slow`)).toHaveAttribute("data-state", "running", { timeout: 20_000 });
    await expect(member(page, `${stations}_after`)).toHaveAttribute("data-state", "waiting");
    // What the tiles show is what the record holds.
    const live = (await listRuns(page, id))[0];
    expect(live.members.find((m) => m.stepId === fast)?.state).toBe("succeeded");
    expect(live.members.find((m) => m.stepId === slow)?.state).toBe("running");
    expect(live.members.find((m) => m.stepId === after)?.state).toBe("pending");
    await expect(member(page, `${stations}_fast`)).toHaveAttribute("data-state", "up to date");
    await selectTile(page, `${stations}_after`);
    await expect(panel(page).locator("[data-callout='run:waiting']")).toContainText("Waiting to run");
    // The definition's inert parts: the inputs and parameters, the name, the
    // preview.
    await expect(panel(page).locator("fieldset[data-inert]")).toHaveCount(3);
    await expect(panel(page).getByLabel(/^sql/)).toBeDisabled();
    await expect(panel(page).getByLabel("Dataset name")).toBeDisabled();
    await expect(panel(page).locator("[data-remove-withheld]")).toBeVisible();
    await expect(panel(page).locator("[data-remove-node]")).toHaveCount(0);
    await page.keyboard.press("Delete");
    await expect(page.locator("[data-canvas-notice]")).toContainText("part of the run in flight");
    await expect(page.locator("[data-removal-dialog]")).toHaveCount(0);
    // A node the run does not name is unaffected: its panel is live.
    await selectTile(page, `${stations}_aside`);
    await expect(panel(page).locator("fieldset[data-inert]")).toHaveCount(0);
  });

  await test.step("a second start while the run is in flight is refused by the API naming the run; the action here is Cancel", async () => {
    const live = (await listRuns(page, id))[0];
    const second = await api(page, "POST", `/api/recipes/${id}/runs`);
    expect(second.status).toBe(409);
    expect(String((second.json.error as Json).code)).toBe("run_in_flight");
    expect(String((second.json.error as Json).message)).toContain(live.id);
    const single = await api(page, "POST", `/api/recipes/${id}/steps/${aside}/run`);
    expect(single.status).toBe(409);
    expect((await listRuns(page, id)).length).toBe(1);
    await expect(runAll(page)).toHaveCount(0);
    induced += 2;
  });

  await test.step("a reload mid-run resumes from the record: the dock, Cancel and the states", async () => {
    await page.reload();
    await settled(page);
    await expect(cancelBtn(page)).toBeVisible();
    await expect(dock(page)).toHaveAttribute("data-run-dock", "running");
    await expect(member(page, `${stations}_slow`)).toHaveAttribute("data-state", "running", { timeout: 20_000 });
    await expect(band(page)).not.toHaveAttribute("data-collapsed", "true");
  });

  await test.step("Cancel: Cancelling… then the outcome; the running member cancelled, the pending one not run; the log says so", async () => {
    await cancelBtn(page).click();
    await expect(dock(page)).toHaveAttribute("data-run-dock", "ended", { timeout: 60_000 });
    await expect(dock(page)).toHaveText("Cancelled · 1 of 3 succeeded");
    const run = (await listRuns(page, id))[0];
    expect(run.outcome).toBe("cancelled");
    // The member that finished before the cancel stays finished: its dataset answers a query.
    expect(run.members.find((m) => m.stepId === fast)?.state).toBe("succeeded");
    const kept = await ok(page, "POST", "/api/query", { sql: `SELECT count(*) AS n FROM ${stations}_fast` });
    expect(Number((kept.preview as Json[])[0].n)).toBe(3);
    const s = run.members.find((m) => m.stepId === slow)!;
    expect(s.state).toBe("failed");
    expect(s.attempt?.state).toBe("cancelled");
    const w = run.members.find((m) => m.stepId === after)!;
    expect(w.state).toBe("not_run");
    expect(w.stoppedBy).toBe("cancelled");
    // No dataset appeared for the interrupted member.
    const tables = (await page.evaluate(async () => (await (await fetch("/api/tables")).json()) as { name: string }[])).map((t) => t.name);
    expect(tables).not.toContain(`${stations}_slow`);
    // After the run the tiles wear the recipe's states, not the run's.
    await expect(member(page, `${stations}_slow`)).toHaveAttribute("data-state", "never run");
    const entries = band(page).locator("[data-band-entries] li");
    await expect(entries.filter({ hasText: `${stations}_slow cancelled.` })).toHaveCount(1);
    await expect(entries.filter({ hasText: `${stations}_after not run. The run was cancelled before its turn.` })).toHaveCount(1);
    await expect(runAll(page)).toBeVisible();
  });

  await test.step("a run started headlessly is found on open, and the outcome line follows it", async () => {
    const started = await ok(page, "POST", `/api/recipes/${id}/steps/${slow}/run`);
    const headless = (started.run as Run).id;
    await page.goto(`/workflows/${id}`);
    await settled(page);
    await expect(cancelBtn(page)).toBeVisible();
    await expect(dock(page)).toHaveAttribute("data-run-dock", "running");
    await ok(page, "POST", `/api/recipes/${id}/runs/${headless}/cancel`);
    await expect(dock(page)).toHaveAttribute("data-run-dock", "ended", { timeout: 60_000 });
    await expect(dock(page)).toHaveText("Cancelled · 0 of 1 succeeded");
  });

  await test.step("the run in flight by keyboard: Run all, confirm, Cancel", async () => {
    await runAll(page).focus();
    await page.keyboard.press("Enter");
    await expect(confirmDialog(page)).toBeVisible();
    await confirmDialog(page).locator("[data-confirm-run]").focus();
    await page.keyboard.press("Enter");
    await expect(cancelBtn(page)).toBeVisible();
    await cancelBtn(page).focus();
    await page.keyboard.press("Enter");
    await expect(dock(page)).toHaveAttribute("data-run-dock", "ended", { timeout: 60_000 });
    // The band's separator resizes by keyboard.
    const sep = band(page).locator("[data-band-separator]");
    const before = await band(page).evaluate((el) => (el as HTMLElement).offsetHeight);
    await sep.focus();
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => band(page).evaluate((el) => (el as HTMLElement).offsetHeight)).toBeGreaterThan(before);
  });

  await test.step("in the framed view the band stands below the canvas, never over it", async () => {
    await page.getByRole("button", { name: "Framed view" }).click();
    await page.waitForTimeout(400);
    const flow = (await page.locator(".react-flow").boundingBox())!;
    const bandBox = (await band(page).boundingBox())!;
    expect(bandBox.y).toBeGreaterThanOrEqual(flow.y + flow.height - 1);
  });

  const refusals = consoleErrors.filter((e) => /status of 409/.test(e.text) && /\/api\/recipes\/[^/]+\/(runs|steps\/[^/]+\/run)$/.test(e.url ?? ""));
  expect(refusals).toHaveLength(induced);
  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !refusals.includes(e));
  expect(unexpected).toEqual([]);
});

// written for the supervising session's browser subagent. These journey
// steps are run by that subagent; verification names the red baseline and
// the required green/output evidence separately.
for (const mode of ["node", "all"] as const) {
  for (const seedKind of ["failed", "refused", "pending failure"] as const) {
    test(`${mode}: ${seedKind} keeps Run blocked and recovery runs the accepted SQL `, async ({ page }) => {
      await seed(page);
      const suffix = `${mode}_${seedKind.replaceAll(" ", "_")}_${runId}`;
      const name = `owned_${suffix}`, otherName = `other_${suffix}`;
      const id = await newRecipe(page, `Owned failure ${suffix}`);
      const a = await addSql(page, id, `SELECT name, 10 AS marked FROM ${stations}`, name);
      const b = await addSql(page, id, `SELECT name FROM ${stations}`, otherName);
      const path = `/api/recipes/${id}/steps/${a}`;
      let blocked = true, answered = 0;
      let release: (() => void) | null = null;
      let starts = 0;
      page.on("request", (request) => {
        if (request.method() !== "POST") return;
        const url = new URL(request.url()).pathname;
        if (url === `/api/recipes/${id}/steps/${a}/run` || (url === `/api/recipes/${id}/runs` && !request.postDataJSON()?.plan)) starts++;
      });
      await page.route(`**${path}`, async (route) => {
        if (route.request().method() !== "PATCH" || !blocked) return route.continue();
        if (seedKind === "pending failure") await new Promise<void>((resolve) => { release = resolve; });
        await route.fulfill({ status: seedKind === "refused" ? 422 : 500, contentType: "application/json", body: JSON.stringify({ error: { code: "seeded_failure", message: seedKind === "refused" ? "This SQL edit was refused." : "The seeded save failed." } }) });
        answered++;
      });
      await page.goto(`/workflows/${id}`); await settled(page); await selectTile(page, name);
      const sql = panel(page).getByLabel(/^sql/);
      const unsaved = `SELECT name, 99 AS marked FROM ${stations}`;
      await sql.fill(unsaved);
      const pressRun = async () => {
        if (mode === "node") await panel(page).locator("[data-run-node]").click();
        else { await runAll(page).click(); await confirmDialog(page).locator("[data-confirm-run]").click(); }
      };
      const notice = () => mode === "node" ? panel(page).locator("[data-run-refusal]") : page.locator("[data-run-chrome] [data-run-refusal]");
      // The canvas's own save status chip (it was the header card's
      // whisper, found as the page's first polite live region).
      const whisper = page.locator('[data-save-status="whisper"]').filter({ hasText: "Couldn’t save" });
      await test.step("the completed failure/refusal, or failure while Run waits, starts nothing", async () => {
        if (seedKind === "pending failure") {
          await expect.poll(() => release !== null).toBe(true);
          await pressRun(); release!();
        } else {
          await expect.poll(() => answered).toBe(1);
          if (seedKind === "refused") await expect(panel(page).getByText("This SQL edit was refused.", { exact: true })).toBeVisible();
          else await expect(whisper).toBeVisible();
          await pressRun();
        }
        await expect(notice()).toContainText("Couldn't save the change, so nothing started.");
        expect(starts).toBe(0); expect(await listRuns(page, id)).toEqual([]);
        await pressRun(); await expect(notice()).toContainText("Couldn't save the change, so nothing started.");
        expect(starts).toBe(0);
      });
      await test.step("another node saves; close and reopen preserve the value and its recovery", async () => {
        await selectTile(page, otherName);
        await panel(page).getByLabel(/^sql/).fill(`SELECT name, riders FROM ${stations}`);
        await expect.poll(async () => ((await readRecipe(page, id)).steps.find((s) => s.id === b)?.parameters as Json)?.sql).toBe(`SELECT name, riders FROM ${stations}`);
        if (seedKind !== "refused") await expect(whisper.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
        await selectTile(page, name); await panel(page).getByRole("button", { name: "Close panel", exact: true }).click();
        await expect(panel(page)).toHaveCount(0); await selectTile(page, name);
        await expect(panel(page).getByLabel(/^sql/)).toHaveValue(unsaved);
        if (seedKind === "refused") await expect(panel(page).getByText("This SQL edit was refused.", { exact: true })).toBeVisible();
        else await expect(whisper.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
        await pressRun(); await expect(notice()).toContainText("Couldn't save the change, so nothing started.");
        expect(starts).toBe(0); expect(await listRuns(page, id)).toEqual([]);
      });
      await test.step("accepted Retry or field correction starts once and output proves the accepted value", async () => {
        blocked = false;
        const expected = seedKind === "refused" ? 100 : 99;
        const acceptedSql = `SELECT name, ${expected} AS marked FROM ${stations}`;
        if (seedKind === "refused") await panel(page).getByLabel(/^sql/).fill(acceptedSql);
        else await whisper.getByRole("button", { name: "Retry", exact: true }).click();
        await expect.poll(async () => ((await readRecipe(page, id)).steps.find((s) => s.id === a)?.parameters as Json)?.sql).toBe(acceptedSql);
        await expect(panel(page).getByLabel(/^sql/)).toHaveValue(acceptedSql);
        await expect(panel(page).getByText("This SQL edit was refused.", { exact: true })).toHaveCount(0);
        await pressRun(); await expect(dock(page)).toHaveAttribute("data-run-dock", "ended", { timeout: 60_000 });
        expect(starts).toBe(1); expect(await listRuns(page, id)).toHaveLength(1);
        const output = await ok(page, "POST", "/api/query", { sql: `SELECT count(*) AS n, min(marked) AS lo, max(marked) AS hi FROM ${name}` });
        const row = (output.preview as Json[])[0];
        expect([Number(row.n), Number(row.lo), Number(row.hi)]).toEqual([3, expected, expected]);
      });
      await page.unroute(`**${path}`);
    });
  }
}
