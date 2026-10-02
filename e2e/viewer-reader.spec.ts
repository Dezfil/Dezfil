import { readThenWriteRequestSetup } from "./edit-basis";
// A Viewer's map and workflow: the map opens in the reader inside the
// workspace shell, with the map, legend and widgets and nothing that edits,
// and no shortcut writes anything; a layer reading a dataset the Viewer
// cannot reach fails in the shipped failure note with the product's own
// sentence; the workflow opens on the drawn view-only canvas with no unlock
// and no run. An Editor of the same project gets the builder and the canvas
// that edit, which is what makes the Viewer's absences mean something. Run
// against a fresh scratch instance.
import { test, expect, type Page, type Request } from "@playwright/test";
import { routeHouse } from "./support";
import { closeAll, createMapWithLayer, createProject, invitePerson, NOT_FOUND, PERMISSION, runTag, share, uploadSentinel, type Person } from "./sharing-support";

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Every request the page sends that could change something on the server. */
function writesOf(page: Page): Request[] {
  const seen: Request[] = [];
  page.on("request", (r) => {
    if (WRITES.has(r.method()) && new URL(r.url()).pathname.startsWith("/api/")) seen.push(r);
  });
  return seen;
}

test("a Viewer reads the shared map and workflow and can change nothing", async ({ browser, request, baseURL }) => {
  test.setTimeout(240_000);
  const tag = runTag();
  const people: Person[] = [];
  try {
    const [ada, eli, vic, nia] = await Promise.all(["Ada", "Eli", "Vic", "Nia"].map((first) => invitePerson(browser, request, baseURL!, first, tag)));
    people.push(ada, eli, vic, nia);
    const roads = await uploadSentinel(ada, `roads_${tag}`, "ada_roads");
    await uploadSentinel(ada, `parks_${tag}`, "ada_parks");
    const mapName = `Survey map ${tag}`;
    const map = await createMapWithLayer(ada, mapName, [
      { name: "Roads", sql: `SELECT * FROM roads_${tag}` },
      { name: "Parks", sql: `SELECT * FROM parks_${tag}` },
    ]);
    const recipe = (await (await ada.api.post("/api/recipes", { data: { name: `Staging ${tag}` } })).json()).recipe.id as string;
    expect((await readThenWriteRequestSetup(ada.api, `/api/recipes/${recipe}`, () => ({ method: "POST", path: `/api/recipes/${recipe}/steps`, options: { data: { operation: "sql_step", parameters: { name: `staged_${tag}`, sql: `SELECT * FROM roads_${tag}` } } } }))).status()).toBe(201);
    const projectId = await createProject(ada, `Survey ${tag}`, { addMaps: [map.id], addRecipes: [recipe], addTables: [roads.id] });
    await share(ada, projectId, vic, "viewer");
    await share(ada, projectId, eli, "editor");
    for (const person of [vic, eli]) await routeHouse(person.context, { basemapStyleStub: true });

    await test.step("an Editor opens the map in the builder, with its undo and its name to edit", async () => {
      const page = await eli.context.newPage();
      await page.goto(`/maps/${map.id}`);
      await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: mapName, exact: true })).toBeVisible();
      await page.close();
    });

    await test.step("a Viewer opens the map in the reader: its name and owner, nothing that edits", async () => {
      const page = await vic.context.newPage();
      const writes = writesOf(page);
      const before = await (await ada.api.get(`/api/maps/${map.id}`)).json();
      const history = await (await ada.api.get(`/api/maps/${map.id}/history`)).json();
      await page.goto(`/maps/${map.id}`);
      await expect(page.getByRole("button", { name: "Fit to data", exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("img", { name: `Shared by ${ada.name}`, exact: true })).toBeVisible();
      for (const name of ["Undo", "Redo", "Preview", "Publish", "Published", mapName]) {
        await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
      }
      await expect(page.getByRole("textbox", { name: "Map name" })).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "Layer name" })).toHaveCount(0);

      // The missing-dataset note: the layer reading an unfiled dataset fails
      // with the product's own sentence, the drawn one does not.
      await expect(page.getByText(`Parks: The dataset "parks_${tag}" is not available to you.`, { exact: true })).toBeVisible();
      await expect(page.getByText(/^Roads: /)).toHaveCount(0);

      // No shortcut saves anything: the builder's keys pressed on the stage
      // and the page send no write, and the map is as it was.
      await page.getByRole("button", { name: "Fit to data", exact: true }).focus();
      await page.locator("body").click({ position: { x: 600, y: 400 } });
      for (const key of ["ControlOrMeta+z", "ControlOrMeta+Shift+z", "ControlOrMeta+y", "ControlOrMeta+s", "Delete", "Backspace", "ControlOrMeta+d"]) {
        await page.keyboard.press(key);
      }
      await page.waitForTimeout(1_500);
      expect(writes.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([]);
      expect(await (await ada.api.get(`/api/maps/${map.id}`)).json()).toEqual(before);
      expect(await (await ada.api.get(`/api/maps/${map.id}/history`)).json()).toEqual(history);
      await page.close();
    });

    await test.step("a Viewer's save through the API is refused alike, and the map stands", async () => {
      for (const [method, url, data] of [
        ["patch", `/api/maps/${map.id}`, { name: "Viewer was here" }],
        ["patch", `/api/layers/${map.layers[0]}`, { name: "Viewer roads" }],
        ["post", `/api/maps/${map.id}/undo`, undefined],
      ] as const) {
        const refused = await vic.api[method](url, data ? { data } : {});
        expect(refused.status(), `${method} ${url}`).toBe(403);
        expect(await refused.json()).toEqual(PERMISSION);
      }
      expect((await (await ada.api.get(`/api/maps/${map.id}`)).json()).name).toBe(mapName);
    });

    await test.step("the workflow: the Editor's canvas runs and locks, the Viewer's has no unlock and no run", async () => {
      const editor = await eli.context.newPage();
      await editor.goto(`/workflows/${recipe}`);
      await expect(editor.getByRole("button", { name: /^(Lock|Unlock) canvas$/ })).toBeVisible({ timeout: 30_000 });
      await expect(editor.getByRole("button", { name: "Run all" })).toBeVisible();
      await editor.close();
      const page = await vic.context.newPage();
      const writes = writesOf(page);
      await page.goto(`/workflows/${recipe}`);
      await expect(page.getByRole("img", { name: `Shared by ${ada.name}`, exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /^(Lock|Unlock) canvas$/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "unlock", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Run all" })).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+z");
      await page.keyboard.press("Delete");
      await page.waitForTimeout(1_000);
      expect(writes.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([]);
      const refused = await vic.api.post(`/api/recipes/${recipe}/runs`, { data: {} });
      expect(refused.status()).toBe(403);
      expect(await refused.json()).toEqual(PERMISSION);
    });

    await test.step("a non-member opening the map or the workflow finds nothing", async () => {
      const page = await nia.context.newPage();
      for (const url of [`/maps/${map.id}`, `/workflows/${recipe}`]) {
        await page.goto(url);
        await expect(page.getByText(NOT_FOUND, { exact: true })).toBeVisible();
        await expect(page.getByText(mapName, { exact: true })).toHaveCount(0);
      }
    });
  } finally {
    await closeAll(people);
  }
});
