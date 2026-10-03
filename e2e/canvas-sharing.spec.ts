import { readThenWriteRequestSetup } from "./edit-basis";
// An Editor's own dataset on the owner's workflow: Ada's workflow reads her
// `roads` by its plain name; Bo, an Editor of the project, owns a `roads` of
// his own. On her canvas the pane lists both apart, marks only hers as on
// the canvas, and adding his writes it in her home as his, qualified with
// his SQL name, so it never becomes a second reference to hers. Run against
// a fresh scratch instance.
import { test, expect } from "@playwright/test";
import { routeHouse } from "./support";
import { closeAll, createProject, invitePerson, runTag, share, uploadSentinel, type Person } from "./sharing-support";

test("an Editor's own same-named dataset lands on the owner's workflow as theirs", async ({ browser, request, baseURL }) => {
  test.setTimeout(240_000);
  const tag = runTag();
  const people: Person[] = [];
  try {
    const [ada, bo] = await Promise.all(["Ada", "Bo"].map((first) => invitePerson(browser, request, baseURL!, first, tag)));
    people.push(ada, bo);
    const roads = `roads_${tag}`;
    const hers = await uploadSentinel(ada, roads, "ada_roads");
    // His has two rows, hers one: the rows tell themselves apart by their count too.
    const uploaded = await bo.api.post("/api/tables", { multipart: { file: {
      name: `${roads}.csv`, mimeType: "text/csv", buffer: Buffer.from("sentinel,lon,lat\nbo_a,13.4,52.5\nbo_b,13.5,52.6\n"),
    } } });
    expect(uploaded.status()).toBe(201);
    const recipe = (await (await ada.api.post("/api/recipes", { data: { name: `Staging ${tag}` } })).json()).recipe.id as string;
    const step = await readThenWriteRequestSetup(ada.api, `/api/recipes/${recipe}`, () => ({ method: "POST", path: `/api/recipes/${recipe}/steps`, options: { data: { operation: "sql_step", parameters: { name: `staged_${tag}`, sql: `SELECT * FROM ${roads}` } } } }));
    expect(step.status()).toBe(201);
    const projectId = await createProject(ada, `Staging ${tag}`, { addRecipes: [recipe], addTables: [hers.id] });
    await share(ada, projectId, bo, "editor");
    await routeHouse(bo.context, { basemapStyleStub: true });

    const page = await bo.context.newPage();
    await page.goto(`/workflows/${recipe}`);
    const pane = page.locator("[data-canvas-pane]");
    await expect(pane).toBeVisible({ timeout: 30_000 });

    await test.step("his own is offered to add, by the name he types, with its own count", async () => {
      const his = pane.getByRole("button", { name: `Add ${roads} to the canvas`, exact: true });
      await expect(his).toBeVisible();
      await expect(his).toContainText("2");
    });

    await test.step("hers is the one on the canvas, typed as he types it", async () => {
      await expect(pane.getByRole("button", { name: `ada_${tag}.${roads}, on canvas: centre the view on it`, exact: true })).toBeVisible();
    });

    await test.step("adding his writes it in her home as his, never as hers", async () => {
      await pane.getByRole("button", { name: `Add ${roads} to the canvas`, exact: true }).click();
      // As she reads it: no layout is written until the first placement lands.
      const sources = async () => {
        const read = (await (await ada.api.get(`/api/recipes/${recipe}/layout`)).json()) as { layout?: { sources?: Record<string, unknown> } };
        return Object.keys(read.layout?.sources ?? {});
      };
      await expect.poll(sources, { timeout: 15_000 }).toContain(`bo_${tag}.${roads}`);
      // The layout keeps every source's position: hers by the plain name her
      // step reads, his qualified, and nothing else.
      expect((await sources()).sort()).toEqual([`bo_${tag}.${roads}`, roads].sort());
      // Two tiles on the canvas, each drawing its own dataset's rows.
      const canvas = page.getByRole("application", { name: "Workflow canvas" });
      await expect(canvas.getByRole("group", { name: `bo_${tag}.${roads}, source table`, exact: true })).toContainText("2 rows");
      await expect(canvas.getByRole("group", { name: `${roads}, source table`, exact: true })).toContainText("1 rows");
      await expect(pane.getByRole("button", { name: `${roads}, on canvas: centre the view on it`, exact: true })).toBeVisible();
      await expect(pane.getByRole("button", { name: `ada_${tag}.${roads}, on canvas: centre the view on it`, exact: true })).toBeVisible();
    });
    await page.close();
  } finally {
    await closeAll(people);
  }
});
