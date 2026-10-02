import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
import { test, expect, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  startFixtureServer,
  trackConsole,
} from "./support";

/**
 * A workflow output and
 * the map layer that reads it follow a real external-source refresh. The API's
 * table details, recipe, run records, map and layer render are the oracle; the
 * canvas repeats the recipe record's stale state and source-change reason.
 *
 * Provisioning: the server must be launched with
 * `DEZFIL_EGRESS_ALLOWLIST=127.0.0.1` (the URL import fetches the loopback
 * fixture this file starts itself on port 31880); nothing else.
 */

const runId = Date.now().toString(36);
const sourceName = `sc_source_${runId}`;
const outputName = `sc_output_${runId}`;

const INITIAL =
  "label,score,lon,lat\n" +
  "old_alpha,10,13.401,52.501\n" +
  "old_beta,20,13.402,52.502\n";
const CHANGED =
  "label,score,lon,lat\n" +
  "new_gamma,30,13.411,52.511\n" +
  "new_delta,40,13.412,52.512\n" +
  "new_epsilon,50,13.413,52.513\n";

type Json = Record<string, unknown>;
type TableRecord = {
  id: string;
  name: string;
  file: string;
  source: string;
  rowCount: number;
  geometryColumn: string | null;
};
type TableDetail = TableRecord & {
  preview: Json[];
};
type Cause = {
  reason: string;
  tableId: string;
  tableName: string;
};
type WorkflowStep = {
  id: string;
  output: { id: string; name: string } | null;
  conditions: string[];
  causes: Cause[];
  latestAttempt: { state: string } | null;
};
type RunRecord = {
  id: string;
  outcome: string | null;
  members: {
    stepId: string;
    state: string;
    attempt: { state: string } | null;
  }[];
};
type LayerRender = {
  ok: boolean;
  mode?: string;
  featureCount?: number;
  geojson?: {
    features: { properties: Json }[];
  };
};

async function api<T>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
  basis?: EditBasis,
): Promise<T> {
  return page.evaluate(
    async ({ method, path, body, basis }) => {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${method} ${path} → ${response.status}: ${text}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    },
    { method, path, body, basis },
  );
}

const tableDetail = (page: Page, name: string) =>
  api<TableDetail>(page, "GET", `/api/tables/${encodeURIComponent(name)}`);
const readRecipe = async (page: Page, recipeId: string) =>
  (
    await api<{ recipe: { steps: WorkflowStep[] } }>(
      page,
      "GET",
      `/api/recipes/${recipeId}`,
    )
  ).recipe;
const listRuns = async (page: Page, recipeId: string) =>
  (
    await api<{ runs: RunRecord[] }>(
      page,
      "GET",
      `/api/recipes/${recipeId}/runs`,
    )
  ).runs;
const readRun = async (page: Page, recipeId: string, recordId: string) =>
  (
    await api<{ run: RunRecord }>(
      page,
      "GET",
      `/api/recipes/${recipeId}/runs/${recordId}`,
    )
  ).run;
const renderLayer = (page: Page, layerId: string) =>
  api<LayerRender>(page, "GET", `/api/layers/${layerId}/render`);

function labels(detail: TableDetail): string[] {
  return detail.preview.map((row) => String(row.label)).sort();
}

function renderedLabels(render: LayerRender): string[] {
  return (render.geojson?.features ?? [])
    .map((feature) => String(feature.properties.label))
    .sort();
}

async function runWorkflow(
  page: Page,
  recipeId: string,
  stepId: string,
): Promise<RunRecord> {
  const started = await readThenWriteBrowserSetup(page, `/api/recipes/${recipeId}`, () => ({ method: "POST", path: `/api/recipes/${recipeId}/runs`, body: {} })).then(result => result.json as { run: RunRecord });
  await expect
    .poll(async () => (await readRun(page, recipeId, started.run.id)).outcome, {
      timeout: 60_000,
    })
    .toBe("completed");
  const record = await readRun(page, recipeId, started.run.id);
  expect(record.members).toHaveLength(1);
  expect(record.members[0]).toMatchObject({
    stepId,
    state: "succeeded",
    attempt: { state: "succeeded" },
  });
  return record;
}

test("a source refresh makes its node stale; a re-run replaces the output and the mapped layer reads the new source", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const remoteFiles: Record<string, Buffer> = {
    "source-change.csv": Buffer.from(INITIAL),
  };
  const fixtures = await startFixtureServer(31880, { files: remoteFiles });

  try {
    await page.goto("/workflows");

    let sourceBefore!: TableDetail;
    let recipeId = "";
    let stepId = "";
    let outputBefore!: TableDetail;
    await test.step("import the source, run one SQL node, and record the first output", async () => {
      // An uploaded CSV has no remote recipe to re-run, and a second upload
      // deduplicates instead of replacing it. A URL-imported CSV takes the real
      // in-place refresh road: same table id, a new artifact from changed
      // external bytes. That identity-preserving generation change is what the
      // recipe can truthfully classify as source_changed.
      const imported = await api<{ name: string }>(
        page,
        "POST",
        "/api/imports/url",
        {
          url: `${fixtures.origin}/files/source-change.csv`,
          name: sourceName,
        },
      );
      expect(imported.name).toBe(sourceName);

      sourceBefore = await tableDetail(page, sourceName);
      expect(sourceBefore).toMatchObject({
        name: sourceName,
        source: "url",
        rowCount: 2,
      });
      expect(sourceBefore.geometryColumn).not.toBeNull();
      expect(labels(sourceBefore)).toEqual(["old_alpha", "old_beta"]);

      recipeId = (
        await api<{ recipe: { id: string } }>(page, "POST", "/api/recipes", {
          name: `Source change ${runId}`,
        })
      ).recipe.id;
      stepId = (
        await readThenWriteBrowserSetup(page, `/api/recipes/${recipeId}`, () => ({ method: "POST", path: `/api/recipes/${recipeId}/steps`, body: {
            operation: "sql_step",
            parameters: {
              sql: `SELECT * FROM ${sourceName}`,
              name: outputName,
            },
          } })).then(result => result.json as { step: { id: string } })
      ).step.id;
      const firstRun = await runWorkflow(page, recipeId, stepId);
      expect(firstRun.outcome).toBe("completed");
      // The attribution control: current, not stale, no causes before the
      // refresh, so the staleness read later is the refresh's doing.
      const fresh = (await readRecipe(page, recipeId)).steps.find((candidate) => candidate.id === stepId)!;
      expect(fresh.conditions).toContain("current");
      expect(fresh.conditions).not.toContain("stale");
      expect(fresh.causes).toEqual([]);

      outputBefore = await tableDetail(page, outputName);
      expect(outputBefore.rowCount).toBe(2);
      expect(labels(outputBefore)).toEqual(["old_alpha", "old_beta"]);
    });

    let mapId = "";
    let layerId = "";
    let mapBefore: { layers: { id: string; name: string; sql: string }[] };
    let layerBefore: LayerRender;
    await test.step("map the output and read its first values through the layer API", async () => {
      mapId = await createMap(page, `Source change map ${runId}`);
      layerId = await addLayer(
        page,
        mapId,
        `Source change layer ${runId}`,
        `SELECT * FROM ${outputName}`,
      );
      mapBefore = await api(page, "GET", `/api/maps/${mapId}`);
      expect(mapBefore.layers).toHaveLength(1);
      expect(mapBefore.layers[0]).toMatchObject({
        id: layerId,
        sql: `SELECT * FROM ${outputName}`,
      });
      expect(mapBefore.layers[0].sql).not.toContain(sourceName);

      layerBefore = await renderLayer(page, layerId);
      expect(layerBefore).toMatchObject({
        ok: true,
        mode: "inline",
        featureCount: 2,
      });
      expect(renderedLabels(layerBefore)).toEqual(["old_alpha", "old_beta"]);
    });

    await test.step("change the external CSV and refresh the source in place", async () => {
      remoteFiles["source-change.csv"] = Buffer.from(CHANGED);
      const refreshed = await api<TableRecord>(
        page,
        "POST",
        `/api/tables/${encodeURIComponent(sourceName)}/refresh`,
        {},
      );
      expect(refreshed).toMatchObject({
        id: sourceBefore.id,
        name: sourceName,
        rowCount: 3,
      });
      expect(refreshed.file).not.toBe(sourceBefore.file);
    });

    const sourceAfter = await tableDetail(page, sourceName);
    expect(sourceAfter.id).toBe(sourceBefore.id);
    expect(sourceAfter.file).not.toBe(sourceBefore.file);
    expect(sourceAfter.rowCount).not.toBe(sourceBefore.rowCount);
    expect(labels(sourceAfter)).toEqual([
      "new_delta",
      "new_epsilon",
      "new_gamma",
    ]);

    await test.step("the recipe and the canvas say stale for the changed source", async () => {
      const recipe = await readRecipe(page, recipeId);
      const step = recipe.steps.find((candidate) => candidate.id === stepId)!;
      expect(step.conditions).toContain("stale");
      expect(step.causes).toEqual([
        {
          reason: "source_changed",
          tableId: sourceBefore.id,
          tableName: sourceName,
        },
      ]);

      await page.goto(`/workflows/${recipeId}`);
      await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
      const node = page
        .locator(`[data-node][data-name="${outputName}"]`)
        .first();
      await expect(node).toHaveAttribute("data-state", "stale");
      await node.locator("[data-v='badge']").hover();
      await expect(node.locator("[data-disclosure]")).toBeVisible();
      await expect(node.locator("[data-disclosure]")).toContainText(
        `SQL step · ${outputName} · stale`,
      );
      await node.locator("[data-v='badge']").click();
      await expect(
        page.locator("[data-node-panel] [data-callout='stale']"),
      ).toHaveText(`Stale. ${sourceName} has new data since this ran.`);
    });

    await test.step("Run all lands a second successful run from the canvas", async () => {
      // The open panel covers the canvas's right side (the runbook's second
      // trap): close it before pressing the dock.
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-node-panel]")).toBeHidden();
      const oldRunIds = new Set(
        (await listRuns(page, recipeId)).map((record) => record.id),
      );
      await page.locator("[data-run-action='run-all']").click();
      await expect(page.locator("[data-run-confirm]")).toBeVisible();
      await page.locator("[data-run-confirm] [data-confirm-run]").click();
      await expect
        .poll(
          async () =>
            (await listRuns(page, recipeId)).find(
              (record) => !oldRunIds.has(record.id),
            )?.id ?? null,
          { timeout: 60_000 },
        )
        .not.toBeNull();
      const newRun = (await listRuns(page, recipeId)).find(
        (record) => !oldRunIds.has(record.id),
      )!;
      await expect
        .poll(async () => (await readRun(page, recipeId, newRun.id)).outcome, {
          timeout: 60_000,
        })
        .toBe("completed");
      const secondRun = await readRun(page, recipeId, newRun.id);
      expect(secondRun.members).toHaveLength(1);
      expect(secondRun.members[0]).toMatchObject({
        stepId,
        state: "succeeded",
        attempt: { state: "succeeded" },
      });
      await expect(
        page.locator(`[data-node][data-name="${outputName}"]`),
      ).toHaveAttribute("data-state", "up to date", { timeout: 60_000 });
    });

    const recipeAfter = await readRecipe(page, recipeId);
    const stepAfter = recipeAfter.steps.find(
      (candidate) => candidate.id === stepId,
    )!;
    expect(stepAfter.conditions).toContain("current");
    expect(stepAfter.conditions).not.toContain("stale");
    expect(stepAfter.causes).toEqual([]);
    expect(stepAfter.latestAttempt?.state).toBe("succeeded");

    await test.step("the output and the same mapped layer now read the new source", async () => {
      const outputAfter = await tableDetail(page, outputName);
      expect(outputAfter.id).toBe(outputBefore.id);
      expect(outputAfter.file).not.toBe(outputBefore.file);
      expect(outputAfter.rowCount).toBe(3);
      expect(outputAfter.rowCount).not.toBe(outputBefore.rowCount);
      expect(labels(outputAfter)).toEqual([
        "new_delta",
        "new_epsilon",
        "new_gamma",
      ]);
      expect(labels(outputAfter)).not.toEqual(labels(outputBefore));

      const mapAfter = await api<typeof mapBefore>(
        page,
        "GET",
        `/api/maps/${mapId}`,
      );
      expect(mapAfter.layers).toEqual(mapBefore.layers);

      const layerAfter = await renderLayer(page, layerId);
      expect(layerAfter).toMatchObject({
        ok: true,
        mode: "inline",
        featureCount: 3,
      });
      expect(layerAfter.featureCount).not.toBe(layerBefore.featureCount);
      expect(renderedLabels(layerAfter)).toEqual([
        "new_delta",
        "new_epsilon",
        "new_gamma",
      ]);
      expect(renderedLabels(layerAfter)).not.toEqual(
        renderedLabels(layerBefore),
      );
    });

    const unexpected = consoleErrors.filter(
      (entry) => !isAllowedConsoleError(entry.text, entry.url),
    );
    expect(unexpected).toEqual([]);
  } finally {
    await fixtures.close();
  }
});
