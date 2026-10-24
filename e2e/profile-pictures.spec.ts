// Profile pictures where the app draws a person: a picture set through the
// API shows round in the circle where the initials stood, by its version,
// on the side menu, the Users rows, the Share dialog, the members line, the
// owner's pill wherever it stands, the role line and the console's rows;
// a deactivated person's picture is dimmed where their face is dimmed, and
// a person without one keeps their initials and asks for no picture. Each
// case makes its own people, invited by the browser fixture's admin with a
// tag no other spec uses. Run against a fresh scratch instance.
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readThenWriteRequestSetup } from "./edit-basis";
import { routeHouse } from "./support";
import { closeAll, createMapWithLayer, createProject, invitePerson, runTag, share, uploadSentinel, type Person } from "./sharing-support";
import { squareWebp, tallPng, wideJpeg } from "../test-support/profile-picture-fixtures";

type Upload = { name: string; mimeType: string; buffer: Buffer };

/** Sets the caller's own picture and answers its new version. */
async function setPicture(api: APIRequestContext, file: Upload): Promise<string> {
  const response = await api.put("/api/account/picture", { multipart: { file } });
  expect(response.status(), await response.text()).toBe(200);
  const version = (await response.json()).account.pictureVersion;
  expect(typeof version).toBe("string");
  return version;
}

const webp = async (name = "face.webp"): Promise<Upload> => ({ name, mimeType: "image/webp", buffer: await squareWebp() });
const png = async (name = "face.png"): Promise<Upload> => ({ name, mimeType: "image/png", buffer: await tallPng() });
const jpeg = async (name = "face.jpg"): Promise<Upload> => ({ name, mimeType: "image/jpeg", buffer: await wideJpeg() });

/** The address the face reads a picture of one version at. */
const address = (sqlName: string, version: string) => `/api/accounts/${sqlName}/picture?v=${encodeURIComponent(version)}`;

/** A face holds the picture of this version, loaded, its letters gone. */
async function expectPicture(face: Locator, sqlName: string, version: string): Promise<void> {
  await expect(face).toHaveAttribute("data-face", "picture");
  await expect(face.locator("img")).toHaveAttribute("src", address(sqlName, version));
  await expect(face).toHaveText("");
  expect(await face.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
  // Round: the picture is clipped to the circle the initials stood in.
  expect(await face.locator("img").evaluate((img) => getComputedStyle(img).borderRadius)).toBe("50%");
}

/** A face shows the letters alone and asks for no picture. */
async function expectLetters(face: Locator, letters: string): Promise<void> {
  await expect(face).toHaveAttribute("data-face", "letters");
  await expect(face).toHaveText(letters);
  await expect(face.locator("img")).toHaveCount(0);
}

/** The side menu's face of the signed-in person. */
const railFace = (page: Page, person: Person) => page.getByRole("link", { name: `${person.name}, account`, exact: true }).locator("[data-face]");

/** A person's row on the Users page, closed. */
const userRow = (page: Page, person: Person) => page.locator("button[aria-expanded]").filter({ hasText: person.email });

/** The side menu and the Users rows take the first two words' initials. */
const twoWords = (name: string) => name.split(" ").slice(0, 2).map((word) => word[0]).join("").toUpperCase();
/** The sharing marks take the first and the last word's. */
const firstLast = (name: string) => { const words = name.split(" "); return (words[0][0] + words[words.length - 1][0]).toUpperCase(); };

/** Every face among these holds the picture of this version. */
async function expectPictures(faces: Locator, sqlName: string, version: string): Promise<void> {
  await expect(faces.first()).toBeVisible();
  const count = await faces.count();
  for (let i = 0; i < count; i += 1) await expectPicture(faces.nth(i), sqlName, version);
}

/** The owner's pill on someone else's item, wherever it stands. */
const pill = (scope: Page | Locator, owner: Person) => scope.getByRole("img", { name: `Shared by ${owner.name}`, exact: true });

const opacity = (face: Locator) => face.evaluate((element) => getComputedStyle(element).opacity);

/** Runs a workflow to its end, so its output stands as a folder on Data. */
async function runToEnd(api: APIRequestContext, id: string): Promise<void> {
  const started = await readThenWriteRequestSetup(api, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/runs` }));
  expect(started.status(), await started.text()).toBe(202);
  await expect.poll(async () => {
    const runs = (await (await api.get(`/api/recipes/${id}/runs`)).json()).runs as { outcome: string | null }[];
    return runs.length > 0 && runs.every((run) => run.outcome !== null) ? runs[0].outcome : "running";
  }, { timeout: 60_000 }).toBe("completed");
}

test("the side menu and the Users rows draw a person's picture, and the initials of a person without one", async ({ browser, page, request, baseURL }) => {
  test.setTimeout(180_000);
  const tag = runTag();
  const people: Person[] = [];
  try {
    const [ada, bo] = await Promise.all(["Ada", "Bo"].map((first) => invitePerson(browser, request, baseURL!, first, tag)));
    people.push(ada, bo);
    const version = await setPicture(ada.api, await webp());

    await test.step("a person with a picture sees it in the side menu", async () => {
      await routeHouse(ada.context, { basemapStyleStub: true });
      const own = await ada.context.newPage();
      await own.goto("/maps");
      await expectPicture(railFace(own, ada), ada.sqlName, version);
    });

    await test.step("a person without one sees their initials there and asks for no picture", async () => {
      await routeHouse(bo.context, { basemapStyleStub: true });
      const own = await bo.context.newPage();
      const asked: string[] = [];
      own.on("request", (sent) => { if (sent.url().includes("/picture")) asked.push(sent.url()); });
      await own.goto("/maps");
      await expectLetters(railFace(own, bo), twoWords(bo.name));
      expect(asked).toEqual([]);
    });

    await test.step("the admin's Users rows draw the picture and the initials", async () => {
      await routeHouse(page.context(), { basemapStyleStub: true });
      await page.goto("/users");
      await page.getByRole("textbox", { name: "Search users" }).fill(tag);
      await expectPicture(userRow(page, ada).locator("[data-face]"), ada.sqlName, version);
      await expectLetters(userRow(page, bo).locator("[data-face]"), twoWords(bo.name));
    });
  } finally {
    await closeAll(people);
  }
});

test("a shared project draws its people's pictures on every mark, a deactivated person's dimmed", async ({ browser, request, baseURL }) => {
  test.setTimeout(360_000);
  const tag = runTag();
  const people: Person[] = [];
  try {
    const [ada, bo, cy, dee, eve] = await Promise.all(["Ada", "Bo", "Cy", "Dee", "Eve"].map((first) => invitePerson(browser, request, baseURL!, first, tag)));
    people.push(ada, bo, cy, dee, eve);
    const roads = await uploadSentinel(ada, `roads_${tag}`, "ada_roads");
    const mapName = `Survey map ${tag}`, flowName = `Survey flow ${tag}`, project = `Survey ${tag}`;
    const map = await createMapWithLayer(ada, mapName, [{ name: "Roads", sql: `SELECT * FROM roads_${tag}` }]);
    const flow = (await (await ada.api.post("/api/recipes", { data: { name: flowName } })).json()).recipe.id as string;
    const step = await readThenWriteRequestSetup(ada.api, `/api/recipes/${flow}`, () => ({ method: "POST", path: `/api/recipes/${flow}/steps`,
      options: { data: { operation: "sql_step", parameters: { name: `staged_${tag}`, sql: `SELECT * FROM roads_${tag}` } } } }));
    expect(step.status(), await step.text()).toBe(201);
    const projectId = await createProject(ada, project, { addMaps: [map.id], addRecipes: [flow], addTables: [roads.id] });
    // Run once filed, so the output follows the workflow into the project.
    await runToEnd(ada.api, flow);
    await share(ada, projectId, bo, "editor");
    await share(ada, projectId, cy, "viewer");
    const version = { ada: await setPicture(ada.api, await webp()), bo: await setPicture(bo.api, await png()),
      cy: await setPicture(cy.api, await jpeg()), eve: await setPicture(eve.api, await webp()) };
    const off = await request.patch(`/api/users/${cy.id}`, { data: { status: "deactivated" } });
    expect(off.status(), await off.text()).toBe(200);
    // Bo's own last change makes Ada's map the lead of Bo's Home.
    const layer = await readThenWriteRequestSetup(bo.api, `/api/maps/${map.id}`, () => ({ method: "POST", path: `/api/maps/${map.id}/layers`,
      options: { data: { name: "Bo's roads", sql: `SELECT * FROM ${ada.sqlName}.roads_${tag}` } } }));
    expect(layer.status(), await layer.text()).toBe(201);
    for (const person of [ada, bo]) await routeHouse(person.context, { basemapStyleStub: true });
    const page = await bo.context.newPage();

    await test.step("the owner's pill on Maps: a card's corner and a list row", async () => {
      await page.goto("/maps");
      await page.getByRole("button", { name: "Grid view", exact: true }).click();
      await expectPictures(pill(page.locator("article").filter({ hasText: mapName }), ada).locator("[data-face]"), ada.sqlName, version.ada);
      await page.getByRole("button", { name: "List view", exact: true }).click();
      await expectPictures(pill(page, ada).locator("[data-face]"), ada.sqlName, version.ada);
    });

    await test.step("on Data: the dataset's and the workflow folder's corner, and their list rows", async () => {
      await page.goto("/data");
      await page.getByRole("button", { name: "Grid view", exact: true }).click();
      await expectPictures(pill(page.locator("[data-folder-card]").filter({ hasText: flowName }), ada).locator("[data-face]"), ada.sqlName, version.ada);
      await expectPictures(pill(page.locator(`[data-table-card="roads_${tag}"]`), ada).locator("[data-face]"), ada.sqlName, version.ada);
      await page.getByRole("button", { name: "List view", exact: true }).click();
      await expectPictures(pill(page, ada).locator("[data-face]"), ada.sqlName, version.ada);
    });

    await test.step("on Workflows: a card's corner and a list row", async () => {
      await page.goto("/workflows");
      await page.getByRole("button", { name: "Grid view", exact: true }).click();
      await expectPictures(pill(page.locator("article").filter({ hasText: flowName }), ada).locator("[data-face]"), ada.sqlName, version.ada);
      await page.getByRole("button", { name: "List view", exact: true }).click();
      await expectPictures(pill(page, ada).locator("[data-face]"), ada.sqlName, version.ada);
    });

    await test.step("on Home: the lead's corner and the Recent rows", async () => {
      await page.goto("/");
      await expect(page.locator('[data-recent-place="shown"]')).toBeVisible();
      await expectPictures(pill(page.locator('[data-recent-place="shown"]'), ada).locator("[data-face]"), ada.sqlName, version.ada);
      await expectPictures(pill(page, ada).locator("[data-face]"), ada.sqlName, version.ada);
      expect(await pill(page, ada).count()).toBeGreaterThan(await pill(page.locator('[data-recent-place="shown"]'), ada).count());
    });

    await test.step("on the shared project's home: the role line and the items' corners", async () => {
      await page.goto(`/projects/${projectId}`);
      await expect(page.getByRole("heading", { name: project, level: 1 })).toBeVisible();
      await expectPicture(page.locator('[data-role-line="editor"] [data-face]'), ada.sqlName, version.ada);
      await expect(page.locator('[data-role-line="editor"]')).toContainText(`${ada.name}’s project`);
      await expectPictures(pill(page, ada).locator("[data-face]"), ada.sqlName, version.ada);
    });

    await test.step("in the header path of the opened map and workflow", async () => {
      await page.goto(`/maps/${map.id}`);
      await expectPicture(pill(page, ada).locator("[data-face]"), ada.sqlName, version.ada);
      await page.goto(`/workflows/${flow}`);
      await expectPicture(pill(page, ada).locator("[data-face]"), ada.sqlName, version.ada);
    });

    await test.step("in the console's rows by project", async () => {
      await page.goto("/sql");
      const sources = page.getByRole("group", { name: "Sources" });
      await expect(sources.getByRole("button", { name: `${ada.sqlName}.roads_${tag}`, exact: true })).toBeVisible({ timeout: 15_000 });
      const byProject = page.getByRole("group", { name: "Group sources" }).getByRole("button", { name: "By project" });
      await byProject.click();
      await expect(byProject).toHaveAttribute("aria-pressed", "true");
      await expectPictures(sources.locator(`[data-row-owner="${ada.sqlName}"] [data-face]`), ada.sqlName, version.ada);
    });

    const own = await ada.context.newPage();
    await test.step("on the owner's home: the members line, the deactivated member's face dimmed", async () => {
      await own.goto(`/projects/${projectId}`);
      const line = own.locator('[data-members-line="shared"]');
      await expect(line).toBeVisible();
      const faces = line.locator("[data-face]");
      await expect(faces).toHaveCount(2);
      await expectPicture(faces.nth(0), bo.sqlName, version.bo);
      await expectPicture(faces.nth(1), cy.sqlName, version.cy);
      expect(await opacity(faces.nth(0))).toBe("1");
      expect(await opacity(faces.nth(1))).toBe("0.5");
    });

    await test.step("in the Share dialog: the members, a deactivated one dimmed, the results and the person picked", async () => {
      await own.getByRole("button", { name: "Share", exact: true }).click();
      const dialog = own.getByRole("dialog", { name: /^Share / });
      const member = (person: Person) => dialog.locator(`[data-member="${person.sqlName}"] [data-face]`);
      await expectPicture(member(ada), ada.sqlName, version.ada);
      await expectPicture(member(bo), bo.sqlName, version.bo);
      await expectPicture(member(cy), cy.sqlName, version.cy);
      expect(await opacity(member(bo))).toBe("1");
      expect(await opacity(member(cy))).toBe("0.5");
      const field = dialog.getByRole("combobox", { name: "Add people by name or email" });
      await field.fill(`dee ${tag}`);
      await expectLetters(dialog.locator(`[data-result="${dee.sqlName}"] [data-face]`), firstLast(dee.name));
      await field.fill(`eve ${tag}`);
      await expectPicture(dialog.locator(`[data-result="${eve.sqlName}"] [data-face]`), eve.sqlName, version.eve);
      await dialog.locator(`[data-result="${eve.sqlName}"]`).click();
      await expectPicture(dialog.locator(`[data-picked="${eve.sqlName}"] [data-face]`), eve.sqlName, version.eve);
    });
  } finally {
    await closeAll(people);
  }
});
