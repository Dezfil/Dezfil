import { test, expect, type Locator } from "@playwright/test";
import { closeAll, createProject, invitePerson, runTag, share, type Person } from "./sharing-support";
import { readThenWriteRequestSetup } from "./edit-basis";
import { deletionControl, erasePerson } from "./deletion-support";
import { routeHouse } from "./support";

test("deleted actors keep times on map and workflow cards, heads, both history hints and runs", async ({ browser, request, baseURL }, info) => {
  const people: Person[] = [], tag = runTag();
  try {
    const owner = await invitePerson(browser, request, baseURL!, "Owner", tag);
    const departing = await invitePerson(browser, request, baseURL!, "Departing", tag);
    const named = await invitePerson(browser, request, baseURL!, "Named", tag); people.push(owner, departing, named);
    const project = await createProject(owner, `Surviving ${tag}`); await share(owner, project, departing, "editor"); await share(owner, project, named, "editor");
    const fixtures = [];
    for (const kind of ["deleted", "named", "unknown"] as const) {
      const actor = kind === "deleted" ? departing : named;
      const mapName = `${kind} map ${tag}`, recipeName = `${kind} workflow ${tag}`;
      const mapResponse = await owner.api.post("/api/maps", { data: { name: mapName, projectId: project } }); expect(mapResponse.status()).toBe(201);
      const map = await mapResponse.json(), mapPath = `/api/maps/${map.id}`;
      const layer = await readThenWriteRequestSetup(actor.api, mapPath, () => ({ method: "POST", path: `${mapPath}/layers`,
        options: { data: { name: "Stations", sql: "SELECT ST_Point(13, 52) AS geometry" } } })); expect(layer.status()).toBe(201);
      const recipeResponse = await owner.api.post("/api/recipes", { data: { name: recipeName, projectId: project } }); expect(recipeResponse.status()).toBe(201);
      const recipe = (await recipeResponse.json()).recipe, recipePath = `/api/recipes/${recipe.id}`;
      const step = await readThenWriteRequestSetup(actor.api, recipePath, () => ({ method: "POST", path: `${recipePath}/steps`,
        options: { data: { operation: "sql_step", parameters: { name: `result_${kind}_${tag}`, sql: "SELECT 1 AS value" } } } })); expect(step.status()).toBe(201);
      const stepId = (await step.json()).step.id;
      const start = await readThenWriteRequestSetup(actor.api, recipePath, () => ({ method: "POST", path: `${recipePath}/steps/${stepId}/run` })); expect(start.status()).toBe(202);
      const runId = (await start.json()).run.id;
      await expect.poll(async () => (await (await owner.api.get(`${recipePath}/runs/${runId}`)).json()).run.outcome, { timeout: 60_000 }).toBe("completed");
      if (kind === "unknown") await deletionControl({ command: "unknown-attribution", mapId: map.id, recipeId: recipe.id, runId });
      fixtures.push({ kind, mapName, recipeName, mapPath, recipePath, mapId: map.id, recipeId: recipe.id, runId,
        map: await (await owner.api.get(mapPath)).json(), recipe: (await (await owner.api.get(recipePath)).json()).recipe,
        run: (await (await owner.api.get(`${recipePath}/runs/${runId}`)).json()).run });
    }
    await erasePerson(request, departing.id, departing.email);
    for (const fixture of fixtures) {
      const map = await (await owner.api.get(fixture.mapPath)).json(), recipe = (await (await owner.api.get(fixture.recipePath)).json()).recipe;
      for (const [before, after] of [[fixture.map, map], [fixture.recipe, recipe]]) {
        expect(after.editRevision).toBe(before.editRevision); expect(after.lastChangedAt).toBe(before.lastChangedAt);
        expect(after.lastChangedBy).toEqual(fixture.kind === "deleted" ? { deleted: true } : before.lastChangedBy);
      }
      const run = (await (await owner.api.get(`${fixture.recipePath}/runs/${fixture.runId}`)).json()).run;
      expect(run.startedAt).toBe(fixture.run.startedAt); expect(run.finishedAt).toBe(fixture.run.finishedAt);
    }
    await routeHouse(owner.context, { basemapStyleStub: true }); const page = await owner.context.newPage();
    async function checkFact(fact: Locator, kind: string, time: string) {
      const label = kind === "deleted" ? "Deleted account" : kind === "unknown" ? "Unknown" : "Named";
      await expect(fact).toContainText(`${label} ·`);
      await expect(fact).toHaveCSS("font-style", kind === "named" ? "normal" : "italic");
      const exact = await page.evaluate(value => new Date(value).toLocaleString(), time);
      if (kind === "deleted") {
        await expect(fact).toHaveAttribute("title", `Changed ${exact} by an account that was deleted`);
        expect(await fact.evaluate(el => el.outerHTML)).not.toMatch(new RegExp(`${departing.name}|${departing.sqlName}`));
      } else if (kind === "unknown") await expect(fact).toHaveAttribute("title", `Changed ${exact} by an account the record does not name`);
      else await expect(fact).toHaveAttribute("title", `${named.name} (${named.sqlName}) · ${exact}`);
    }
    for (const surface of ["maps", "workflows"] as const) {
      await page.goto(`/${surface}`); await page.getByRole("button", { name: "Grid view", exact: true }).click();
      for (const fixture of fixtures) {
        const name = surface === "maps" ? fixture.mapName : fixture.recipeName;
        const fact = page.getByRole("link", { name: `Open ${name}`, exact: true }).locator("[data-last-changed]");
        await checkFact(fact, fixture.kind, (surface === "maps" ? fixture.map : fixture.recipe).lastChangedAt);
      }
      await page.screenshot({ path: info.outputPath(`${surface}-cards.png`) });
      for (const fixture of fixtures) {
        await page.goto(`/${surface}/${surface === "maps" ? fixture.mapId : fixture.recipeId}`);
        await checkFact(page.locator("header [data-last-changed]"), fixture.kind, (surface === "maps" ? fixture.map : fixture.recipe).lastChangedAt);
        if (surface === "maps") {
          const label = fixture.kind === "deleted" ? "Deleted account" : fixture.kind === "unknown" ? "Unknown" : `${named.name} (${named.sqlName})`;
          const undo = page.getByRole("button", { name: /^Undo ·/ });
          await expect(undo).toHaveAttribute("data-hint", new RegExp(`^Undo · ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · Stations · add`));
          await undo.hover(); await page.screenshot({ path: info.outputPath(`${fixture.kind}-undo.png`) });
          await undo.click(); const redo = page.getByRole("button", { name: /^Redo ·/ });
          await expect(redo).toHaveAttribute("data-hint", new RegExp(`^Redo · ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ·`));
          await redo.hover(); await page.screenshot({ path: info.outputPath(`${fixture.kind}-redo.png`) });
          if (fixture.kind === "deleted") expect(await redo.getAttribute("data-hint")).not.toMatch(new RegExp(`${departing.name}|${departing.sqlName}`));
        } else {
          await page.getByRole("tab", { name: "Messages", exact: true }).click();
          const runners = page.locator("[data-band-entries] [data-run-initiator]");
          await expect(runners.first()).toBeVisible();
          for (const runner of await runners.all()) {
            await expect(runner).toHaveText(fixture.kind === "deleted" ? "Deleted account" : fixture.kind === "unknown" ? "Unknown" : "Named");
            await expect(runner).toHaveCSS("font-style", "normal");
            if (fixture.kind === "named") await expect(runner).toHaveAttribute("title", `${named.name} (${named.sqlName})`);
            else { await expect(runner).not.toHaveAttribute("title"); await expect(runner).not.toHaveAttribute("data-hint"); }
          }
          await page.screenshot({ path: info.outputPath(`${fixture.kind}-workflow-head-and-runs.png`) });
        }
      }
    }
  } finally { await closeAll(people); }
});
