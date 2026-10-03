import { test, expect } from "@playwright/test";
import { routeHouse } from "./support";
import { readThenWriteRequestSetup } from "./edit-basis";
import { closeAll, createProject, invitePerson, runTag, share, type Person } from "./sharing-support";

test("themed captures land through style changes and viewers see attribution without edit controls", async ({ browser, request, baseURL }) => {
  const people: Person[] = [];
  try {
    const tag = runTag();
    const ada = await invitePerson(browser, request, baseURL!, "Ada", tag), viewer = await invitePerson(browser, request, baseURL!, "Cy", tag); people.push(ada, viewer);
    const created = await ada.api.post("/api/maps", { data: { name: `Capture ${tag}` } }); expect(created.status()).toBe(201);
    const map = await created.json(), path = `/api/maps/${map.id}`;
    const added = await readThenWriteRequestSetup(ada.api, path, () => ({ method: "POST", path: `${path}/layers`, options: { data: { name: "Point", sql: "SELECT ST_Point(13, 52) AS geometry" } } }));
    expect(added.status()).toBe(201); const layer = await added.json();
    const project = await createProject(ada, `Project ${tag}`, { addMaps: [map.id] }); await share(ada, project, viewer, "viewer");
    await routeHouse(ada.context, { basemapStyleStub: true }); await routeHouse(viewer.context, { basemapStyleStub: true });
    const page = await ada.context.newPage();
    const captures: { theme: string; cycle: string; status: number }[] = [];
    let accepted: Record<string, unknown> | null = null;
    await page.route(`**${path}/thumbnail**`, async route => {
      if (route.request().method() !== "PUT") return route.continue();
      const url = new URL(route.request().url());
      if (captures.length < 2) {
        const saved = await readThenWriteRequestSetup(ada.api, path, () => ({ method: "PATCH", path: `/api/layers/${layer.id}`, options: { data: { style: { ...layer.style, opacity: captures.length ? 0.6 : 0.4 } } } }));
        expect(saved.status()).toBe(200); accepted = await saved.json();
      }
      const response = await route.fetch();
      captures.push({ theme: url.searchParams.get("theme")!, cycle: url.searchParams.get("cycle")!, status: response.status() });
      await route.fulfill({ response });
    });
    await page.goto(`/maps/${map.id}`);
    await expect(page.getByRole("button", { name: map.name, exact: true })).toBeVisible();
    // The head's last-changed line stands to the right of the search field.
    const search = await page.getByRole("combobox", { name: "Search this map and places" }).boundingBox();
    const changed = await page.locator("header [data-last-changed]").boundingBox();
    expect(changed!.x).toBeGreaterThanOrEqual(search!.x + search!.width);
    await expect.poll(() => captures.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    expect(captures.slice(0, 2).map(c => c.status)).toEqual([202, 204]);
    expect(captures[0].cycle).toBe(captures[1].cycle);
    expect(new Set(captures.slice(0, 2).map(c => c.theme))).toEqual(new Set(["light", "dark"]));
    const current = await (await ada.api.get(path)).json();
    for (const key of ["editRevision", "lastChangedAt", "lastChangedBy"]) expect(current[key]).toEqual(accepted![key]);
    for (const theme of ["light", "dark"]) expect((await viewer.api.get(`${path}/thumbnail?theme=${theme}`)).status()).toBe(200);
    const read = await viewer.context.newPage(); await read.goto(`/maps/${map.id}`);
    await expect(read.locator("[data-last-changed]")).toContainText("Ada ·");
    await expect(read.getByRole("button", { name: /^Undo/ })).toHaveCount(0);
    await expect(read.getByRole("button", { name: map.name, exact: true })).toHaveCount(0);
    await test.info().attach("reader-attribution", { body: await read.screenshot(), contentType: "image/png" });
    await read.goto(`/projects/${project}`);
    await expect(read.locator("[data-last-changed]").first()).toContainText("Ada ·");
    await read.goto("/maps"); await expect(read.locator("[data-last-changed]").first()).toContainText("Ada ·");
    // Legacy records can lack an actor. Inject that read fact, keeping owner and time.
    await read.route(/\/api\/maps(?:\?.*)?$/, async route => {
      const response = await route.fetch(), body = await response.json();
      const clear = (rows: Record<string, unknown>[]) => rows.map(m => ({ ...m, lastChangedBy: null }));
      await route.fulfill({ response, json: Array.isArray(body) ? clear(body) : { ...body, maps: clear(body.maps) } });
    });
    await read.reload(); await expect(read.locator("[data-last-changed]").first()).toContainText("Unknown ·");
    await expect(read.locator("[data-owner-pill]").first()).toBeVisible();
  } finally { await closeAll(people); }
});
