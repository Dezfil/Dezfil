import { expect, test, type APIRequestContext, type Page, type Request, type Response, type Route } from "@playwright/test";
import { captureBasis, fixtureHeaders } from "../scripts/revision-fixtures.mjs";
import { readThenWriteRequestSetup } from "./edit-basis";
import { closeAll, createProject, invitePerson, runTag, share, type Person } from "./sharing-support";
import { routeHouse } from "./support";

const STALE = "This item has changed. Reload it before trying again.";
type Position = { x: number; y: number };
type Layout = { editRevision: string; steps: Record<string, Position>; sources: Record<string, Position>; notes: unknown[] };
type Recipe = { editRevision: string; steps: { id: string; parameters: { sql: string }; proposedParameters: { sql: string } | null }[] };
type Run = { id: string; outcome: string | null; members: { stepId: string; state: string; attempt: { state: string } | null }[] };
type Workflow = { id: string; upstream: string; downstream: string; upstreamName: string; downstreamName: string };

async function readRecipe(api: APIRequestContext, id: string): Promise<Recipe> {
  const response = await api.get(`/api/recipes/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).recipe;
}

async function readLayout(api: APIRequestContext, id: string): Promise<Layout> {
  const response = await api.get(`/api/recipes/${id}/layout`);
  expect(response.status()).toBe(200);
  return (await response.json()).layout;
}

async function runs(api: APIRequestContext, id: string): Promise<Run[]> {
  const response = await api.get(`/api/recipes/${id}/runs`);
  expect(response.status()).toBe(200);
  return (await response.json()).runs;
}

async function finished(api: APIRequestContext, id: string, runId: string): Promise<Run> {
  let run: Run | undefined;
  await expect.poll(async () => {
    const response = await api.get(`/api/recipes/${id}/runs/${runId}`);
    expect(response.status()).toBe(200);
    run = (await response.json()).run;
    return run?.outcome;
  }, { timeout: 60_000 }).toBe("completed");
  return run!;
}

async function cancelOutstanding(api: APIRequestContext, id: string) {
  for (const run of await runs(api, id)) {
    if (run.outcome === null) await api.post(`/api/recipes/${id}/runs/${run.id}/cancel`);
  }
}

async function seedWorkflow(api: APIRequestContext, tag: string, proposal: boolean): Promise<Workflow> {
  const created = await api.post("/api/recipes", { data: { name: `Run basis ${tag}` } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).recipe.id as string;
  const upstreamName = `run_basis_up_${tag}`, downstreamName = `run_basis_down_${tag}`;
  const add = async (name: string, sql: string) => {
    const response = await readThenWriteRequestSetup(api, `/api/recipes/${id}`, () => ({
      method: "POST", path: `/api/recipes/${id}/steps`, options: { data: { operation: "sql_step", parameters: { name, sql } } },
    }));
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()).step.id as string;
  };
  const upstream = await add(upstreamName, "SELECT 1 AS value");
  if (proposal) {
    const response = await readThenWriteRequestSetup(api, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/steps/${upstream}/run` }));
    expect(response.status(), await response.text()).toBe(202);
    await finished(api, id, (await response.json()).run.id);
  }
  const downstream = await add(downstreamName, `SELECT value FROM ${upstreamName}`);
  if (proposal) {
    const response = await readThenWriteRequestSetup(api, `/api/recipes/${id}`, () => ({
      method: "PATCH", path: `/api/recipes/${id}/steps/${upstream}`,
      options: { data: { parameters: { name: upstreamName, sql: "SELECT 2 AS value" } } },
    }));
    expect(response.status(), await response.text()).toBe(200);
    expect((await response.json()).applied).toBe("proposed");
  }
  // Deliberately untidy, so Arrange must change a visible position.
  const layout = await readThenWriteRequestSetup(api, `/api/recipes/${id}`, () => ({
    method: "PUT", path: `/api/recipes/${id}/layout`, options: { data: {
      steps: { [upstream]: { x: 480, y: 240 }, [downstream]: { x: 40, y: 80 } }, sources: {}, notes: [],
    } },
  }));
  expect(layout.status(), await layout.text()).toBe(200);
  return { id, upstream, downstream, upstreamName, downstreamName };
}

async function openCanvas(page: Page, workflow: Workflow) {
  const path = `/api/recipes/${workflow.id}`;
  const definition = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "GET");
  const layout = page.waitForResponse(response => new URL(response.url()).pathname === `${path}/layout` && response.request().method() === "GET");
  await page.goto(`/workflows/${workflow.id}`);
  const [shownDefinition, shownLayout] = await Promise.all([definition, layout]);
  const basis = captureBasis(await shownDefinition.json());
  expect(captureBasis(await shownLayout.json())).toEqual(basis);
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  await expect(page.locator(`[data-node][data-name="${workflow.upstreamName}"]`)).toBeVisible();
  await page.getByRole("button", { name: "Fit to view", exact: true }).click();
  await page.waitForTimeout(400);
  return basis;
}

async function startOnCanvas(page: Page, id: string, editRevision: string): Promise<Run> {
  await page.locator("[data-run-action='run-all']").click();
  const dialog = page.locator("[data-run-confirm]");
  await expect(dialog.locator("[data-plan-list] li")).toHaveCount(2);
  const started = page.waitForResponse(response => {
    const request = response.request();
    return new URL(response.url()).pathname === `/api/recipes/${id}/runs` && request.method() === "POST" && !request.postDataJSON()?.plan;
  });
  await dialog.locator("[data-confirm-run]").click();
  const response = await started;
  expect(response.request().headers()["x-edit-revision"]).toBe(editRevision);
  expect(response.status()).toBe(202);
  return (await response.json()).run;
}

function position(page: Page, step: string): Promise<Position> {
  return page.locator(`.react-flow__node[data-id="${step}"]`).evaluate(element => {
    const matrix = new DOMMatrixReadOnly((element as HTMLElement).style.transform);
    return { x: matrix.e, y: matrix.f };
  });
}

async function dragUpstream(page: Page, workflow: Workflow) {
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Fit to view", exact: true }).click();
  await page.waitForTimeout(400);
  const tile = page.locator(`[data-node][data-name="${workflow.upstreamName}"] [data-v='badge']`);
  const box = await tile.boundingBox();
  if (!box) throw new Error("The upstream tile is not visible.");
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const before = await position(page, workflow.upstream);
  expect(await tile.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), { x, y })).toBe(true);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 2, y);
  await page.mouse.move(x + 100, y + 60, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => position(page, workflow.upstream)).not.toEqual(before);
}

function watchWrites(page: Page, id: string): Request[] {
  const writes: Request[] = [];
  page.on("request", request => {
    if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith(`/api/recipes/${id}`)) writes.push(request);
  });
  return writes;
}

async function holdRunObservation(page: Page, id: string) {
  const path = `/api/recipes/${id}`;
  const seen = new Set<string>();
  let resume!: () => void;
  const held = new Promise<void>(resolve => { resume = resolve; });
  // Starting a run also refreshes its recipe, independently of the run poll.
  // Hold both reads before starting; writes and the API fixture stay live.
  const matches = (url: URL) => url.pathname === path || url.pathname.startsWith(`${path}/runs`);
  const handler = async (route: Route) => {
    if (route.request().method() === "GET") {
      seen.add(new URL(route.request().url()).pathname);
      await held;
    }
    await route.continue();
  };
  await page.route(matches, handler);
  return {
    observed: async (runId: string) => {
      await expect.poll(() => seen.has(path) && seen.has(`${path}/runs/${runId}`)).toBe(true);
      await expect(page.locator("[data-run-dock]")).toHaveAttribute("data-run-dock", "running");
    },
    release: async () => {
      resume();
      await page.unroute(matches, handler);
    },
  };
}

async function expectStaleLayout(page: Page, id: string, editRevision: string, act: () => Promise<void>) {
  const refusal = page.waitForResponse(response => new URL(response.url()).pathname === `/api/recipes/${id}/layout` && response.request().method() === "PUT");
  await act();
  const response = await refusal;
  expect(response.request().headers()["x-edit-revision"]).toBe(editRevision);
  expect(response.status()).toBe(409);
  expect(await response.json()).toEqual({ error: { code: "stale_revision", message: STALE } });
  const chip = page.locator("[data-save-status-corner]");
  await expect(chip).toContainText(STALE);
  await expect(chip.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  await expect(chip.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(chip.getByText("Saved", { exact: true })).toHaveCount(0);
  return response.request().postDataJSON() as Layout;
}

async function recoverLayout(page: Page, api: APIRequestContext, workflow: Workflow, before: Layout, draft: Layout, writes: Request[]) {
  const chip = page.locator("[data-save-status-corner]");
  const changed = [workflow.upstream, workflow.downstream].filter(id => JSON.stringify(draft.steps[id]) !== JSON.stringify(before.steps[id]));
  expect(changed.length).toBeGreaterThan(0);
  const assertDraft = async () => {
    for (const id of changed) await expect.poll(() => position(page, id)).toEqual(draft.steps[id]);
    expect((await readLayout(api, workflow.id)).steps).toEqual(before.steps);
    await expect(chip).toContainText(STALE);
  };
  await assertDraft();
  const writeCount = writes.length;
  await page.waitForTimeout(1200);
  expect(writes).toHaveLength(writeCount);

  await chip.getByRole("button", { name: "Reload", exact: true }).click();
  const notice = chip.locator("[data-stale-recovery]");
  await expect(notice).toContainText(/discard/i);
  await expect(notice).toContainText(/unsaved/i);
  await notice.getByRole("button", { name: "Not now", exact: true }).click();
  await assertDraft();
  expect(writes).toHaveLength(writeCount);

  await chip.getByRole("button", { name: "Reload", exact: true }).click();
  await notice.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(chip.getByText(STALE, { exact: true })).toHaveCount(0);
  for (const id of [workflow.upstream, workflow.downstream]) await expect.poll(() => position(page, id)).toEqual(before.steps[id]);
  await page.waitForTimeout(1200);
  expect(writes).toHaveLength(writeCount);
  expect((await readLayout(api, workflow.id)).steps).toEqual(before.steps);

  // Reapplying is a fresh, explicit edit carrying the reloaded revision.
  const current = captureBasis(await readRecipe(api, workflow.id));
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/recipes/${workflow.id}/layout` && response.request().method() === "PUT");
  await dragUpstream(page, workflow);
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(response.request().headers()["x-edit-revision"]).toBe(current.editRevision);
  await expect(chip.getByText("Saved", { exact: true })).toBeVisible();
  expect((await readLayout(api, workflow.id)).steps).toEqual(response.request().postDataJSON().steps);
}

test("a run promotes its upstream proposal and continues into its downstream node", async ({ page, request }) => {
  const workflow = await seedWorkflow(request, runTag(), true);
  try {
    const basis = await openCanvas(page, workflow);
    const run = await startOnCanvas(page, workflow.id, basis.editRevision);
    const result = await finished(request, workflow.id, run.id);
    expect(result.members.map(member => [member.stepId, member.state, member.attempt?.state])).toEqual([
      [workflow.upstream, "succeeded", "succeeded"], [workflow.downstream, "succeeded", "succeeded"],
    ]);
    await expect(page.locator("[data-run-dock]")).toHaveAttribute("data-run-dock", "ended", { timeout: 60_000 });
    await expect(page.locator("[data-run-dock]")).toContainText("Completed");
    const recipe = await readRecipe(request, workflow.id);
    expect(recipe.editRevision).not.toBe(basis.editRevision);
    expect(recipe.steps.find(step => step.id === workflow.upstream)).toMatchObject({ parameters: { sql: "SELECT 2 AS value" }, proposedParameters: null });
    const query = await request.post("/api/query", { data: { sql: `SELECT value FROM ${workflow.downstreamName}` } });
    expect(query.status()).toBe(200);
    expect((await query.json()).preview).toEqual([{ value: 2 }]);
  } finally {
    await cancelOutstanding(request, workflow.id);
  }
});

test("a stale node drag with its run observation held keeps the unsaved position until Reload without replay", async ({ page, request }) => {
  const workflow = await seedWorkflow(request, runTag(), true);
  const basis = await openCanvas(page, workflow);
  const before = await readLayout(request, workflow.id);
  const observation = await holdRunObservation(page, workflow.id);
  try {
    const run = await startOnCanvas(page, workflow.id, basis.editRevision);
    await finished(request, workflow.id, run.id);
    await observation.observed(run.id);
    const promoted = await readRecipe(request, workflow.id);
    expect(promoted.editRevision).not.toBe(basis.editRevision);
    expect(promoted.steps.find(step => step.id === workflow.upstream)).toMatchObject({ parameters: { sql: "SELECT 2 AS value" }, proposedParameters: null });
    const promotedLayout = await readLayout(request, workflow.id);
    expect(promotedLayout.editRevision).toBe(promoted.editRevision);
    expect(promotedLayout.steps).toEqual(before.steps);

    const writes = watchWrites(page, workflow.id);
    const draft = await expectStaleLayout(page, workflow.id, basis.editRevision, () => dragUpstream(page, workflow));
    expect(draft.steps[workflow.upstream]).not.toEqual(before.steps[workflow.upstream]);
    const node = page.locator(`[data-node][data-name="${workflow.upstreamName}"]`);
    const ghost = page.locator(`[data-saved-position="${workflow.upstream}"]`);
    const badgeOffset = await node.locator("[data-v='badge']").evaluate(element => ({
      x: (element as HTMLElement).offsetLeft, y: (element as HTMLElement).offsetTop,
    }));
    const chip = page.locator("[data-save-status-corner]");
    const assertDraft = async () => {
      await expect.poll(() => position(page, workflow.upstream)).toEqual(draft.steps[workflow.upstream]);
      await expect(node.getByText("unsaved position", { exact: true })).toBeVisible();
      await expect(ghost).toBeVisible();
      expect(await ghost.evaluate(element => ({
        x: parseFloat((element as HTMLElement).style.left), y: parseFloat((element as HTMLElement).style.top),
      }))).toEqual({ x: before.steps[workflow.upstream].x + badgeOffset.x, y: before.steps[workflow.upstream].y + badgeOffset.y });
      await expect(chip).toContainText(STALE);
      await expect(chip.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
      await expect(chip.getByText("Saved", { exact: true })).toHaveCount(0);
      expect(await readLayout(request, workflow.id)).toEqual(promotedLayout);
      expect(writes).toHaveLength(1);
    };
    await assertDraft();
    await page.waitForTimeout(1200);
    await assertDraft();
    // Learning that the run ended must not replay or erase the refused drag.
    await observation.release();
    await expect(page.locator("[data-run-dock]")).toHaveAttribute("data-run-dock", "ended", { timeout: 60_000 });
    await assertDraft();

    await chip.getByRole("button", { name: "Reload", exact: true }).click();
    const notice = chip.locator("[data-stale-recovery]");
    await expect(notice).toContainText(/discard/i);
    await expect(notice).toContainText(/unsaved/i);
    await notice.getByRole("button", { name: "Not now", exact: true }).click();
    await assertDraft();
    await chip.getByRole("button", { name: "Reload", exact: true }).click();
    const reloaded = page.waitForResponse(response => new URL(response.url()).pathname === `/api/recipes/${workflow.id}/layout` && response.request().method() === "GET");
    await notice.getByRole("button", { name: "Reload", exact: true }).click();
    expect((await (await reloaded).json()).layout).toEqual(promotedLayout);
    await expect(notice).toHaveCount(0);
    await expect(chip).not.toContainText(STALE);
    await expect(chip.getByRole("button", { name: "Reload", exact: true })).toHaveCount(0);
    await expect(node.getByText("unsaved position", { exact: true })).toHaveCount(0);
    await expect(ghost).toHaveCount(0);
    for (const id of [workflow.upstream, workflow.downstream]) await expect.poll(() => position(page, id)).toEqual(promotedLayout.steps[id]);
    await page.waitForTimeout(1200);
    expect(writes).toHaveLength(1);
    expect(await readLayout(request, workflow.id)).toEqual(promotedLayout);
  } finally {
    await observation.release();
    await cancelOutstanding(request, workflow.id);
  }
});

test("a fresh node drag after its run observation settles saves with the returned revision", async ({ page, request }) => {
  const workflow = await seedWorkflow(request, runTag(), true);
  const basis = await openCanvas(page, workflow);
  const before = await readLayout(request, workflow.id);
  const observation = await holdRunObservation(page, workflow.id);
  try {
    const run = await startOnCanvas(page, workflow.id, basis.editRevision);
    await finished(request, workflow.id, run.id);
    await observation.observed(run.id);
    const promoted = await readRecipe(request, workflow.id);
    expect(promoted.editRevision).not.toBe(basis.editRevision);
    expect(promoted.steps.find(step => step.id === workflow.upstream)).toMatchObject({ parameters: { sql: "SELECT 2 AS value" }, proposedParameters: null });

    const reads: Response[] = [];
    page.on("response", response => {
      if (new URL(response.url()).pathname === `/api/recipes/${workflow.id}` && response.request().method() === "GET") reads.push(response);
    });
    await observation.release();
    await expect(page.locator("[data-run-dock]")).toHaveAttribute("data-run-dock", "ended", { timeout: 60_000 });
    await expect(page.locator("[data-run-dock]")).toContainText("Completed");
    expect(reads.length).toBeGreaterThan(0);
    const settled = reads.at(-1)!;
    expect(settled.status()).toBe(200);
    const settledBasis = captureBasis(await settled.json());
    expect(settledBasis.editRevision).not.toBe(basis.editRevision);

    const writes = watchWrites(page, workflow.id);
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/recipes/${workflow.id}/layout` && response.request().method() === "PUT");
    await dragUpstream(page, workflow);
    const response = await saved;
    expect(response.request().headers()["x-edit-revision"]).toBe(settledBasis.editRevision);
    expect(response.status()).toBe(200);
    const savedBasis = captureBasis(await response.json());
    expect(savedBasis.editRevision).not.toBe(basis.editRevision);
    expect(savedBasis.editRevision).not.toBe(settledBasis.editRevision);
    const draft = response.request().postDataJSON() as Layout;
    expect(draft.steps[workflow.upstream]).not.toEqual(before.steps[workflow.upstream]);
    await expect.poll(() => position(page, workflow.upstream)).toEqual(draft.steps[workflow.upstream]);
    expect((await readLayout(request, workflow.id)).steps).toEqual(draft.steps);
    const chip = page.locator("[data-save-status-corner]");
    await expect(chip.getByText("Saved", { exact: true })).toBeVisible();
    await expect(chip).not.toContainText(STALE);
    await expect(chip.getByRole("button", { name: "Reload", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-stale-recovery]")).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect((await runs(request, workflow.id)).map(item => item.id)).toContain(run.id);
    expect(await runs(request, workflow.id)).toHaveLength(2);
  } finally {
    await observation.release();
    await cancelOutstanding(request, workflow.id);
  }
});

test("Arrange after a co-editor's parameter edit keeps the refused layout until Reload without replay", async ({ browser, request, baseURL }) => {
  const people: Person[] = [];
  try {
    const tag = runTag();
    const owner = await invitePerson(browser, request, baseURL!, "Ada", tag);
    people.push(owner);
    const editor = await invitePerson(browser, request, baseURL!, "Bo", tag);
    people.push(editor);
    const workflow = await seedWorkflow(owner.api, tag, false);
    const project = await createProject(owner, `Run basis ${tag}`, { addRecipes: [workflow.id] });
    await share(owner, project, editor, "editor");
    await routeHouse(owner.context, { basemapStyleStub: true });
    const page = await owner.context.newPage();
    const basis = await openCanvas(page, workflow);
    const before = await readLayout(owner.api, workflow.id);
    const editorBasis = captureBasis(await readRecipe(editor.api, workflow.id));
    expect(editorBasis).toEqual(basis);
    const changed = await editor.api.patch(`/api/recipes/${workflow.id}/steps/${workflow.upstream}`, {
      headers: fixtureHeaders(editorBasis), data: { parameters: { name: workflow.upstreamName, sql: "SELECT 3 AS value" } },
    });
    expect(changed.status(), await changed.text()).toBe(200);
    expect(captureBasis(await changed.json())).not.toEqual(basis);
    const writes = watchWrites(page, workflow.id);
    const draft = await expectStaleLayout(page, workflow.id, basis.editRevision, () => page.getByRole("button", { name: "Arrange by dependency", exact: true }).click());
    expect(writes).toHaveLength(1);
    await recoverLayout(page, owner.api, workflow, before, draft, writes);
    expect((await readRecipe(owner.api, workflow.id)).steps.find(step => step.id === workflow.upstream)?.parameters.sql).toBe("SELECT 3 AS value");
    expect(await runs(owner.api, workflow.id)).toEqual([]);
  } finally {
    await closeAll(people);
  }
});
