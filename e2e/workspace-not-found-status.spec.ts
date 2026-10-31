import { test, expect, type Page } from "@playwright/test";
import { readThenWriteRequestSetup } from "./edit-basis";
import { closeAll, createProject, expectNotFoundPage, invitePerson, runTag, uploadSentinel, type Person } from "./sharing-support";

/**
 * A workspace page that shows one map, workflow, project, dataset or
 * template answers 404 when the signed-in person reaches nothing at its
 * address: nothing is there, or what is there is someone else's, which
 * the API answers the same way. It is the framework's own not-found, as
 * for an address no page answers: drawn inside
 * the whole document, so a stored dark theme stays dark. Each kind says what
 * was not found; an address no page answers stays on the generic page.
 */

const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("an address that reaches no map, workflow, project, dataset or template answers 404 with the workspace's not-found page", async ({ browser, page, request, baseURL }) => {
  const people: Person[] = [];
  try {
    const tag = runTag();
    const bo = await invitePerson(browser, request, baseURL!, "Bo", tag); people.push(bo);
    // Bo's own, which the signed-in person does not reach.
    const map = await bo.api.post("/api/maps", { data: { name: `Bo's map ${tag}` } });
    expect(map.status()).toBe(201);
    const recipe = await bo.api.post("/api/recipes", { data: { name: `Bo's workflow ${tag}` } });
    expect(recipe.status()).toBe(201);
    const dataset = await uploadSentinel(bo, `bo_rows_${tag}`, "Bo's");
    const project = await createProject(bo, `Bo's project ${tag}`);
    const hidden = [
      [`/maps/${(await map.json()).id}`, "map"],
      [`/workflows/${(await recipe.json()).recipe.id}`, "workflow"],
      [`/projects/${project}`, "project"],
      [`/tables/${dataset.id}`, "dataset"],
    ] as const;
    // A template is every account's: only a missing one is absent.
    const missing = [
      [`/maps/missing-${tag}`, "map"],
      [`/workflows/missing-${tag}`, "workflow"],
      [`/projects/missing-${tag}`, "project"],
      [`/tables/missing_${tag}`, "dataset"],
      [`/templates/missing_${tag}`, "template"],
    ] as const;

    await test.step("the person's own pages answer 200, so the 404s below are the absence and not the page", async () => {
      const ownMap = await request.post("/api/maps", { data: { name: `Own map ${tag}` } });
      expect(ownMap.status()).toBe(201);
      const ownRecipe = await request.post("/api/recipes", { data: { name: `Own workflow ${tag}` } });
      expect(ownRecipe.status()).toBe(201);
      const ownProject = await request.post("/api/projects", { data: { name: `Own project ${tag}` } });
      expect(ownProject.status(), await ownProject.text()).toBe(201);
      const ownDataset = await request.post("/api/tables", { multipart: { file: {
        name: `own_rows_${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from("sentinel,lon,lat\nown,13.4,52.5\n"),
      } } });
      expect(ownDataset.status()).toBe(201);
      const templates = await request.get("/api/templates");
      expect(templates.status()).toBe(200);
      const template = ((await templates.json()).templates as { id: string; present: boolean }[]).find((t) => t.present);
      expect(template, "a shipped template to open").toBeTruthy();
      for (const address of [
        `/maps/${(await ownMap.json()).id}`,
        `/workflows/${(await ownRecipe.json()).recipe.id}`,
        `/projects/${(await ownProject.json()).id}`,
        `/tables/${(await ownDataset.json()).id}`,
        `/templates/${template!.id}`,
      ]) {
        expect((await request.get(address)).status(), address).toBe(200);
      }
    });

    await test.step("every hidden and missing address answers 404 with the workspace's not-found page", async () => {
      for (const [address, kind] of [...hidden, ...missing]) {
        const response = await page.goto(address);
        expect(response?.status(), address).toBe(404);
        await expectNotFoundPage(page, kind);
      }
      // The same words whether the item is hidden or missing.
      const body = async (address: string) => {
        await page.goto(address);
        return page.locator("h1").locator("..").innerText();
      };
      for (const [[hiddenAddress], [missingAddress]] of hidden.map((h, i) => [h, missing[i]] as const)) {
        expect(await body(hiddenAddress), hiddenAddress).toBe(await body(missingAddress));
      }
    });

    await test.step("an address no page answers stays on the generic page", async () => {
      expect((await page.goto(`/no-such-page-${tag}`))?.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
      await expect(page.getByText("Nothing is at this address.", { exact: true })).toBeVisible();
    });

    await test.step("a map deleted while its card is on the Maps page, followed from there, opens the same page", async () => {
      const name = `Gone map ${tag}`;
      const created = await request.post("/api/maps", { data: { name } });
      expect(created.status()).toBe(201);
      const { id } = await created.json();
      await page.goto("/maps");
      const card = page.getByRole("link", { name: `Open ${name}`, exact: true });
      await expect(card).toBeVisible();
      expect((await readThenWriteRequestSetup(request, `/api/maps/${id}`, () => ({ method: "DELETE" }))).status()).toBe(204);
      await card.click();
      await expect(page).toHaveURL(new RegExp(`/maps/${id}$`));
      await expectNotFoundPage(page, "map");
    });

    await test.step("the not-found page keeps a stored dark theme, as the Maps page does", async () => {
      const shade = async (theme: "dark" | "light", address: string) => {
        const context = await browser.newContext({ baseURL, storageState: await page.context().storageState() });
        try {
          await context.addInitScript((stored) => localStorage.setItem("dezfil-theme", stored), theme);
          const tab = await context.newPage();
          // Read once the document has loaded, whatever it holds: a bare
          // error document has no shell to wait for.
          await tab.goto(address, { waitUntil: "load" });
          return await background(tab);
        } finally {
          await context.close();
        }
      };
      const dark = await shade("dark", "/maps");
      // The stored theme decides the colour at all: else the comparison below says nothing.
      expect(dark, "the Maps page's dark and light backgrounds").not.toBe(await shade("light", "/maps"));
      for (const address of [hidden[0][0], missing[0][0], missing[3][0]]) {
        expect(await shade("dark", address), address).toBe(dark);
      }
    });
  } finally {
    await closeAll(people);
  }
});
