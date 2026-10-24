// Profile pictures where the app draws a person: a picture set through the
// API shows round in the circle where the initials stood, by its version,
// on the side menu, the Users rows, the Share dialog, the members line, the
// owner's pill wherever it stands, the role line and the console's rows;
// a deactivated person's picture is dimmed where their face is dimmed, and
// a person without one keeps their initials and asks for no picture. The
// Account card keeps a chosen picture at once, apart from the typed fields,
// draws only its latest answer, and a browser shows a replaced or removed
// picture fresh. An admin removes another person's picture from their
// Users row. Each case makes its own people, invited by the browser
// fixture's admin with a tag no other spec uses. Run against a fresh
// scratch instance.
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
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

/** The Account card's face, and the chooser behind its Change. */
const cardFace = (page: Page) => page.locator("#set-picture [data-face]");
const chooser = (page: Page) => page.locator("#set-picture input[type=file]");
const card = (page: Page) => page.locator("section#account");

/** Chooses a file on the card and answers the version the server gave. */
async function chooseOnCard(page: Page, file: Upload): Promise<string> {
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/account/picture") && response.request().method() === "PUT");
  await chooser(page).setInputFiles(file);
  const response = await answered;
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).account.pictureVersion;
}

async function removeOnCard(page: Page): Promise<void> {
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/account/picture") && response.request().method() === "DELETE");
  await card(page).getByRole("button", { name: "Remove", exact: true }).click();
  expect((await answered).status()).toBe(200);
}

const accountOf = async (person: Person) => (await (await person.api.get("/api/account")).json()).account;

test("the Account card keeps a JPEG, a PNG and a WebP at once, and leaves the typed fields alone", async ({ browser, request, baseURL }) => {
  test.setTimeout(240_000);
  const tag = runTag();
  const people: Person[] = [];
  try {
    const [ada] = await Promise.all(["Ada"].map((first) => invitePerson(browser, request, baseURL!, first, tag)));
    people.push(ada);
    await routeHouse(ada.context, { basemapStyleStub: true });
    const page = await ada.context.newPage();
    await page.goto("/settings/account");
    await expectLetters(cardFace(page), twoWords(ada.name));
    await expect(card(page).getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);

    let last = "";
    await test.step("a JPEG, a PNG and a WebP, each kept at once and shown in the card and the side menu without a reload", async () => {
      for (const file of [await jpeg(), await png(), await webp()]) {
        const version = await chooseOnCard(page, file);
        expect(version).not.toBe(last);
        await expectPicture(cardFace(page), ada.sqlName, version);
        await expectPicture(railFace(page, ada), ada.sqlName, version);
        last = version;
      }
      await expect(card(page).getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    });

    await test.step("a pending name, email and password edit stays unsaved through a change and a removal, and Cancel keeps the picture", async () => {
      await page.getByLabel("Display name", { exact: true }).fill(`Ada Renamed ${tag}`);
      await page.getByLabel("Email", { exact: true }).fill(`ada-renamed-${tag}@example.test`);
      await page.getByLabel("Current password to change email", { exact: true }).fill("typed for the email");
      await page.locator("#password > summary").click();
      await page.getByLabel("Current password", { exact: true }).fill("typed current");
      await page.getByLabel("New password", { exact: true }).fill("typed new password");
      const typed = async () => {
        await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(`Ada Renamed ${tag}`);
        await expect(page.getByLabel("Email", { exact: true })).toHaveValue(`ada-renamed-${tag}@example.test`);
        await expect(page.getByLabel("Current password to change email", { exact: true })).toHaveValue("typed for the email");
        await expect(page.getByLabel("Current password", { exact: true })).toHaveValue("typed current");
        await expect(page.getByLabel("New password", { exact: true })).toHaveValue("typed new password");
        await expect(card(page).getByRole("button", { name: "Save", exact: true })).toBeVisible();
      };
      await removeOnCard(page);
      await expectLetters(cardFace(page), twoWords(ada.name));
      await typed();
      last = await chooseOnCard(page, await png());
      await expectPicture(cardFace(page), ada.sqlName, last);
      await typed();
      const saved = await accountOf(ada);
      expect([saved.name, saved.email, saved.pictureVersion]).toEqual([ada.name, ada.email, last]);
      await card(page).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(ada.name);
      await expect(page.getByLabel("Email", { exact: true })).toHaveValue(ada.email);
      await expectPicture(cardFace(page), ada.sqlName, last);
      // The password card keeps what is typed in it: it has its own button.
      await expect(page.getByLabel("New password", { exact: true })).toHaveValue("typed new password");
    });

    await test.step("a refused file keeps the picture there was and says why", async () => {
      const answered = page.waitForResponse((response) => response.url().endsWith("/api/account/picture") && response.request().method() === "PUT");
      await chooser(page).setInputFiles({ name: "mark.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>') });
      expect((await answered).status()).toBe(415);
      await expect(card(page).getByRole("alert")).toContainText("The file is an SVG image. Choose a still JPEG, PNG or WebP image.");
      await expectPicture(cardFace(page), ada.sqlName, last);
      expect((await accountOf(ada)).pictureVersion).toBe(last);
    });

    await test.step("a second card still showing the picture removes it again without a refusal", async () => {
      const second = await ada.context.newPage();
      await second.goto("/settings/account");
      await expectPicture(cardFace(second), ada.sqlName, last);
      await removeOnCard(page);
      await removeOnCard(second);
      await expectLetters(cardFace(second), twoWords(ada.name));
      await expect(card(second).getByRole("alert")).toHaveCount(0);
      expect((await accountOf(ada)).pictureVersion).toBeUndefined();
    });
  } finally {
    await closeAll(people);
  }
});

test("the Account card draws only its latest answer, and a browser shows a replaced or removed picture fresh", async ({ browser, request, baseURL }) => {
  test.setTimeout(240_000);
  const tag = runTag();
  const people: Person[] = [];
  try {
    const [ada, bo] = await Promise.all(["Ada", "Bo"].map((first) => invitePerson(browser, request, baseURL!, first, tag)));
    people.push(ada, bo);
    await routeHouse(ada.context, { basemapStyleStub: true });
    const page = await ada.context.newPage();
    await page.goto("/settings/account");

    /** Holds the next answer to this method until released; the server
     * has the request, and has answered it, at once. */
    async function holdNext(method: "PUT" | "DELETE") {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let delivered!: () => void;
      const done = new Promise<void>((resolve) => { delivered = resolve; });
      let held = false;
      await page.route("**/api/account/picture", async (route) => {
        if (route.request().method() !== method || held) return route.continue();
        held = true;
        const response = await route.fetch();
        await released;
        await route.fulfill({ response });
        delivered();
      });
      return { release: async () => { release(); await done; await page.unrouteAll({ behavior: "wait" }); } };
    }

    await test.step("an upload whose answer arrives after a later removal's leaves no picture", async () => {
      await chooseOnCard(page, await webp());
      const big = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).jpeg({ quality: 70 }).toBuffer();
      expect(big.length).toBeLessThan(10 * 1024 * 1024);
      const upload = await holdNext("PUT");
      await chooser(page).setInputFiles({ name: "big.jpg", mimeType: "image/jpeg", buffer: big });
      await removeOnCard(page);
      await expectLetters(cardFace(page), twoWords(ada.name));
      await upload.release();
      await expectLetters(cardFace(page), twoWords(ada.name));
      await expectLetters(railFace(page, ada), twoWords(ada.name));
      expect((await accountOf(ada)).pictureVersion).toBeUndefined();
    });

    await test.step("an answer already kept by the server but delayed past a newer one never replaces the newer picture", async () => {
      await chooseOnCard(page, await webp());
      const removal = await holdNext("DELETE");
      await card(page).getByRole("button", { name: "Remove", exact: true }).click();
      const newer = await chooseOnCard(page, await png());
      await expectPicture(cardFace(page), ada.sqlName, newer);
      await removal.release();
      await expectPicture(cardFace(page), ada.sqlName, newer);
      expect((await accountOf(ada)).pictureVersion).toBe(newer);
    });

    // A context with no routes, so the browser's own cache is in play.
    const fresh = await bo.context.newPage();
    const seen: { url: string; status: number }[] = [];
    fresh.on("response", (response) => { if (response.url().includes("/picture")) seen.push({ url: new URL(response.url()).pathname + new URL(response.url()).search, status: response.status() }); });
    const fetchStatus = (url: string) => fresh.evaluate(async (address) => (await fetch(address)).status, url);

    await test.step("a replaced picture shows fresh at its new address, the old one answering no bytes", async () => {
      await fresh.goto("/settings/account");
      const first = await chooseOnCard(fresh, await webp());
      await expectPicture(railFace(fresh, bo), bo.sqlName, first);
      await fresh.reload();
      await expectPicture(cardFace(fresh), bo.sqlName, first);
      // Kept by the browser, asked again before use, answered without the bytes.
      expect(seen.filter((entry) => entry.url === address(bo.sqlName, first)).map((entry) => entry.status)).toContain(304);
      const second = await chooseOnCard(fresh, await jpeg());
      await expectPicture(cardFace(fresh), bo.sqlName, second);
      await expectPicture(railFace(fresh, bo), bo.sqlName, second);
      expect(await fetchStatus(address(bo.sqlName, first))).toBe(404);
    });

    await test.step("a picture that fails to load shows the initials", async () => {
      const failing = await bo.context.newPage();
      await failing.route("**/picture?v=*", (route) => route.abort());
      await failing.goto("/settings/account");
      // The picture is asked for and fails; the letters stand in its place.
      await expectLetters(cardFace(failing), twoWords(bo.name));
      await expectLetters(railFace(failing, bo), twoWords(bo.name));
      await failing.close();
    });

    await test.step("a removed picture shows the initials, and the page asks for none", async () => {
      const current = (await accountOf(bo)).pictureVersion as string;
      await removeOnCard(fresh);
      await expectLetters(cardFace(fresh), twoWords(bo.name));
      await expectLetters(railFace(fresh, bo), twoWords(bo.name));
      seen.length = 0;
      await fresh.reload();
      await expectLetters(cardFace(fresh), twoWords(bo.name));
      await expectLetters(railFace(fresh, bo), twoWords(bo.name));
      expect(seen).toEqual([]);
      expect(await fetchStatus(address(bo.sqlName, current))).toBe(404);
    });

    await test.step("after signing out, the picture warm in the cache is served to nobody", async () => {
      const last = await chooseOnCard(fresh, await png());
      await fresh.reload();
      await expectPicture(cardFace(fresh), bo.sqlName, last);
      expect(await fresh.evaluate(async () => (await fetch("/api/auth/sign-out", { method: "POST" })).status)).toBe(200);
      // The browser asks again before it shows what it kept, and is refused.
      const opened = await fresh.goto(address(bo.sqlName, last));
      expect(opened?.status()).toBe(401);
      expect((await opened!.body()).subarray(0, 4).toString("latin1")).not.toBe("RIFF");
    });
  } finally {
    await closeAll(people);
  }
});

test("an admin removes another person's picture from their Users row, active or deactivated, and never sees it on their own", async ({ browser, page, request, baseURL }) => {
  test.setTimeout(180_000);
  const tag = runTag();
  const people: Person[] = [];
  let ownPicture = false;
  try {
    const [ada, bo, cy] = await Promise.all(["Ada", "Bo", "Cy"].map((first) => invitePerson(browser, request, baseURL!, first, tag)));
    people.push(ada, bo, cy);
    await setPicture(ada.api, await webp());
    await setPicture(cy.api, await png());
    const off = await request.patch(`/api/users/${cy.id}`, { data: { status: "deactivated" } });
    expect(off.status(), await off.text()).toBe(200);
    await setPicture(request, await jpeg());
    ownPicture = true;
    await routeHouse(page.context(), { basemapStyleStub: true });
    await page.goto("/users");
    await page.getByRole("textbox", { name: "Search users" }).fill(tag);
    const removeButton = (row: Locator) => row.getByRole("button", { name: "Remove picture", exact: true });
    const opened = (person: Person) => page.locator("div").filter({ has: userRow(page, person) }).last();
    const inDangerZone = (button: Locator) => button.evaluate((element) => element.closest('[class*="dangerZone"]') !== null);

    await test.step("an active person's row offers Remove picture among the everyday actions, and it takes effect at once", async () => {
      await userRow(page, ada).click();
      const row = opened(ada);
      await expect(removeButton(row)).toBeVisible();
      expect(await inDangerZone(removeButton(row))).toBe(false);
      await removeButton(row).click();
      await expect(page.getByRole("status").filter({ hasText: `${ada.name}: picture removed` })).toBeVisible();
      await expectLetters(userRow(page, ada).locator("[data-face]"), twoWords(ada.name));
      await expect(removeButton(row)).toHaveCount(0);
      expect((await (await ada.api.get("/api/account")).json()).account.pictureVersion).toBeUndefined();
    });

    await test.step("a deactivated person's row offers it beside Reactivate, apart from Delete account", async () => {
      await userRow(page, cy).click();
      const row = opened(cy);
      await expect(row.getByRole("button", { name: "Reactivate", exact: true })).toBeVisible();
      await expect(removeButton(row)).toBeVisible();
      expect(await inDangerZone(removeButton(row))).toBe(false);
      expect(await inDangerZone(row.getByRole("button", { name: "Delete account", exact: true }))).toBe(true);
      await removeButton(row).click();
      await expect(page.getByRole("status").filter({ hasText: `${cy.name}: picture removed` })).toBeVisible();
      await expectLetters(userRow(page, cy).locator("[data-face]"), twoWords(cy.name));
      const listed = (await (await request.get("/api/users")).json()).users.find((user: { id: string }) => user.id === cy.id);
      expect(listed.pictureVersion).toBeUndefined();
    });

    await test.step("a person without a picture, and one's own row, offer no Remove picture", async () => {
      await userRow(page, bo).click();
      await expect(opened(bo).getByRole("button", { name: "Make admin", exact: true })).toBeVisible();
      await expect(removeButton(opened(bo))).toHaveCount(0);
      await page.getByRole("textbox", { name: "Search users" }).fill("entry-browser@example.test");
      const own = page.locator("button[aria-expanded]").filter({ hasText: "entry-browser@example.test" });
      await own.click();
      await expect(page.getByRole("link", { name: "Change password", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove picture", exact: true })).toHaveCount(0);
    });
  } finally {
    // The fixture admin is every spec's: leave it as it was.
    if (ownPicture) await request.delete("/api/account/picture");
    await closeAll(people);
  }
});
