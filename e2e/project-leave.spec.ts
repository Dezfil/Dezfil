import { test, expect } from "@playwright/test";
import { closeAll, createProject, invitePerson, runTag, share, type Person } from "./sharing-support";

// Real keyboard, focus, navigation and pixels belong to this browser proof.
// Run on an isolated instance. Its API fixtures use no production data.
for (const role of ["viewer", "editor"] as const) for (const frozen of [false, true]) {
  test(`${role} leaves from the bundle and home${frozen ? " under a frozen owner" : ""}`, async ({ browser, request, baseURL }, info) => {
    const people: Person[] = [];
    const tag = runTag();
    try {
      const owner = await invitePerson(browser, request, baseURL!, "Owner", tag);
      const member = await invitePerson(browser, request, baseURL!, "Member", tag);
      const other = await invitePerson(browser, request, baseURL!, "Hidden", tag);
      people.push(owner, member, other);
      const fixtures = [];
      for (const entrance of ["grid", "list", "home"] as const) {
        const name = `${entrance} survey ${tag}`;
        const id = await createProject(owner, name);
        await share(owner, id, member, role); await share(owner, id, other, "viewer");
        let ownMap: string | undefined;
        if (role === "editor") {
          const response = await member.api.post("/api/maps", { data: { name: `Own ${entrance} ${tag}`, projectId: id } });
          expect(response.status()).toBe(201); ownMap = (await response.json()).id;
        }
        fixtures.push({ entrance, name, id, ownMap });
      }
      const ownerPage = await owner.context.newPage();
      await ownerPage.goto("/projects");
      await expect(ownerPage.getByRole("button", { name: `Export ${fixtures[0].name}`, exact: true })).toBeAttached();
      await expect(ownerPage.getByRole("button", { name: /^Leave / })).toHaveCount(0);
      await ownerPage.goto(`/projects/${fixtures[0].id}`);
      await ownerPage.getByRole("button", { name: "More", exact: true }).click();
      await expect(ownerPage.getByRole("menuitem", { name: "Delete project" })).toBeVisible();
      await expect(ownerPage.getByRole("menuitem", { name: "Leave project" })).toHaveCount(0);
      await ownerPage.screenshot({ path: info.outputPath("owner-without-leave.png") });
      if (frozen) expect((await request.patch(`/api/users/${owner.id}`, { data: { status: "deactivated" } })).status()).toBe(200);
      const page = await member.context.newPage();
      for (const { entrance, name, id, ownMap } of fixtures) {
        let submissions = 0;
        const count = (req: { method(): string; url(): string }) => { if (req.method() === "POST" && new URL(req.url()).pathname === `/api/projects/${id}/leave`) submissions++; };
        page.on("request", count);
        await page.goto(entrance === "home" ? `/projects/${id}` : "/projects");
        if (entrance !== "home") await page.getByRole("button", { name: entrance === "grid" ? "Grid view" : "List view", exact: true }).click();
        else {
          await expect(page.locator(`[data-role-line="${role}"]`)).toContainText(owner.name);
          await expect(page.locator("[data-members-line]")).toHaveCount(0);
          await expect(page.getByText(other.name, { exact: false })).toHaveCount(0);
        }
        const opener = page.getByRole("button", { name: entrance === "home" ? "More" : `Leave ${name}`, exact: true });
        const open = async () => {
          await opener.focus(); await page.keyboard.press("Enter");
          if (entrance === "home") {
            const item = page.getByRole("menuitem", { name: "Leave project", exact: true });
            await expect(item).toBeFocused(); await page.keyboard.press("Enter");
          }
        };
        await open();
        const dialog = page.getByRole("dialog", { name: "Leave project", exact: true });
        await expect(dialog).toBeFocused();
        await expect(dialog).toContainText(`Leave ${name}?`);
        await expect(dialog).toContainText("You will no longer see this project or work you could access only through it. Its owner can add you again.");
        const kept = "What you created here stays yours and stays in the project. You still find it in your own lists.";
        if (ownMap) await expect(dialog).toContainText(kept); else await expect(dialog).not.toContainText(kept);
        expect(submissions).toBe(0);
        await page.screenshot({ path: info.outputPath(`${entrance}-confirmation.png`) });
        await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
        await page.keyboard.press("Shift+Tab"); await expect(dialog.getByRole("button", { name: "Leave project", exact: true })).toBeFocused();
        await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
        await page.keyboard.press("Enter"); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
        expect(submissions).toBe(0);
        await open(); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
        expect(submissions).toBe(0);
        await open(); await dialog.getByRole("button", { name: "Leave project", exact: true }).focus(); await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/projects$/);
        await expect(page.getByRole("status").filter({ hasText: `You left ${name}.` })).toBeVisible();
        await expect(page.getByRole("button", { name: `Leave ${name}`, exact: true })).toHaveCount(0);
        expect(submissions).toBe(1);
        if (entrance !== "home") await expect(page.getByRole("textbox", { name: "Search projects", exact: true })).toBeFocused();
        expect((await member.api.get(`/api/projects/${id}`)).status()).toBe(404);
        if (ownMap) expect(await (await member.api.get(`/api/maps/${ownMap}`)).json()).toMatchObject({ projectId: id });
        await page.screenshot({ path: info.outputPath(`${entrance}-departed.png`) });
        await page.goto(`/projects/${id}`);
        await expect(page.getByText("The requested resource was not found.", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
        page.off("request", count);
      }
    } finally { await closeAll(people); }
  });
}
