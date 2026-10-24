// Profile pictures where the app draws a person: a picture set through the
// API shows round in the circle where the initials stood, by its version,
// and a person without one keeps their initials and asks for no picture.
// Each case makes its own people, invited by the browser fixture's admin
// with a tag no other spec uses. Run against a fresh scratch instance.
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { routeHouse } from "./support";
import { closeAll, invitePerson, runTag, type Person } from "./sharing-support";
import { squareWebp } from "../test-support/profile-picture-fixtures";

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
