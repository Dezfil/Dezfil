// The 16-C project export: the three openers, the two steps' exact
// forms, the review tree with its display-only truncation, the
// prepare-then-redeem download, and the archive's truth re-proven end
// to end — the entry list against independently authored expectations,
// the manifest, the pre-request artifact digest, and the seeded publish
// token absent from every JSON entry (the system unzip is the journey's
// independent reader). Refusal keeps the dialog's step, selection and
// file name. Residue-proof: every assertion is about this run's seeded
// objects.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FIXTURES_DIR, routeHouse, seedCsv, seedFile } from "./support";

const runId = Date.now().toString(36);
const PE = `Export shelf ${runId}`;
const PB = `Beta shelf ${runId}`;
const PC = `Gamma shelf ${runId}`;
const MAP1 = `Transit map ${runId}`;
const WF = `Catchments ${runId}`;
const T_A = `ep_a_${runId}`;
const T_SHARED = `ep_shared_${runId}`;
const T_B = `ep_b_${runId}`;
const T_LEFT = `ep_left_${runId}`;
const OUT = `ep_out_${runId}`;

const CSV = "name,lng,lat\nBuoy,7.10,53.52\n";

const api = (page: Page, method: string, pathName: string, body?: unknown) =>
  page.evaluate(
    async ({ method, pathName, body }) => {
      const r = await fetch(pathName, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok && r.status !== 204) throw new Error(await r.text());
      const text = r.status === 204 ? "" : await r.text();
      return text ? (JSON.parse(text) as unknown) : null;
    },
    { method, pathName, body },
  );

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

const sha256hex = async (page: Page, url: string) =>
  page.evaluate(async (u) => {
    const bytes = await (await fetch(u)).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }, url);

test("the 16-C export end to end", async ({ page, context }) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/projects");

  let pe = "";
  await test.step("seed the world", async () => {
    pe = (
      (await api(page, "POST", "/api/projects", { name: PE })) as { id: string }
    ).id;
    const pb = (
      (await api(page, "POST", "/api/projects", { name: PB })) as { id: string }
    ).id;
    const pc = (
      (await api(page, "POST", "/api/projects", { name: PC })) as { id: string }
    ).id;
    for (const name of [T_A, T_SHARED, T_B, T_LEFT]) {
      await seedCsv(page, name, CSV);
    }
    const ids = await tableIds(page);
    await api(page, "PATCH", `/api/projects/${pe}/members`, {
      addTables: [T_A, T_SHARED, T_B, T_LEFT].map((n) => ids.get(n)!),
    });
    // The multi-membership dataset: two OTHER projects (the recorded
    // reference difference the sub-line must exercise).
    await api(page, "PATCH", `/api/projects/${pb}/members`, {
      addTables: [ids.get(T_SHARED)!],
    });
    await api(page, "PATCH", `/api/projects/${pc}/members`, {
      addTables: [ids.get(T_SHARED)!],
    });
    // The published map, with two layers.
    const m1 = (
      (await api(page, "POST", "/api/maps", { name: MAP1, projectId: pe })) as {
        id: string;
      }
    ).id;
    for (const [layer, src] of [
      ["alpha", T_A],
      ["beta", T_SHARED],
    ] as const) {
      await api(page, "POST", `/api/maps/${m1}/layers`, {
        name: layer,
        sql: `SELECT * FROM ${src}`,
      });
    }
    await api(page, "POST", `/api/maps/${m1}/publish`);
    // The same-named second map: the collision case.
    await api(page, "POST", "/api/maps", { name: MAP1, projectId: pe });
    // The workflow, filed in PE; its run's output joins PE at commit.
    const wf = (
      (await api(page, "POST", "/api/recipes", {
        name: WF,
        projectId: pe,
      })) as { recipe: { id: string } }
    ).recipe.id;
    await api(page, "POST", `/api/recipes/${wf}/steps`, {
      operation: "sql_step",
      parameters: { sql: `SELECT * FROM ${T_A}`, name: OUT },
    });
    await api(page, "POST", `/api/recipes/${wf}/runs`);
    await expect
      .poll(
        async () =>
          (
            (await api(page, "GET", `/api/recipes/${wf}`)) as {
              recipe: { steps: { output: unknown | null }[] };
            }
          ).recipe.steps.filter((s) => s.output).length,
        { timeout: 60_000 },
      )
      .toBe(1);
  });

  const dialog = page.getByRole("dialog", { name: `Export ${PE}` });

  await test.step("the grid opener, the facts, and Escape", async () => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "Grid view", exact: true }).click();
    await page.getByRole("button", { name: `Export ${PE}` }).click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(
        "Opens on any Dezfil. Datasets as GeoParquet, maps and workflows as JSON.",
      ),
    ).toBeVisible();
    // Everything selected on open; the exact footer form (5 datasets:
    // the four seeded plus the run's output).
    await expect(dialog.getByRole("status")).toHaveText(
      /^2 maps · 1 workflow · 5 datasets · /,
    );
    // Row facts: the published map, the node count, the sub-lines.
    await expect(dialog.getByText("2 layers · published")).toBeVisible();
    await expect(dialog.getByText("1 node")).toBeVisible();
    await expect(
      dialog.getByText(`also in ${PB}, ${PC}, included as a copy`),
    ).toBeVisible();
    await expect(
      dialog.getByText("a result; its workflow makes it again"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  await test.step("the list opener, gating at zero, and Cancel on step 1 only", async () => {
    await page.getByRole("button", { name: "List view", exact: true }).click();
    await page.getByRole("button", { name: `Export ${PE}` }).click();
    await expect(dialog).toBeVisible();
    // None everywhere → "Nothing chosen", Next disabled, Review inert.
    for (let i = 0; i < 3; i++) {
      await dialog.getByRole("button", { name: "None" }).nth(i).click();
    }
    await expect(dialog.getByRole("status")).toHaveText("Nothing chosen");
    await expect(dialog.getByRole("button", { name: "Next" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Review" }).click();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
    // Reopening resets to everything selected (transient state).
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: `Export ${PE}` }).click();
    await expect(dialog.getByRole("status")).toHaveText(
      /^2 maps · 1 workflow · 5 datasets · /,
    );
    // Step 2 offers Back and Download, no Cancel (the reference).
    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Back" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  await test.step("the home opener: the full flow to a verified archive", async () => {
    await page.goto(`/projects/${pe}`);
    await page.getByRole("button", { name: "Export project" }).click();
    await expect(dialog).toBeVisible();

    // Leave one dataset out; the smalls and footer follow live.
    await dialog.getByRole("checkbox").last().waitFor();
    await dialog
      .locator("label", { hasText: T_LEFT })
      .getByRole("checkbox")
      .uncheck();
    await expect(dialog.getByText("4 of 5", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("status")).toHaveText(
      /^2 maps · 1 workflow · 4 datasets · /,
    );

    await dialog.getByRole("button", { name: "Next" }).click();
    // The tree: the default root from the project's name, both
    // same-named maps as distinct files, and EVERY chosen dataset by
    // name (the left-out one absent, no summary row).
    const slug = PE.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await expect(dialog.getByText(`${slug}.dezfil/`)).toBeVisible();
    await expect(dialog.getByText(`transit-map-${runId}.json`)).toBeVisible();
    await expect(dialog.getByText(`transit-map-${runId}-2.json`)).toBeVisible();
    for (const name of [T_A, T_SHARED, T_B, OUT]) {
      await expect(dialog.getByText(`${name}.parquet`)).toBeAttached();
    }
    await expect(dialog.getByText(`${T_LEFT}.parquet`)).toHaveCount(0);
    await expect(dialog.getByText(/\d+ more$/)).toHaveCount(0);
    await expect(
      dialog.getByText("Not included:", { exact: false }),
    ).toBeVisible();
    await expect(dialog.getByText("Left out: 1 dataset")).toBeVisible();

    // The typed name follows into the tree live.
    const fileField = dialog.getByRole("textbox");
    await fileField.fill(`  Harbor Study ${runId}! `);
    await expect(
      dialog.getByText(`harbor-study-${runId}.dezfil/`),
    ).toBeVisible();

    // The pre-request digest of a chosen artifact, through the
    // documented byte-identical dataset export.
    const digestBefore = await sha256hex(
      page,
      `/api/tables/${encodeURIComponent(T_A)}/export?format=geoparquet`,
    );

    const downloadEvent = page.waitForEvent("download");
    await dialog.getByRole("button", { name: /^Download / }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(`harbor-study-${runId}.zip`);
    const zipPath = await download.path();

    // The dialog closed; the host owns the outcome notice.
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(
      `harbor-study-${runId}.zip ·`,
    );

    // The independent reader: the system unzip lists and extracts.
    const root = `harbor-study-${runId}.dezfil`;
    const listing = execFileSync("unzip", ["-Z1", zipPath], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter((l) => !l.endsWith("/"))
      .sort();
    expect(listing).toEqual(
      [
        `${root}/project.json`,
        `${root}/maps/transit-map-${runId}.json`,
        `${root}/maps/transit-map-${runId}-2.json`,
        `${root}/workflows/catchments-${runId}.json`,
        `${root}/datasets/${T_A}.parquet`,
        `${root}/datasets/${T_SHARED}.parquet`,
        `${root}/datasets/${T_B}.parquet`,
        `${root}/datasets/${OUT}.parquet`,
      ].sort(),
    );

    const entry = (name: string) =>
      execFileSync("unzip", ["-p", zipPath, `${root}/${name}`], {
        encoding: "buffer",
      }) as unknown as Buffer;
    const manifest = JSON.parse(entry("project.json").toString("utf8"));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.project.name).toBe(PE);
    expect(manifest.contents.maps).toHaveLength(2);
    expect(
      manifest.contents.datasets.map((d: { name: string }) => d.name),
    ).not.toContain(T_LEFT);

    // The review-to-archive tie: the archive holds exactly the chosen
    // counts the review stated (truncation was display-only).
    expect(manifest.contents.workflows).toHaveLength(1);
    expect(manifest.contents.datasets).toHaveLength(4);

    // The seeded publish token appears in NO JSON entry; the published
    // map's document carries no publication state.
    const published = JSON.parse(
      entry(`maps/transit-map-${runId}.json`).toString("utf8"),
    );
    expect(published.publishToken).toBeUndefined();
    expect(published.publishedAt).toBeUndefined();
    const token = (
      (await api(page, "GET", "/api/maps")) as {
        name: string;
        publishToken?: string | null;
      }[]
    ).find((m) => m.name === MAP1 && m.publishToken)?.publishToken;
    expect(token).toBeTruthy();
    for (const jsonEntry of listing.filter((l) => l.endsWith(".json"))) {
      const text = execFileSync("unzip", ["-p", zipPath, jsonEntry], {
        encoding: "utf8",
      });
      expect(text).not.toContain(String(token));
    }

    // The workflow document: the layout annex present, no runs.
    const workflow = JSON.parse(
      entry(`workflows/catchments-${runId}.json`).toString("utf8"),
    );
    expect(workflow.layout).toBeDefined();
    expect(JSON.stringify(workflow)).not.toContain("latestAttempt");

    // Byte identity against the pre-request digest.
    const bytes = entry(`datasets/${T_A}.parquet`);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digestBefore);

    // The archive really is a zip by the reader's own verdict.
    execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
  });

  await test.step("a refusal keeps the step, the selection and the name", async () => {
    const pd = (
      (await api(page, "POST", "/api/projects", {
        name: `Doomed shelf ${runId}`,
      })) as { id: string }
    ).id;
    await api(page, "POST", "/api/maps", {
      name: `Doomed map ${runId}`,
      projectId: pd,
    });
    await page.goto(`/projects/${pd}`);
    await page.getByRole("button", { name: "Export project" }).click();
    const d2 = page.getByRole("dialog", { name: /^Export Doomed shelf/ });
    await expect(d2).toBeVisible();
    await d2.getByRole("button", { name: "Next" }).click();
    await d2.getByRole("textbox").fill("doomed");
    await api(page, "DELETE", `/api/projects/${pd}`);
    await d2.getByRole("button", { name: /^Download / }).click();
    // The server's sentence, the dialog still on review, the name kept.
    await expect(d2.getByText(/No project with id/)).toBeVisible();
    await expect(d2.getByRole("button", { name: "Back" })).toBeVisible();
    await expect(d2.getByRole("textbox")).toHaveValue("doomed");
    await page.keyboard.press("Escape");
  });

  await test.step("the contents step wears the app's geometry tile per dataset", async () => {
    const names = await seedKinds(page, "epk");
    const pk = (
      (await api(page, "POST", "/api/projects", {
        name: `Kinds ${runId}`,
      })) as { id: string }
    ).id;
    const ids = await tableIds(page);
    await api(page, "PATCH", `/api/projects/${pk}/members`, {
      addTables: Object.values(names)
        .map((n) => ids.get(n))
        .filter(Boolean),
    });
    await page.goto(`/projects/${pk}`);
    await page.getByRole("button", { name: "Export project" }).click();
    const d = page.getByRole("dialog");
    await expect(d).toBeVisible();
    await d.getByRole("checkbox").last().waitFor();
    for (const [name, kind] of await expectedTiles(page, names)) {
      const row = d.locator("label").filter({ hasText: name }).first();
      await expect(
        row.locator("[data-kind]"),
        `${name} wears the ${kind} tile`,
      ).toHaveAttribute("data-kind", kind);
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test("the review lists every file in a scrolling frame, and one dataset format for the whole export", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/projects");
  const pkName = `Many kinds ${runId}`;
  const pk = (
    (await api(page, "POST", "/api/projects", { name: pkName })) as {
      id: string;
    }
  ).id;
  const names = await seedKinds(page, "many");
  const many: string[] = [];
  for (let i = 1; i <= 12; i += 1) {
    const name = `many_${String(i).padStart(2, "0")}_${runId}`;
    await seedCsv(page, name, `name,lng,lat\nBuoy ${i},7.1${i},53.5\n`);
    many.push(name);
  }
  const ids = await tableIds(page);
  await api(page, "PATCH", `/api/projects/${pk}/members`, {
    addTables: [...Object.values(names), ...many]
      .map((n) => ids.get(n))
      .filter(Boolean),
  });
  await page.goto(`/projects/${pk}`);
  await page.getByRole("button", { name: "Export project" }).click();
  const d = page.getByRole("dialog", { name: `Export ${pkName}` });
  await expect(d).toBeVisible();
  await d.getByRole("checkbox").last().waitFor();
  await d.getByRole("button", { name: "Next" }).click();

  await test.step("every file is named; the frame scrolls; the dialog stays within the viewport", async () => {
    const tree = d.locator("[data-tree]");
    const first = d.getByText(`${many[0]}.parquet`);
    const last = d.getByText(`${many[11]}.parquet`);
    await expect(first).toBeAttached();
    await expect(last).toBeAttached();
    await expect(d.getByText(/\d+ more$/)).toHaveCount(0);
    const scrolls = await tree.evaluate(
      (el) => el.scrollHeight > el.clientHeight,
    );
    expect(scrolls, "the file list scrolls inside its frame").toBe(true);
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeVisible();
    await first.scrollIntoViewIfNeeded();
    await expect(first).toBeVisible();
    const box = (await d.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  });

  await test.step("the format choice: GeoParquet by default with the stored size; GeoJSON changes the subtitle and every extension, the non-spatial one to .csv, and claims no size", async () => {
    const format = d.getByLabel("Dataset format");
    await expect(format).toHaveValue("geoparquet");
    await expect(d.getByText(/Datasets as GeoParquet/)).toBeVisible();
    await expect(d.getByRole("button", { name: /^Download \S/ })).toBeVisible();
    await format.selectOption("geojson");
    await expect(d.getByText(/Datasets as GeoJSON/)).toBeVisible();
    await expect(d.getByText(`${names.point}.geojson`)).toBeAttached();
    await expect(d.getByText(`${names.none}.csv`)).toBeAttached();
    await expect(d.getByText(`${names.point}.parquet`)).toHaveCount(0);
    await expect(
      d.getByRole("button", { name: "Download", exact: true }),
    ).toBeVisible();
    await expect(d.getByRole("status")).not.toContainText(/ · \S+B$/);
  });

  await test.step("the GeoJSON archive, read by the system unzip: real extensions, parseable GeoJSON, the manifest's effective formats", async () => {
    await d.getByRole("textbox").fill(`kinds-${runId}`);
    const downloadEvent = page.waitForEvent("download");
    await d.getByRole("button", { name: "Download", exact: true }).click();
    const download = await downloadEvent;
    const zipPath = await download.path();
    const root = `kinds-${runId}.dezfil`;
    const listing = execFileSync("unzip", ["-Z1", zipPath], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter((l) => !l.endsWith("/"));
    expect(listing).toContain(`${root}/datasets/${names.point}.geojson`);
    expect(listing).toContain(`${root}/datasets/${names.none}.csv`);
    expect(listing.some((l) => l.endsWith(".parquet"))).toBe(false);
    const entry = (name: string) =>
      execFileSync("unzip", ["-p", zipPath, `${root}/${name}`], {
        encoding: "utf8",
      });
    const geojson = JSON.parse(entry(`datasets/${names.point}.geojson`)) as {
      type: string;
    };
    expect(geojson.type).toBe("FeatureCollection");
    const manifest = JSON.parse(entry("project.json")) as {
      formatVersion: number;
      contents: { datasets: { name: string; format: string }[] };
    };
    expect(manifest.formatVersion).toBe(1);
    const formats = new Map(
      manifest.contents.datasets.map((x) => [x.name, x.format]),
    );
    expect(formats.get(names.point)).toBe("geojson");
    expect(formats.get(names.none)).toBe("csv");
  });

  await test.step("CSV carries geometry as WKT", async () => {
    await page.goto(`/projects/${pk}`);
    await page.getByRole("button", { name: "Export project" }).click();
    await d.getByRole("checkbox").last().waitFor();
    await d.getByRole("button", { name: "Next" }).click();
    await d.getByLabel("Dataset format").selectOption("csv");
    await expect(d.getByText(`${names.point}.csv`)).toBeAttached();
    await d.getByRole("textbox").fill(`kinds-csv-${runId}`);
    const downloadEvent = page.waitForEvent("download");
    await d.getByRole("button", { name: "Download", exact: true }).click();
    const zipPath = await (await downloadEvent).path();
    const csv = execFileSync(
      "unzip",
      [
        "-p",
        zipPath,
        `kinds-csv-${runId}.dezfil/datasets/${names.point}.csv`,
      ],
      { encoding: "utf8" },
    );
    expect(csv).toMatch(/POINT \(/);
  });
});
