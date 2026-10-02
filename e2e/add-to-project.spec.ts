import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
// The 14-A dialog: the Maps action in both presentations and filing
// states, the picker's ruled semantics, the checklist's truth from the
// documented dependencies read, both confirm roads with the after-state
// verified through the API (the map and producer moved with single
// membership, the shared dataset keeping its other memberships,
// unchecked rows and the producer's other output untouched), the
// refusal keeping the dialog and changing nothing, and cancellation.
// Residue-proof: every assertion is about this run's seeded objects.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FIXTURES_DIR, routeHouse, seedCsv, seedFile } from "./support";

const runId = Date.now().toString(36);
const PA = `Origin shelf ${runId}`;
const PB = `Berlin lanes ${runId}`;
const PC = `Third shelf ${runId}`;
const MAP = `Stations map ${runId}`;
const MAP2 = `Fresh map ${runId}`;
const NEWP = `Harbor study ${runId}`;
const WF = `Catchments ${runId}`;
const T_SHARED = `atp_shared_${runId}`;
const T_PLAIN = `atp_plain_${runId}`;
const OUT1 = `atp_out1_${runId}`;
const OUT2 = `atp_out2_${runId}`;

const api = (page: Page, method: string, pathName: string, body?: unknown, basis?: EditBasis) =>
  page.evaluate(
    async ({ method, pathName, body, basis }) => {
      const r = await fetch(pathName, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : undefined), ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok && r.status !== 204) throw new Error(await r.text());
      const text = r.status === 204 ? "" : await r.text();
      return text ? (JSON.parse(text) as unknown) : null;
    },
    { method, pathName, body, basis },
  );

/** The head: the dialog is reachable by its accessible
 * name, the whole sentence; the title's rendered text is that sentence;
 * the subject's name is rendered bold and every other word regular —
 * measured as rendered weight, not markup (raised at review). Red on
 * main: the title is one bold run with no regular
 * words around the name. */
const expectHead = async (page: Page, name: string, sentence: string) => {
  const dialog = page.getByRole("dialog", { name: sentence, exact: true });
  await expect(dialog).toBeVisible();
  const head = await dialog.evaluate(
    (el, { name, sentence }) => {
      const norm = (t: string | null) => (t ?? "").replace(/\s+/g, " ").trim();
      const weight = (n: Element) =>
        parseInt(getComputedStyle(n).fontWeight, 10);
      // The title: the innermost element whose text is the whole
      // sentence and which holds the name as a child run of its own.
      const title = Array.from(el.querySelectorAll("*"))
        .filter((n) => norm(n.textContent) === sentence)
        .pop();
      if (!title) return null;
      const runs = Array.from(title.children).map((c) => ({
        text: norm(c.textContent),
        weight: weight(c),
      }));
      return { titleWeight: weight(title), runs, name };
    },
    { name, sentence },
  );
  expect(head, `a title reading "${sentence}"`).not.toBeNull();
  // The words around the name are regular, and the name alone is bold.
  expect(head!.titleWeight, "the surrounding words are regular").toBeLessThan(600);
  expect(head!.runs.filter((r) => r.weight >= 600).map((r) => r.text)).toEqual([name]);
  return dialog;
};

/** Six spatial identities, seeded independently of any classifier: the
 * tile each must wear is prescribed here. The
 * geometry-column-without-type case rides a null-geometry collection;
 * whether the importer records a column for it is read back and, if it
 * does not, that one case is annotated rather than asserted. */
const seedKinds = async (page: Page, prefix: string) => {
  const line = readFileSync(path.join(FIXTURES_DIR, "paths.geojson"));
  const polygon = readFileSync(path.join(FIXTURES_DIR, "districts.geojson"));
  const mixed = JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { n: 1 },
        geometry: { type: "Point", coordinates: [7.1, 53.5] },
      },
      {
        type: "Feature",
        properties: { n: 2 },
        geometry: {
          type: "LineString",
          coordinates: [
            [7.1, 53.5],
            [7.2, 53.6],
          ],
        },
      },
    ],
  });
  const untyped = JSON.stringify({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { n: 1 }, geometry: null }],
  });
  const names = {
    point: `${prefix}_point_${runId}`,
    line: `${prefix}_line_${runId}`,
    polygon: `${prefix}_polygon_${runId}`,
    mixed: `${prefix}_mixed_${runId}`,
    untyped: `${prefix}_untyped_${runId}`,
    none: `${prefix}_plain_${runId}`,
  };
  await seedCsv(page, names.point, "name,lng,lat\nBuoy,7.10,53.52\n");
  await seedFile(page, `${names.line}.geojson`, line, "application/geo+json");
  await seedFile(
    page,
    `${names.polygon}.geojson`,
    polygon,
    "application/geo+json",
  );
  await seedFile(page, `${names.mixed}.geojson`, mixed, "application/geo+json");
  await seedFile(
    page,
    `${names.untyped}.geojson`,
    untyped,
    "application/geo+json",
  );
  await seedCsv(page, names.none, "name,value\nA,1\nB,2\n");
  return names;
};

/** The prescribed tile per seeded kind; the untyped case only when the
 * importer recorded a geometry column without a sampled type. */
const expectedTiles = async (page: Page, names: Record<string, string>) => {
  const listing = (await api(page, "GET", "/api/tables")) as {
    name: string;
    geometryColumn: string | null;
    geometryType: string | null;
  }[];
  // The sixth identity is asserted, never skipped: the importer records
  // a geometry column with no sampled type for a null-geometry
 // collection (probed), and a seed that came out otherwise
  // is a failing fixture, not a note.
  const untyped = listing.find((t) => t.name === names.untyped);
  expect(untyped, "the untyped seed is registered").toBeDefined();
  expect(
    untyped!.geometryColumn,
    "the untyped seed has a geometry column",
  ).not.toBeNull();
  expect(
    untyped!.geometryType,
    "the untyped seed has no sampled type",
  ).toBeNull();
  const expected: [string, string][] = [
    [names.point, "point"],
    [names.line, "line"],
    [names.polygon, "polygon"],
    [names.mixed, "mixed"],
    [names.none, "none"],
    [names.untyped, "mixed"],
  ];
  return expected;
};

const tableIds = async (page: Page) =>
  new Map(
    (
      (await api(page, "GET", "/api/tables")) as { id: string; name: string }[]
    ).map((t) => [t.name, t.id]),
  );

test("the add-to-project dialog end to end", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");

  let pa = "";
  let pb = "";
  let pc = "";
  let mapId = "";
  let map2Id = "";
  let wfId = "";
  await test.step("seed the criterion-6 world", async () => {
    pa = (
      (await api(page, "POST", "/api/projects", { name: PA })) as { id: string }
    ).id;
    pb = (
      (await api(page, "POST", "/api/projects", { name: PB })) as { id: string }
    ).id;
    pc = (
      (await api(page, "POST", "/api/projects", { name: PC })) as { id: string }
    ).id;
    await seedCsv(page, T_SHARED, "name,lng,lat\nBuoy A,7.10,53.52\n");
    await seedCsv(page, T_PLAIN, "name,lng,lat\nBuoy B,7.22,53.44\n");
    const ids = await tableIds(page);
    // The shared dataset lives in the THIRD project only.
    await api(page, "PATCH", `/api/projects/${pc}/members`, {
      addTables: [ids.get(T_SHARED)!],
    });
    // The producer workflow, filed in PA, with TWO outputs; only one is
    // used by the map.
    wfId = (
      (await api(page, "POST", "/api/recipes", {
        name: WF,
        projectId: pa,
      })) as { recipe: { id: string } }
    ).recipe.id;
    for (const [name, src] of [
      [OUT1, T_SHARED],
      [OUT2, T_PLAIN],
    ] as const) {
      await readThenWriteBrowserSetup(page, `/api/recipes/${wfId}`, () => ({ method: "POST", path: `/api/recipes/${wfId}/steps`, body: {
        operation: "sql_step",
        parameters: { sql: `SELECT * FROM ${src}`, name },
      } })).then(result => result.json);
    }
    // One run-all produces both outputs.
    await readThenWriteBrowserSetup(page, `/api/recipes/${wfId}`, () => ({ method: "POST", path: `/api/recipes/${wfId}/runs` })).then(result => result.json);
    await expect
      .poll(
        async () => {
          const r = (await api(page, "GET", `/api/recipes/${wfId}`)) as {
            recipe: { steps: { output: { name: string } | null }[] };
          };
          return r.recipe.steps.filter((s) => s.output).length;
        },
        { timeout: 60_000 },
      )
      .toBe(2);
    // The map, filed in PA (so the action reads as moving), drawing
    // from the shared dataset, the first output, and a plain dataset
    // that will be UNCHECKED.
    mapId = (
      (await api(page, "POST", "/api/maps", { name: MAP, projectId: pa })) as {
        id: string;
      }
    ).id;
    await readThenWriteBrowserSetup(page, `/api/maps/${mapId}`, () => ({ method: "POST", path: `/api/maps/${mapId}/layers`, body: {
      name: "shared",
      sql: `SELECT * FROM ${T_SHARED}`,
    } }));
    await readThenWriteBrowserSetup(page, `/api/maps/${mapId}`, () => ({ method: "POST", path: `/api/maps/${mapId}/layers`, body: {
      name: "derived",
      sql: `SELECT * FROM ${OUT1}`,
    } }));
    await readThenWriteBrowserSetup(page, `/api/maps/${mapId}`, () => ({ method: "POST", path: `/api/maps/${mapId}/layers`, body: {
      name: "plain",
      sql: `SELECT * FROM ${T_PLAIN}`,
    } }));
    map2Id = (
      (await api(page, "POST", "/api/maps", { name: MAP2 })) as { id: string }
    ).id;
    await readThenWriteBrowserSetup(page, `/api/maps/${map2Id}`, () => ({ method: "POST", path: `/api/maps/${map2Id}/layers`, body: {
      name: "plain",
      sql: `SELECT * FROM ${T_PLAIN}`,
    } }));
  });

  await test.step("the filed map's action reads as moving; the dialog asks and identifies the current project", async () => {
    await page.goto("/maps");
    const card = page.locator("article").filter({ hasText: MAP }).first();
    await card.hover();
    await card
      .getByRole("button", { name: `Move to another project: ${MAP}` })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Move ${MAP} to another project`);
    // The name is the one bold thing; the "move together" line is gone
    // (it was true only for the checked rows, and rows are added).
    await expectHead(page, MAP, `Move ${MAP} to another project`);
    await expect(dialog).not.toContainText("move together");
    // Nothing picked; the confirm is unavailable.
    await expect(
      dialog.getByRole("button", { name: /^Add \d+ item/ }),
    ).toBeDisabled();
    // The current project is identified and unavailable.
    const currentRow = dialog.locator("label").filter({ hasText: PA }).first();
    await expect(currentRow).toContainText("current project");
    await expect(currentRow.getByRole("radio")).toBeDisabled();
  });

  await test.step("the checklist speaks the dependencies read's truth", async () => {
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Datasets it uses");
    await expect(dialog).toContainText(T_SHARED);
    await expect(dialog).toContainText(OUT1);
    await expect(dialog).toContainText(T_PLAIN);
    await expect(dialog).not.toContainText(OUT2);
    // The output names its producer; the producer is picked apart, in its
    // own section with its own box, ticked on open for a map.
    await expect(dialog).toContainText(`made by ${WF}`);
    await expect(dialog).not.toContainText("which comes along");
    const producers = dialog.locator("[data-producers]");
    await expect(producers.locator("label")).toHaveCount(1);
    await expect(producers).toContainText(WF);
    await expect(producers.getByRole("checkbox")).toBeChecked();
    await expect(dialog).toContainText(`also in ${PC}, stays shared`);
    // All selected on open: the footer counts the map, 3 datasets, 1
    // workflow.
    await expect(dialog).toContainText("Map · 3 datasets · 1 workflow");
  });

  await test.step("search keeps the picked row; unchecking updates the counts; the move applies as one change", async () => {
    const dialog = page.getByRole("dialog");
    // Pick PB, then search for something else: the picked row stays.
    await dialog.locator("label").filter({ hasText: PB }).first().click();
    await dialog.getByLabel("Find a project").fill(PC.slice(0, 8));
    await expect(
      dialog.locator("label").filter({ hasText: PB }).first(),
    ).toBeVisible();
    await dialog.getByLabel("Find a project").fill("");
    // Uncheck the plain dataset.
    await dialog
      .locator("label")
      .filter({ hasText: T_PLAIN })
      .first()
      .getByRole("checkbox")
      .uncheck();
    await expect(dialog).toContainText("Map · 2 datasets · 1 workflow");
    const go = dialog.getByRole("button", { name: `Add 4 items to ${PB}` });
    await expect(go).toBeEnabled();
    await go.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The stated outcome and the immediate card truth, no reload.
    await expect(page.getByText(`${MAP} moved to ${PB}.`)).toBeVisible();
    const card = page.locator("article").filter({ hasText: MAP }).first();
    await expect(card).toContainText(PB);
  });

  await test.step("the after-state through the API: single memberships moved, shared kept, unchecked untouched", async () => {
    const map = (await api(page, "GET", `/api/maps/${mapId}`)) as {
      projectId: string | null;
    };
    expect(map.projectId).toBe(pb);
    const wf = (await api(page, "GET", `/api/recipes/${wfId}`)) as {
      recipe: { projectId: string | null };
    };
    expect(wf.recipe.projectId).toBe(pb);
    const tables = (await api(page, "GET", "/api/tables")) as {
      name: string;
      projectIds: string[];
    }[];
    const byName = new Map(tables.map((t) => [t.name, t.projectIds]));
    expect(new Set(byName.get(T_SHARED))).toEqual(new Set([pc, pb]));
    expect(new Set(byName.get(OUT1))).toEqual(new Set([pa, pb]));
    // The unchecked dataset and the producer's other output: untouched.
    expect(byName.get(T_PLAIN)).toEqual([]);
    expect(byName.get(OUT2)).toEqual([pa]);
  });

  await test.step("the New road: Enter on no match carries the name; creation files in one act", async () => {
    await page.goto("/maps");
    const card = page.locator("article").filter({ hasText: MAP2 }).first();
    await card.hover();
    await card
      .getByRole("button", { name: `Add to a project: ${MAP2}` })
      .click();
    // The unfiled map's Add title.
    await expectHead(page, MAP2, `Add ${MAP2} to a project`);
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Find a project").fill(NEWP);
    await page.keyboard.press("Enter");
    // New picked with the typed name carried.
    await expect(dialog.getByLabel("New project name")).toHaveValue(NEWP);
    // The name field keeps the application's focus ring; it suppressed its
    // outline before. A text input matches:focus-visible whenever it has
    // focus, so the computed outline is the measurement (an outline of
    // none, or a zero width, fails). The dataset row's mono name and the
    // kind mark sit on the vocabulary — the label type role (12px) and the
    // radius family (9px) — measured on the rendered checklist, not read
    // from the sheet.
    const dsName = dialog.locator('[class*="dsName"]').first();
    await expect(dsName).toBeVisible();
    expect(await dsName.evaluate((el) => getComputedStyle(el).fontSize)).toBe("12px");
    const dsMark = dialog.locator('[class*="typeTile"]').first();
    await expect(dsMark).toBeVisible();
    expect(await dsMark.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("9px");
    const nameField = dialog.getByLabel("New project name");
    await nameField.focus();
    await expect
      .poll(() =>
        nameField.evaluate((el) => {
          const style = getComputedStyle(el);
          return `${style.outlineStyle} ${style.outlineWidth}`;
        }),
      )
      .toMatch(/^(?!none)\S+ (?!0px)\S+$/);
    const go = dialog.getByRole("button", { name: `Add 2 items to ${NEWP}` });
    await expect(go).toBeEnabled();
    await go.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(`${MAP2} added to ${NEWP}.`)).toBeVisible();
    const projects = (await api(page, "GET", "/api/projects")) as {
      id: string;
      name: string;
      mapCount: number;
      tableCount: number;
    }[];
    const made = projects.find((p) => p.name === NEWP)!;
    expect(made.mapCount).toBe(1);
    expect(made.tableCount).toBe(1);
  });

  await test.step("a refusal keeps the dialog and changes nothing; cancel changes nothing", async () => {
    const doomed = (
      (await api(page, "POST", "/api/projects", {
        name: `Doomed ${runId}`,
      })) as { id: string }
    ).id;
    await page.goto("/maps");
    const card = page.locator("article").filter({ hasText: MAP2 }).first();
    await card.hover();
    await card
      .getByRole("button", { name: `Move to another project: ${MAP2}` })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .locator("label")
      .filter({ hasText: `Doomed ${runId}` })
      .first()
      .click();
    // The destination dies under the open dialog: the confirm refuses,
    // the dialog stays with its selections, nothing changed.
    await api(page, "DELETE", `/api/projects/${doomed}`);
    await dialog.getByRole("button", { name: /^Add \d+ item/ }).click();
    await expect(dialog.getByText(/No project with id/)).toBeVisible();
    await expect(dialog).toBeVisible();
    const map2 = (await api(page, "GET", `/api/maps/${map2Id}`)) as {
      projectId: string | null;
    };
    const newpId = (
      (await api(page, "GET", "/api/projects")) as {
        id: string;
        name: string;
      }[]
    ).find((p) => p.name === NEWP)!.id;
    expect(map2.projectId).toBe(newpId);
    // Escape closes without a change.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const after = (await api(page, "GET", `/api/maps/${map2Id}`)) as {
      projectId: string | null;
    };
    expect(after.projectId).toBe(newpId);
  });

  await test.step("the action opens from the list presentation too", async () => {
    await page.goto("/maps");
    await page.getByRole("button", { name: "List view" }).click();
    const wrap = page
      .locator("div")
      .filter({ has: page.getByRole("button", { name: `Open ${MAP2}` }) })
      .last();
    await wrap.hover();
    await page
      .getByRole("button", { name: `Move to another project: ${MAP2}` })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      `Move ${MAP2} to another project`,
    );
    await page.keyboard.press("Escape");
    // The view preference is workspace-global: restore Grid so no later
    // suite inherits this step's List.
    await page.getByRole("button", { name: "Grid view" }).click();
  });

  await test.step("the checklist wears the app's geometry tile per dataset", async () => {
    // A prefix of its own: "atp_plain" is the journey's T_PLAIN.
    const names = await seedKinds(page, "kinds");
    const map3 = `Kinds map ${runId}`;
    const map3Id = (
      (await api(page, "POST", "/api/maps", { name: map3 })) as { id: string }
    ).id;
    for (const name of Object.values(names)) {
      if (name === names.none) continue;
      await readThenWriteBrowserSetup(page, `/api/maps/${map3Id}`, () => ({ method: "POST", path: `/api/maps/${map3Id}/layers`, body: {
        name,
        sql: `SELECT * FROM ${name}`,
      } })).catch(() => null);
    }
    // A layer cannot sit on a table without geometry; a join reads it,
    // so the dependencies read lists it — and the no-geometry tile shows.
    await readThenWriteBrowserSetup(page, `/api/maps/${map3Id}`, () => ({ method: "POST", path: `/api/maps/${map3Id}/layers`, body: {
      name: "joined",
      sql: `SELECT p.* FROM ${names.point} p JOIN ${names.none} r ON true`,
    } }));
    await page.goto("/maps");
    const card = page.locator("article").filter({ hasText: map3 }).first();
    await card.hover();
    await card
      .getByRole("button", { name: `Add to a project: ${map3}` })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Datasets it uses");
    for (const [name, kind] of await expectedTiles(page, names)) {
      const row = dialog.locator("label").filter({ hasText: name }).first();
      await expect(
        row.locator("[data-kind]"),
        `${name} wears the ${kind} tile`,
      ).toHaveAttribute("data-kind", kind);
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  await test.step("a workflow's card offers the action; its dialog lists exactly what it reads and writes, all selected", async () => {
    // WF is in PB now (it moved with the map). It reads T_SHARED and
    // T_PLAIN and writes OUT1 and OUT2: four datasets, each once.
    await page.goto("/workflows");
    const card = page.locator("article").filter({ hasText: WF }).first();
    await card.hover();
    await card
      .getByRole("button", { name: `Move to another project: ${WF}` })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Move ${WF} to another project`);
    await expectHead(page, WF, `Move ${WF} to another project`);
    await expect(dialog).not.toContainText("move together");
    await expect(dialog).toContainText("Datasets it reads and writes");
    for (const name of [T_SHARED, T_PLAIN, OUT1, OUT2]) {
      await expect(
        dialog.locator("label").filter({ hasText: name }),
      ).toHaveCount(1);
      await expect(
        dialog
          .locator("label")
          .filter({ hasText: name })
          .first()
          .getByRole("checkbox"),
      ).toBeChecked();
    }
    await expect(dialog).toContainText("Workflow · 4 datasets");
    // The workflow never carries producers — not even its own.
    await expect(dialog).not.toContainText("workflow · ");
    const currentRow = dialog.locator("label").filter({ hasText: PB }).first();
    await expect(currentRow.getByRole("radio")).toBeDisabled();
  });

  await test.step("the workflow moves with its selected datasets; an unselected one keeps exactly its memberships", async () => {
    const dialog = page.getByRole("dialog");
    await dialog.locator("label").filter({ hasText: PC }).first().click();
    await dialog
      .locator("label")
      .filter({ hasText: OUT2 })
      .first()
      .getByRole("checkbox")
      .uncheck();
    await expect(dialog).toContainText("Workflow · 3 datasets");
    const go = dialog.getByRole("button", { name: `Add 4 items to ${PC}` });
    await expect(go).toBeEnabled();
    await go.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(`${WF} moved to ${PC}.`)).toBeVisible();
    // The immediate card truth, no reload: the tag names the
    // destination before the reconciling read answers.
    await expect(
      page.locator("article").filter({ hasText: WF }).first(),
    ).toContainText(PC);
    const wf = (await api(page, "GET", `/api/recipes/${wfId}`)) as {
      recipe: { projectId: string | null };
    };
    expect(wf.recipe.projectId).toBe(pc);
    const tables = (await api(page, "GET", "/api/tables")) as {
      name: string;
      projectIds: string[];
    }[];
    const byName = new Map(tables.map((t) => [t.name, t.projectIds]));
    // T_PLAIN joined NEWP with MAP2 on the New road above; it keeps that.
    const newpId = (
      (await api(page, "GET", "/api/projects")) as {
        id: string;
        name: string;
      }[]
    ).find((p) => p.name === NEWP)!.id;
    // Selected: gained PC, kept the rest. Unselected OUT2: exactly PA.
    expect(new Set(byName.get(T_SHARED))).toEqual(new Set([pc, pb]));
    expect(new Set(byName.get(OUT1))).toEqual(new Set([pa, pb, pc]));
    expect(new Set(byName.get(T_PLAIN))).toEqual(new Set([newpId, pc]));
    expect(byName.get(OUT2)).toEqual([pa]);
  });

  await test.step("a workflow's row offers it too; a destination that dies refuses and changes nothing", async () => {
    await page.getByRole("button", { name: "List view" }).click();
    const wrap = page
      .locator("div")
      .filter({ has: page.getByRole("button", { name: `Open ${WF}` }) })
      .last();
    await wrap.hover();
    await page
      .getByRole("button", { name: `Move to another project: ${WF}` })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Move ${WF} to another project`);
    const doomed = (
      (await api(page, "POST", "/api/projects", {
        name: `Doomed wf ${runId}`,
      })) as { id: string }
    ).id;
    // The dialog read the projects before the doomed one existed; a
    // fresh open sees it.
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: `Move to another project: ${WF}` })
      .first()
      .click();
    await page
      .getByRole("dialog")
      .locator("label")
      .filter({ hasText: `Doomed wf ${runId}` })
      .first()
      .click();
    await api(page, "DELETE", `/api/projects/${doomed}`);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Add \d+ item/ })
      .click();
    await expect(
      page.getByRole("dialog").getByText(/No project with id/),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    const wf = (await api(page, "GET", `/api/recipes/${wfId}`)) as {
      recipe: { projectId: string | null };
    };
    expect(wf.recipe.projectId).toBe(pc);
    await page.getByRole("button", { name: "Grid view" }).click();
  });

  await test.step("a dataset's card and row offer Add, never Move; it is added alone and keeps every membership", async () => {
    // T_PLAIN is in PC (it moved with the workflow). Add it to PA from
    // the Data Explorer: no checklist, one membership gained, PC kept.
    await page.goto("/data");
    const card = page.locator("article").filter({ hasText: T_PLAIN }).first();
    await card.hover();
    await card
      .getByRole("button", { name: `Add to a project: ${T_PLAIN}` })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Add ${T_PLAIN} to a project`);
    await expectHead(page, T_PLAIN, `Add ${T_PLAIN} to a project`);
    // The dataset keeps its line: always true, and it names the
    // add-never-move surprise.
    await expect(dialog).toContainText(
      "A dataset can be in several projects. It stays in the ones it is in.",
    );
    await expect(dialog).not.toContainText("Datasets it");
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    // The project it is already in is not offered as a destination.
    await expect(
      dialog
        .locator("label")
        .filter({ hasText: PC })
        .first()
        .getByRole("radio"),
    ).toBeDisabled();
    await dialog.locator("label").filter({ hasText: PA }).first().click();
    await expect(dialog).toContainText("Dataset");
    const go = dialog.getByRole("button", { name: `Add to ${PA}` });
    await expect(go).toBeEnabled();
    await go.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(`${T_PLAIN} added to ${PA}.`)).toBeVisible();
    // A Data card carries no project tag (tags maps); a dataset's
    // immediate truth is the scoped list, held by the API read below.
    const tables = (await api(page, "GET", "/api/tables")) as {
      name: string;
      projectIds: string[];
    }[];
    const newpId = (
      (await api(page, "GET", "/api/projects")) as {
        id: string;
        name: string;
      }[]
    ).find((p) => p.name === NEWP)!.id;
    expect(new Set(tables.find((t) => t.name === T_PLAIN)!.projectIds)).toEqual(
      new Set([newpId, pc, pa]),
    );
    // The list row offers it too; a nested row inside the workflow's
    // folder gets it (the same row component) and opens the right
    // subject; the folder's own row carries no filing action. The view
    // preference is workspace-global: Grid is restored whatever happens
    // (the lesson — a failed step leaked List into the next test).
    await page.getByRole("button", { name: "List view" }).click();
    try {
      const looseRow = page.locator(`[data-table-row="${T_PLAIN}"]`);
      await looseRow.hover();
      await expect(
        page
          .getByRole("button", { name: `Add to a project: ${T_PLAIN}` })
          .first(),
      ).toBeVisible();
      // The workflow's folder: unfold it, then its nested output row.
      await page
        .getByRole("button", { name: new RegExp(`${WF}, workflow`) })
        .click();
      const nested = page.locator(`[data-table-row="${OUT1}"]`);
      await expect(nested).toBeVisible();
      await nested.hover();
      await page
        .getByRole("button", { name: `Add to a project: ${OUT1}` })
        .click();
      await expect(page.getByRole("dialog")).toContainText(
        `Add ${OUT1} to a project`,
      );
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: new RegExp(`project: ${WF}$`) }),
      ).toHaveCount(0);
    } finally {
      await page.getByRole("button", { name: "Grid view" }).click();
    }
  });

  await test.step("the New road for a dataset files it in one act, memberships kept", async () => {
    const newp = `Dataset shelf ${runId}`;
    await page.goto("/data");
    const card = page.locator("article").filter({ hasText: T_PLAIN }).first();
    await card.hover();
    await card
      .getByRole("button", { name: `Add to a project: ${T_PLAIN}` })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Find a project").fill(newp);
    await page.keyboard.press("Enter");
    await expect(dialog.getByLabel("New project name")).toHaveValue(newp);
    await dialog.getByRole("button", { name: `Add to ${newp}` }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const projects = (await api(page, "GET", "/api/projects")) as {
      id: string;
      name: string;
      tableCount: number;
    }[];
    const made = projects.find((p) => p.name === newp)!;
    expect(made.tableCount).toBe(1);
    const tables = (await api(page, "GET", "/api/tables")) as {
      name: string;
      projectIds: string[];
    }[];
    const newpId = (
      (await api(page, "GET", "/api/projects")) as {
        id: string;
        name: string;
      }[]
    ).find((p) => p.name === NEWP)!.id;
    expect(new Set(tables.find((t) => t.name === T_PLAIN)!.projectIds)).toEqual(
      new Set([newpId, pc, pa, made.id]),
    );
  });
});

// The two entry points as their own tests, so their red stands beside
// the tiles' rather than behind it (one failure ends a test).
test("a workflow's card offers the add-to-project action", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/workflows");
  // The view preference is workspace-global: take Grid explicitly.
  await page.getByRole("button", { name: "Grid view" }).click();
  const name = `Entry workflow ${runId}`;
  const id = (
    (await api(page, "POST", "/api/recipes", { name })) as {
      recipe: { id: string };
    }
  ).recipe.id;
  try {
    await page.reload();
    const card = page.locator("article").filter({ hasText: name }).first();
    await card.hover();
    await card
      .getByRole("button", { name: `Add to a project: ${name}` })
      .click();
    await expectHead(page, name, `Add ${name} to a project`);
    await expect(page.getByRole("dialog")).not.toContainText("move together");
    await page.keyboard.press("Escape");
  } finally {
    await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "DELETE", path: `/api/recipes/${id}` })).then(result => result.json).catch(() => {});
  }
});

test("a dataset's card offers the add-to-project action, never a move", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/data");
  // The view preference is workspace-global: take Grid explicitly.
  await page.getByRole("button", { name: "Grid view" }).click();
  const name = `atp_entry_${runId}`;
  await seedCsv(page, name, "name,lng,lat\nBuoy,7.10,53.52\n");
  try {
    await page.reload();
    const card = page.locator("article").filter({ hasText: name }).first();
    await card.hover();
    await card
      .getByRole("button", { name: `Add to a project: ${name}` })
      .click();
    await expectHead(page, name, `Add ${name} to a project`);
    await expect(page.getByRole("dialog")).not.toContainText("Move");
    await page.keyboard.press("Escape");
  } finally {
    await api(page, "DELETE", `/api/tables/${name}`).catch(() => {});
  }
});
