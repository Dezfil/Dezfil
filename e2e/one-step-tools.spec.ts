// The one-step loop, end to end. It replaces the recipe-authoring journey:
// the chain, the index and their criteria left with the pivot, and what this
// file holds is the loop that replaced them — a door, one form, Run, a
// dataset and a layer.
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import { addLayer, createMap, routeHouse, seedFile, trackConsole } from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const stations = `tools_${runId}`;
/** Deliberately not the table's name: a derived display name built from a
 * label that could be either proves neither. */
const layerName = `Stations ${runId}`;

const WIDE = { width: 1440, height: 900 };

async function seedWorkspace(page: Page, mapName: string): Promise<string> {
  await page.goto("/data");
  await seedFile(
    page,
    `${stations}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  await page.goto("/maps");
  const mapId = await createMap(page, mapName);
  await addLayer(page, mapId, layerName, `SELECT * FROM ${stations}`);
  return mapId;
}

/** The invisible object, read from outside the UI entirely: one recipe made
 * by this action, holding exactly one step. */
async function recipeShape(page: Page, before: string[]) {
  return page.evaluate(async (before) => {
    const r = await fetch("/api/recipes", { cache: "no-store" });
    const { recipes } = (await r.json()) as {
      recipes: {
        id: string;
        origin: string;
        steps: {
          id: string;
          output: { name: string } | null;
          inputs: { name: string }[];
        }[];
      }[];
    };
    // Residue-proof: only the recipes this test made, never the
    // instance's whole listing, which other suites fill.
    const fresh = recipes.filter((x) => !before.includes(x.id));
    return {
      added: fresh.length,
      steps: fresh.map((x) => x.steps.length),
      outputs: fresh.flatMap((x) =>
        x.steps.map((st) => ({
          output: st.output?.name ?? null,
          inputs: (st.inputs ?? []).map((i) => i.name),
          origin: x.origin,
        })),
      ),
    };
  }, before);
}

async function recipeIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const r = await fetch("/api/recipes", { cache: "no-store" });
    return ((await r.json()) as { recipes: { id: string }[] }).recipes.map(
      (x) => x.id,
    );
  });
}

test("the loop: Analyze… → catalog → form → Run → a selected layer", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedWorkspace(page, `tools ${runId}`);
  await page.goto(`/maps/${mapId}`);
  const before = await recipeIds(page);

  await test.step("the door opens the catalog, suggestions first", async () => {
    if ((await page.locator('li[data-selected="true"]').count()) === 0) {
    await page.locator("[data-layer-select]").first().click();
  }
  await page.locator("[data-tools-control]").click();
    await expect(page.locator("[data-operation-picker]")).toBeVisible();
    // No Add step, no chain — the catalog IS the opening face.
    await expect(page.locator("[data-add-step]")).toHaveCount(0);
  });

  await test.step("the form arrives pre-filled, and the dry run gates Run", async () => {
    await page.locator("[data-operation='buffer']").click();
    await expect(page.locator("[data-parameter-form]")).toBeVisible();
    await page.locator("[data-param='distance']").fill("300");
    // Run is not armed until the check has answered for these values.
    await expect(page.locator("[data-dry-run]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-form-run]")).toBeEnabled();
    await expect(page.locator("[data-result-note]")).toContainText(/added to the map/i);
  });

  const output = `${stations}_buffer`;
  await test.step("Run: one gesture, a dataset, a selected layer under the derived name", async () => {
    await page.locator("[data-output-name]").fill(output);
    await page.locator("[data-form-run]").click();
    await expect(page.locator("[data-success-face]")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("[data-run-notice]")).toContainText(output);
    // The derived display name pairs the door's layer with the verb (D1).
    const madeName = `${layerName} (Buffer)`;
    await expect(page.locator("[data-run-notice]")).toContainText(madeName);
    // The new layer's card exists and is the selected one — identity, not
    // presence: the door's own layer is also on the list.
    const card = page.locator('li[data-selected="true"]');
    await expect(card).toContainText(madeName);
  });

  await test.step("one recipe, one step — owning the dataset, with lineage to the input", async () => {
    const shape = await recipeShape(page, before);
    expect(shape.added).toBe(1);
    expect(Math.max(...shape.steps)).toBe(1);
    const made = shape.outputs.find((o) => o.output === output);
    expect(made, "the step owns the dataset it wrote").toBeDefined();
    expect(made!.inputs, "and records lineage to its input").toContain(stations);
    // And the recipe says the builder made it, which keeps it off the
    // workflows page.
    expect(made!.origin).toBe("builder");
  });

  await test.step("Run another tool starts fresh; Done closes and hands focus back", async () => {
    await page.locator("[data-run-another]").click();
    await expect(page.locator("[data-operation-picker]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-recipe-drawer]")).toHaveCount(0);
  });

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});

test("a refused run is corrected in place, and the recipe still holds one step", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedWorkspace(page, `tools refusal ${runId}`);
  await page.goto(`/maps/${mapId}`);
  const before = await recipeIds(page);

  if ((await page.locator('li[data-selected="true"]').count()) === 0) {
    await page.locator("[data-layer-select]").first().click();
  }
  await page.locator("[data-tools-control]").click();
  await page.locator("[data-operation='buffer']").click();
  await page.locator("[data-param='distance']").fill("300");
  const contested = `${stations}_contested`;
  await page.locator("[data-output-name]").fill(contested);

  await test.step("the client's own check refuses a taken name before the wire", async () => {
    await page.locator("[data-output-name]").fill(stations);
    await expect(page.locator("[data-name-problem]")).toContainText(/already exists/i);
    await expect(page.locator("[data-form-run]")).toBeDisabled();
    await expect(page.locator("[data-param='distance']")).toHaveValue("300");
    await page.locator("[data-output-name]").fill(contested);
  });

  await test.step("a server-side refusal, provoked after the gate armed", async () => {
    await expect(page.locator("[data-form-run]")).toBeEnabled({ timeout: 30_000 });
    // The name was free when the dry run blessed it; another actor takes it
    // through the API before Run lands — the one refusal the client cannot
    // pre-empt, arriving after the step exists, which is precisely the case
    // the one-step invariant is about.
    const occupied = await page.evaluate(async ({ name, input }) => {
      const recipe = (await (
        await fetch("/api/recipes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "occupier" }),
        })
      ).json()) as { recipe: { id: string } };
      const step = (await (
        await (async function readThenWriteWorkflowSetup() { const basis = await (await fetch(`/api/recipes/${recipe.recipe.id}`)).json(); return fetch(`/api/recipes/${recipe.recipe.id}/steps`, {
          method: "POST",
          headers: { "X-Edit-Revision": basis.editRevision, "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "buffer",
            parameters: { input, distance: 10, name },
          }),
        }); })()
      ).json()) as { step: { id: string } };
      const accepted = await fetch(
        `/api/recipes/${recipe.recipe.id}/steps/${step.step.id}/run`,
        { method: "POST" },
      );
      // A step's own run is one of the recipe's runs: its one member's
      // job is the attempt to follow.
      const { run } = (await accepted.json()) as { run: { id: string; members: { jobId: string | null }[] } };
      const jobId = run.members[0]?.jobId;
      if (!jobId) return "accepted without an attempt";
      for (;;) {
        const r = await fetch(`/api/operations/runs/${jobId}`, { cache: "no-store" });
        const { run: view } = (await r.json()) as { run: { state: string } };
        if (["succeeded", "failed", "cancelled"].includes(view.state)) return view.state;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }, { name: contested, input: stations });
    expect(occupied).toBe("succeeded");

    await page.locator("[data-form-run]").click();
    // The server's sentence, beside the action, with every value held.
    await expect(page.locator("[data-form-error]")).toContainText(/exists|taken/i, {
      timeout: 60_000,
    });
    await expect(page.locator("[data-param='distance']")).toHaveValue("300");
  });

  const output = `${stations}_fixed`;
  await test.step("corrected, it runs — and the recipe still holds exactly one step", async () => {
    await page.locator("[data-output-name]").fill(output);
    await expect(page.locator("[data-form-run]")).toBeEnabled({ timeout: 30_000 });
    await page.locator("[data-form-run]").click();
    await expect(page.locator("[data-success-face]")).toBeVisible({ timeout: 90_000 });
    // Two recipes exist — the occupier and ours — and every one of them
    // holds exactly one step: the failed attempt was replaced, not joined.
    const shape = await recipeShape(page, before);
    expect(shape.added).toBe(2);
    expect(Math.max(...shape.steps)).toBe(1);
    expect(shape.outputs.some((o) => o.output === output)).toBe(true);
  });

  // The 409 is this test's own provocation (the occupied name): filtered
  // here, in the spec that causes it — never in the shared allowlist. A
  // taken name is refused when the step is added (400), not only when it
  // runs (409): both are the provocation this test makes.
  const provoked = /\/api\/recipes\/[^/]+\/steps(\/[^/]+\/run)?$/;
  expect(
    consoleErrors.filter(
      (e) =>
        !isAllowedConsoleError(e.text, e.url) &&
        !(provoked.test(e.url ?? "") && /\b(400|409)\b/.test(e.text)),
    ),
  ).toEqual([]);
});

test("a late dry-run answer never lands — only the current values' response renders", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedWorkspace(page, `tools reorder ${runId}`);

  // Two deliberately reordered responses: the FIRST dry-run request is held
  // long enough that the second — for corrected values — answers first. If
  // the guard fails, the held first answer lands last and repaints the form
  // for values the user no longer holds.
  let held = 0;
  await context.route("**/api/operations/run", async (route) => {
    const body = route.request().postDataJSON() as { dryRun?: boolean } | null;
    if (body?.dryRun === true && held === 0) {
      held += 1;
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    await route.continue();
  });

  await page.goto(`/maps/${mapId}`);
  if ((await page.locator('li[data-selected="true"]').count()) === 0) {
    await page.locator("[data-layer-select]").first().click();
  }
  await page.locator("[data-tools-control]").click();
  await page.locator("[data-operation='buffer']").click();
  await expect(page.locator("[data-parameter-form]")).toBeVisible();
  // First values: complete, so the (held) check fires…
  await page.locator("[data-param='distance']").fill("111");
  // …then immediately corrected, so the second check races past the first.
  await page.locator("[data-param='distance']").fill("222");

  await expect(page.locator("[data-dry-run]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-form-run]")).toBeEnabled();
  // The held answer lands now — for values that no longer exist. Nothing
  // may move: no checking state returns, Run stays armed.
  await page.waitForTimeout(3_000);
  await expect(page.locator("[data-form-run]")).toBeEnabled();
  await expect(page.locator("[data-dry-checking]")).toHaveCount(0);
  await expect(page.locator("[data-dry-refusal]")).toHaveCount(0);

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});

test("the dry run's answer holds steady while a re-check runs (the field-found blink)", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedWorkspace(page, `tools steady ${runId}`);

  // The first dry run answers at once; every later one is held long enough
  // to catch a display that blinks while a re-check runs. On the earlier
  // form this fails at once: the checking state replaced the answer.
  let seen = 0;
  await context.route("**/api/operations/run", async (route) => {
    const body = route.request().postDataJSON() as { dryRun?: boolean } | null;
    if (body?.dryRun === true) {
      seen += 1;
      if (seen > 1) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    await route.continue();
  });

  await page.goto(`/maps/${mapId}`);
  if ((await page.locator('li[data-selected="true"]').count()) === 0) {
    await page.locator("[data-layer-select]").first().click();
  }
  await page.locator("[data-tools-control]").click();
  await page.locator("[data-operation='buffer']").click();
  await expect(page.locator("[data-parameter-form]")).toBeVisible();
  await page.locator("[data-param='distance']").fill("111");
  await expect(page.locator("[data-dry-run]")).toBeVisible({ timeout: 30_000 });

  // A new value re-checks. Through the held window the last answer stays on
  // screen: the line never vanishes, the checking sentence never returns.
  await page.locator("[data-param='distance']").fill("222");
  for (let step = 0; step < 5; step += 1) {
    await expect(page.locator("[data-dry-run]")).toBeVisible();
    await expect(page.locator("[data-dry-checking]")).toHaveCount(0);
    await page.waitForTimeout(250);
  }

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});

test("five rows stay whole in the mixed two-group table list (field round)", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedWorkspace(page, `tools five ${runId}`);
  // Four more workspace tables, so the list holds more than fits.
  await page.goto("/data");
  for (const extra of ["v", "w", "x", "y"]) {
    await seedFile(
      page,
      `five_${extra}_${runId}.geojson`,
      readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
      "application/geo+json",
    );
  }

  await page.goto(`/maps/${mapId}`);
  if ((await page.locator('li[data-selected="true"]').count()) === 0) {
    await page.locator("[data-layer-select]").first().click();
  }
  // One quick run mints a Tool output, so the list shows BOTH groups —
  // the mixed case whose second heading clipped the fifth row.
  await page.locator("[data-tools-control]").click();
  await page.locator("[data-operation='buffer']").click();
  await page.locator("[data-param='distance']").fill("120");
  await page.locator("[data-output-name]").fill(`five_out_${runId}`);
  await expect(page.locator("[data-form-run]")).toBeEnabled({ timeout: 30_000 });
  await page.locator("[data-form-run]").click();
  await expect(page.locator("[data-run-notice]")).toContainText(`five_out_${runId}`, {
    timeout: 90_000,
  });

  await page.locator("[data-run-another]").click();
  await page.locator("[data-operation='buffer']").click();
  await page.locator("[data-parameter-form] input[type='search']").first().click();
  await expect(page.locator("[data-table-group='outputs']")).toBeVisible();
  const box = await page.locator("[data-table-rows]").boundingBox();
  expect(box).not.toBeNull();
  const rows = await page.locator("[data-table-rows] [data-table-row]").all();
  let whole = 0;
  for (const row of rows) {
    const r = await row.boundingBox();
    if (r && r.y >= box!.y - 0.5 && r.y + r.height <= box!.y + box!.height + 0.5) {
      whole += 1;
    }
  }
  // The field-found bar: five table rows fully inside the scroll region,
  // headings and the inter-group gap included in the budget.
  expect(whole).toBeGreaterThanOrEqual(5);
});

test("a distance is no part of an intersects question — revealed, floored, and never sent hidden", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedWorkspace(page, `tools reveal ${runId}`);

  await page.goto(`/maps/${mapId}`);
  if ((await page.locator('li[data-selected="true"]').count()) === 0) {
    await page.locator("[data-layer-select]").first().click();
  }
  await page.locator("[data-tools-control]").click();
  await page.locator("[data-operation='filter_by_location']").click();
  await expect(page.locator("[data-parameter-form]")).toBeVisible();

  // The door pre-fills the first input from the selected layer; only the
  // mask needs choosing. Both end up the same table — the relationship
  // under test is the form's, not the geometry's.
  await expect(
    page.locator("[data-input-locked='Features to filter']"),
  ).toBeVisible();
  await page
    .locator("input[aria-label='Search tables for Features to test against']")
    .click();
  await page
    .locator(`[aria-label='Features to test against'] [data-table-row='${stations}']`)
    .click();

  // The default relation is "intersects": no distance control exists, and
  // the gate arms without one — the field round's live-but-inert slider
  // and its ghost refusal are the defect this pins.
  await expect(page.locator("[data-param='distance']")).toHaveCount(0);
  await expect(page.locator("[data-form-run]")).toBeEnabled({ timeout: 30_000 });

  // Choosing within-distance reveals it; zero is refused by the form's own
  // sentence before any request, and Run disarms.
  await page.locator("[data-param='relation']").selectOption("within_distance");
  await expect(page.locator("[data-param='distance']")).toBeVisible();
  await page.locator("[data-param='distance']").fill("0");
  await expect(page.locator("[data-bounds-problem='distance']")).toContainText(
    /more than 0 metres/,
  );
  await expect(page.locator("[data-form-run]")).toBeDisabled();

  // The other end: past the served ceiling the form's own sentence
  // refuses before any request — and the metre slider keeps its log span
  // (its native scale is the 0–100 coordinate), not a linear ride to the
  // ceiling.
  await page.locator("[data-param='distance']").fill("1000000000000");
  await expect(page.locator("[data-bounds-problem='distance']")).toContainText(
    /at most 20,003,932 metres/,
  );
  await expect(page.locator("[data-form-run]")).toBeDisabled();
  await expect(page.locator("[data-param-slider='distance']")).toHaveAttribute(
    "max",
    "100",
  );

  // Switching back to a distance-less relation hides the control, strips
  // the stray 0 from the request, and the gate arms again — on the
  // earlier form this is exactly where the server refused a field the
  // question did not contain and Run stayed dead.
  await page.locator("[data-param='relation']").selectOption("within");
  await expect(page.locator("[data-param='distance']")).toHaveCount(0);
  await expect(page.locator("[data-dry-refusal]")).toHaveCount(0);
  await expect(page.locator("[data-form-run]")).toBeEnabled({ timeout: 30_000 });

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});

test("a table-only verb says so before Run — the catalog's own truth, no dry run needed (the pre-Run half)", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedWorkspace(page, `tools tableonly ${runId}`);
  await page.goto(`/maps/${mapId}`);

  if ((await page.locator('li[data-selected="true"]').count()) === 0) {
    await page.locator("[data-layer-select]").first().click();
  }
  await page.locator("[data-tools-control]").click();
  await page.locator("[data-operation='group_summarize']").click();
  await expect(page.locator("[data-parameter-form]")).toBeVisible();
  // The catalog declares this verb table-only, so the sentence needs no dry
  // run to be honest — it is on screen before anything else is chosen.
  await expect(page.locator("[data-result-note]")).toContainText(/no layer/i);

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});

test("a fresh table is offered without a reload, and an empty spatial result lands as a selected layer", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedWorkspace(page, `tools fresh ${runId}`);
  // **The stale precondition is observed, not assumed**:
  // the drawer's list loads once with the builder, and the fresh table must
  // be minted strictly after that first answer — otherwise the initial load
  // could contain it and this journey would pass with the fix removed.
  const initialList = page.waitForResponse(
    (r) => r.url().endsWith("/api/tables") && r.request().method() === "GET",
  );
  await page.goto(`/maps/${mapId}`);
  await initialList;
  await expect(page.locator("[data-layer-select]").first()).toBeVisible();

  // A table arrives while the builder is open — by API, the path the
  // drawer's list could not see before the sitting fix: the list loaded
  // with the builder and only a settling run reloaded it.
  const fresh = `poly_${runId}`;
  const minted = await page.evaluate(async (name) => {
    const accepted = await fetch("/api/operations/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "sql_step",
        parameters: {
          sql:
            "SELECT 'a' AS name, ST_GeomFromText('POLYGON((13.4 52.5, " +
            "13.42 52.5, 13.42 52.51, 13.4 52.51, 13.4 52.5))') AS geom",
          name,
        },
      }),
    });
    if (accepted.status !== 202) return `run refused: ${accepted.status}`;
    const { run } = (await accepted.json()) as { run: { id: string } };
    for (let i = 0; i < 120; i++) {
      const back = await fetch(`/api/operations/runs/${run.id}`, {
        cache: "no-store",
      });
      const { run: state } = (await back.json()) as {
        run: { state: string; error?: { message: string } };
      };
      if (state.state === "succeeded") return "succeeded";
      if (state.state === "failed") return state.error?.message ?? "failed";
      await new Promise((r) => setTimeout(r, 500));
    }
    return "timed out";
  }, fresh);
  expect(minted).toBe("succeeded");

  // Opening Tools is the moment the list is about to be read, and the fix
  // reloads it there — the re-fetch itself is asserted, so removing the
  // reload-on-open fails here even if timing would have hidden it.
  const reopenList = page.waitForResponse(
    (r) => r.url().endsWith("/api/tables") && r.request().method() === "GET",
  );
  await page.locator("[data-tools-control]").click();
  await reopenList;
  await page.locator("[data-operation='simplify']").click();
  await expect(page.locator("[data-parameter-form]")).toBeVisible();
  await page
    .locator("input[aria-label='Search tables for Features to simplify']")
    .click();
  await page.locator(`[data-table-row='${fresh}']`).click();

  // An absurd-but-legal tolerance empties the small polygon. The dry run
  // says zero before Run, per 0112.
  await page.locator("[data-param='tolerance']").fill("1000000");
  await page.locator("[data-output-name]").fill(`${fresh}_gone`);
  await expect(page.locator("[data-form-run]")).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator("[data-dry-run]")).toContainText(
    "0 rows · spatial, class undetermined: no geometries to classify",
  );
  const layersBefore = await page
    .locator('ul[class*="LayerList"] > li')
    .count();
  await page.locator("[data-form-run]").click();

  // The one gesture lands the dataset and a selected zero-feature layer.
  await expect(page.locator("[data-success-face]")).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.locator("[data-success-facts]")).toContainText(
    "0 rows · spatial: no geometries to classify",
  );
  await expect(page.locator("[data-run-notice]")).toContainText(/is on the map/);
  expect(await page.locator('ul[class*="LayerList"] > li').count()).toBe(
    layersBefore + 1,
  );
  const registered = await page.evaluate(async (name) => {
    const r = await fetch(`/api/tables/${encodeURIComponent(name)}`, {
      cache: "no-store",
    });
    return (await r.json()) as {
      rowCount: number;
      geometryColumn: string | null;
      geometryType: string | null;
    };
  }, `${fresh}_gone`);
  expect(registered).toMatchObject({
    rowCount: 0,
    geometryColumn: "geom",
    geometryType: null,
  });
  const render = await page.evaluate(async ({ id, table }) => {
    const map = (await (await fetch(`/api/maps/${id}`)).json()) as {
      layers: { id: string; sql: string }[];
    };
    const layerId = map.layers.find(
      (layer) => layer.sql === `SELECT * FROM ${table}`,
    )?.id;
    if (!layerId) return null;
    const r = await fetch(`/api/layers/${layerId}/render`);
    return r.ok ? ((await r.json()) as { featureCount: number; ok: boolean }) : null;
  }, { id: mapId, table: `${fresh}_gone` });
  expect(render).toMatchObject({ ok: true, featureCount: 0 });

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});
