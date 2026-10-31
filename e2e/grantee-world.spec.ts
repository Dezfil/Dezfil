// The world of someone a project is shared with: the owner's map in their
// Maps list carries the owner's pill in grid and list alike, the project
// filter lists their own projects and then "Shared with you", the Projects
// page marks the project by its owner and their role, and the shared
// project's home is an Editor's or a Viewer's, never the owner's. A
// non-member meets none of it. Run against a fresh scratch instance.
import { test, expect, type Page } from "@playwright/test";
import { routeHouse } from "./support";
import { closeAll, createMapWithLayer, createProject, expectAbsentAlike, expectNotFoundPage, invitePerson, PERMISSION, runTag, share, uploadSentinel, type Person } from "./sharing-support";

const ownerPill = (page: Page, person: Person) => page.getByRole("img", { name: `Shared by ${person.name}`, exact: true });

test("an Editor and a Viewer see the shared project as theirs to use, never to own", async ({ browser, request, baseURL }) => {
  test.setTimeout(240_000);
  const tag = runTag();
  const people: Person[] = [];
  try {
    const [ada, eli, vic, nia] = await Promise.all(["Ada", "Eli", "Vic", "Nia"].map((first) => invitePerson(browser, request, baseURL!, first, tag)));
    people.push(ada, eli, vic, nia);
    const dataset = await uploadSentinel(ada, `roads_${tag}`, "ada_roads");
    const mapName = `Shared map ${tag}`, ownMap = `Own map ${tag}`, project = `Survey ${tag}`, ownProject = `Own project ${tag}`;
    const map = await createMapWithLayer(ada, mapName, [{ name: "Roads", sql: `SELECT * FROM roads_${tag}` }]);
    const projectId = await createProject(ada, project, { addMaps: [map.id], addTables: [dataset.id] });
    await share(ada, projectId, eli, "editor");
    await share(ada, projectId, vic, "viewer");
    for (const person of [eli, vic]) {
      await createMapWithLayer(person, `${ownMap} ${person.sqlName}`, []);
      await createProject(person, `${ownProject} ${person.sqlName}`);
    }

    for (const [person, role] of [[eli, "Editor"], [vic, "Viewer"]] as const) {
      const page = await person.context.newPage();
      await routeHouse(person.context, { basemapStyleStub: true });

      await test.step(`${role}: the owner's map in the Maps list carries the owner's pill, in grid and in list`, async () => {
        await page.goto("/maps");
        await page.getByRole("button", { name: "Grid view" }).click();
        const card = page.locator("article").filter({ hasText: mapName });
        await expect(card.getByRole("img", { name: `Shared by ${ada.name}`, exact: true })).toBeVisible();
        await expect(page.locator("article").filter({ hasText: `${ownMap} ${person.sqlName}` }).getByRole("img", { name: /^Shared by / })).toHaveCount(0);
        await page.getByRole("button", { name: "List view" }).click();
        await expect(ownerPill(page, ada)).toHaveCount(1);
        await expect(ownerPill(page, ada)).toBeVisible();
      });

      await test.step(`${role}: the project filter lists their own projects, then the shared one under "Shared with you"`, async () => {
        await page.getByRole("button", { name: "Filter by project" }).click();
        const menu = page.getByRole("menu", { name: "Filter by project" });
        await expect(menu.getByText("Shared with you", { exact: true })).toBeVisible();
        const rows = await menu.getByRole("menuitem").allInnerTexts();
        const own = rows.findIndex((text) => text.includes(`${ownProject} ${person.sqlName}`));
        const shared = rows.findIndex((text) => text.includes(project));
        expect(own).toBeGreaterThanOrEqual(0);
        expect(shared).toBeGreaterThan(own);
        expect(rows[shared]).toContain("Ada");
        await page.keyboard.press("Escape");
      });

      await test.step(`${role}: the Projects page marks the project by its owner and the role`, async () => {
        await page.goto("/projects");
        const card = page.locator("article").filter({ hasText: project });
        await expect(card.getByText(`by Ada · ${role}`, { exact: true })).toBeVisible();
      });

      await test.step(`${role}: the shared project's home has the role line and the role's actions only`, async () => {
        await page.goto(`/projects/${projectId}`);
        await expect(page.getByRole("heading", { name: project, level: 1 })).toBeVisible();
        await expect(page.getByText(`${role} · ${ada.name}’s project`, { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Export project" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Add to project" })).toHaveCount(role === "Editor" ? 1 : 0);
        await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
        // A member's More holds leaving the project and nothing an owner does.
        await page.getByRole("button", { name: "More", exact: true }).click();
        await expect(page.getByRole("menuitem")).toHaveText(["Leave project"]);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: /^(add a note|edit)$/ })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /Shared with|Only you/ })).toHaveCount(0);
      });
    }

    await test.step("the owner's Projects page counts the people the project is shared with", async () => {
      const page = await ada.context.newPage();
      await page.goto("/projects");
      const card = page.locator("article").filter({ hasText: project });
      await expect(card.getByRole("img", { name: "Shared with Eli and Vic", exact: true })).toBeVisible();
      await expect(card.getByRole("img", { name: "Shared with Eli and Vic", exact: true })).toContainText("2");
    });

    await test.step("a Viewer's rename of the project is refused, and the name stands", async () => {
      const refused = await vic.api.patch(`/api/projects/${projectId}`, { data: { name: "Renamed by a viewer" } });
      expect(refused.status()).toBe(403);
      expect(await refused.json()).toEqual(PERMISSION);
      expect((await (await ada.api.get(`/api/projects/${projectId}`)).json()).name).toBe(project);
    });

    await test.step("a non-member meets none of it: hidden answers as missing, and the lists hold nothing of it", async () => {
      await expectAbsentAlike(nia.api, `/api/projects/${projectId}`, "/api/projects/absent-project");
      await expectAbsentAlike(nia.api, `/api/maps/${map.id}`, "/api/maps/absent-map");
      const page = await nia.context.newPage();
      await page.goto(`/maps/${map.id}`);
      await expectNotFoundPage(page, "map");
      await expect(page.getByText(mapName, { exact: true })).toHaveCount(0);
      await page.goto("/maps");
      await expect(page.getByRole("button", { name: "New map", exact: true }).first()).toBeVisible();
      await expect(page.getByText(mapName, { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Filter by project" }).click();
      await expect(page.getByRole("menu", { name: "Filter by project" }).getByText("Shared with you", { exact: true })).toHaveCount(0);
    });
  } finally {
    await closeAll(people);
  }
});
