// The share dialog on a project's home, its owner's: the members line and
// the Share action open one sheet; a person is added by part of their name
// and by exact email, a role changed, a member removed and put back; a
// deactivated member's row is marked; a search that finds nobody says so
// once with where accounts come from; and the project is handed over with
// its one confirming sentence. Run against a fresh scratch instance.
import { test, expect, type Page } from "@playwright/test";
import { routeHouse } from "./support";
import { closeAll, createProject, invitePerson, PERMISSION, runTag, share, type Person } from "./sharing-support";

const dialog = (page: Page) => page.getByRole("dialog", { name: /^Share / });
const members = (page: Page) => dialog(page).locator("[data-share-members]");

test("a project's owner shares it in one sheet and hands it over", async ({ browser, request, baseURL }) => {
  test.setTimeout(240_000);
  const tag = runTag();
  const people: Person[] = [];
  try {
    const [ada, eli, vic, cyd] = await Promise.all(["Ada", "Eli", "Vic", "Cyd"].map((first) => invitePerson(browser, request, baseURL!, first, tag)));
    people.push(ada, eli, vic, cyd);
    const project = `Survey ${tag}`;
    const projectId = await createProject(ada, project);
    const page = await ada.context.newPage();
    await routeHouse(ada.context, { basemapStyleStub: true });

    await test.step("an unshared project's home says Only you, and the line opens the dialog", async () => {
      await page.goto(`/projects/${projectId}`);
      await expect(page.getByRole("heading", { name: project, level: 1 })).toBeVisible();
      const line = page.getByRole("button", { name: /Only you/ });
      await expect(line).toBeVisible();
      await line.click();
      await expect(dialog(page)).toBeVisible();
      await expect(members(page).getByText(ada.name, { exact: true })).toBeVisible();
      await expect(members(page).getByText("Owner", { exact: true })).toBeVisible();
      await dialog(page).getByRole("button", { name: "Done", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
    });

    await test.step("a person found by part of their name is added as Viewer", async () => {
      await page.getByRole("button", { name: "Share", exact: true }).click();
      const field = dialog(page).getByRole("combobox", { name: "Add people by name or email" });
      await field.fill(`vic ${tag}`.toUpperCase());
      const option = dialog(page).getByRole("option", { name: new RegExp(vic.name) });
      await expect(option).toBeVisible();
      await option.click();
      await expect(dialog(page).getByRole("button", { name: "Viewer", exact: true })).toHaveAttribute("aria-pressed", "true");
      await dialog(page).getByRole("button", { name: "Add", exact: true }).click();
      await expect(dialog(page).getByRole("status").filter({ hasText: `Added ${vic.name} as Viewer.` })).toBeVisible();
      await expect(members(page).getByRole("button", { name: `${vic.name}, Viewer` })).toBeVisible();
    });

    await test.step("a person found by their exact email is added as Editor", async () => {
      const field = dialog(page).getByRole("combobox", { name: "Add people by name or email" });
      await field.fill(`  ${eli.email.toUpperCase()}  `);
      await dialog(page).getByRole("option", { name: new RegExp(eli.name) }).click();
      await dialog(page).getByRole("group", { name: "Role" }).getByRole("button", { name: "Editor", exact: true }).click();
      await dialog(page).getByRole("button", { name: "Add", exact: true }).click();
      await expect(dialog(page).getByRole("status").filter({ hasText: `Added ${eli.name} as Editor.` })).toBeVisible();
      await expect(members(page).getByRole("button", { name: `${eli.name}, Editor` })).toBeVisible();
      // A part of an email address is no search for one.
      await field.fill(eli.email.slice(0, -4));
      await expect(dialog(page).getByText("No account with that email.", { exact: true })).toBeVisible();
      await expect(dialog(page).getByText("An admin adds accounts on the Users page.", { exact: true })).toBeVisible();
    });

    await test.step("a search that finds nobody says so once, with where accounts come from", async () => {
      const field = dialog(page).getByRole("combobox", { name: "Add people by name or email" });
      await field.fill(`nobody ${tag}`);
      await expect(dialog(page).getByText("No account with that name.", { exact: true })).toBeVisible();
      await expect(dialog(page).getByText("An admin adds accounts on the Users page.", { exact: true })).toHaveCount(1);
      await expect(dialog(page).getByRole("option")).toHaveCount(0);
      await field.fill("");
    });

    await test.step("a role is changed from the member's menu", async () => {
      await members(page).getByRole("button", { name: `${vic.name}, Viewer` }).click();
      await page.getByRole("menu", { name: `${vic.name}'s role` }).getByRole("menuitem", { name: "Editor" }).click();
      await expect(dialog(page).getByRole("status").filter({ hasText: `${vic.name} is now an Editor.` })).toBeVisible();
      await members(page).getByRole("button", { name: `${vic.name}, Editor` }).click();
      await page.getByRole("menu", { name: `${vic.name}'s role` }).getByRole("menuitem", { name: "Viewer" }).click();
      await expect(members(page).getByRole("button", { name: `${vic.name}, Viewer` })).toBeVisible();
      const listed = await (await ada.api.get(`/api/projects/${projectId}/people`)).json();
      expect(listed.people.map((p: { sqlName: string; role: string }) => [p.sqlName, p.role])).toEqual(
        [[ada.sqlName, "owner"], [eli.sqlName, "editor"], [vic.sqlName, "viewer"]]);
    });

    await test.step("a member is removed, and Undo puts them back with their role", async () => {
      await members(page).getByRole("button", { name: `Remove ${vic.name}` }).click();
      const status = dialog(page).getByRole("status").filter({ hasText: `Removed ${vic.name}.` });
      await expect(status).toBeVisible();
      await expect(members(page).getByText(vic.name, { exact: true })).toHaveCount(0);
      await status.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(members(page).getByRole("button", { name: `${vic.name}, Viewer` })).toBeVisible();
      await dialog(page).getByRole("button", { name: "Done", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Shared with Eli and Vic$/ })).toBeVisible();
    });

    await test.step("a Viewer's change of the people is refused, and changes nothing", async () => {
      const refused = await vic.api.put(`/api/projects/${projectId}/people/${cyd.sqlName}`, { data: { role: "viewer" } });
      expect(refused.status()).toBe(403);
      expect(await refused.json()).toEqual(PERMISSION);
      const listed = await (await ada.api.get(`/api/projects/${projectId}/people`)).json();
      expect(listed.people.map((p: { sqlName: string }) => p.sqlName)).not.toContain(cyd.sqlName);
    });

    await test.step("a deactivated member's row stays, dimmed and marked, with no role menu", async () => {
      await share(ada, projectId, cyd, "viewer");
      expect((await request.patch(`/api/users/${cyd.id}`, { data: { status: "deactivated" } })).status()).toBe(200);
      await page.reload();
      await page.getByRole("button", { name: "Share", exact: true }).click();
      const row = members(page).locator(`[data-member="${cyd.sqlName}"]`);
      await expect(row.getByText("Deactivated", { exact: true })).toBeVisible();
      await expect(row).toHaveAttribute("data-off", "true");
      await expect(members(page).getByRole("button", { name: `${cyd.name}, Viewer` })).toHaveCount(0);
      await expect(row.getByText("Viewer", { exact: true })).toBeVisible();
      await expect(members(page).getByRole("button", { name: `Remove ${cyd.name}` })).toBeVisible();
    });

    await test.step("the owner hands the project over with its one sentence, and stays as Editor", async () => {
      await members(page).getByRole("button", { name: `${ada.name}, Owner` }).click();
      await page.getByRole("menu", { name: `${ada.name}'s role` }).getByRole("menuitem", { name: "Transfer ownership…" }).click();
      const reveal = dialog(page).locator("[data-hand-over]");
      await reveal.getByRole("combobox", { name: "New owner" }).selectOption({ label: eli.name });
      await expect(reveal.getByText(`Eli becomes the owner of ${project}. You stay as Editor. Items keep their owners.`, { exact: true })).toBeVisible();
      await reveal.getByRole("button", { name: "Transfer ownership", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByRole("status").filter({ hasText: `${eli.name} owns ${project} now.` })).toBeVisible();
      await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
      await expect(page.getByText(`’s project`)).toContainText(`Editor · ${eli.name}’s project`);
      const listed = await (await eli.api.get(`/api/projects/${projectId}/people`)).json();
      expect(listed.people.slice(0, 2).map((p: { sqlName: string; role: string }) => [p.sqlName, p.role])).toEqual([[eli.sqlName, "owner"], [ada.sqlName, "editor"]]);
    });
  } finally {
    await closeAll(people);
  }
});
