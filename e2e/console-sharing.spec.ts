// The SQL console of someone a project is shared with: the source list
// groups their own datasets as "Yours" and the project's other datasets
// under their owner's name and SQL name; the switch to group by project is
// remembered for the account across a reload; and a query joining their own
// `roads` with the owner's returns both sentinels. A non-member's console
// lists nothing of the owner's and cannot read it. Run against a fresh
// scratch instance.
import { test, expect, type Page } from "@playwright/test";
import { routeHouse } from "./support";
import { closeAll, createProject, invitePerson, runTag, share, uploadSentinel, type Person } from "./sharing-support";

const sources = (page: Page) => page.getByRole("group", { name: "Sources" });
const grouping = (page: Page) => page.getByRole("group", { name: "Group sources" });

async function runSql(page: Page, sql: string) {
  await page.getByLabel("SQL editor").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(sql);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Run query" }).click();
}

test("a project's Viewer reads the owner's datasets beside their own in the console", async ({ browser, request, baseURL }) => {
  test.setTimeout(240_000);
  const tag = runTag();
  const roads = `roads_${tag}`;
  const people: Person[] = [];
  try {
    const [ada, vic, nia] = await Promise.all(["Ada", "Vic", "Nia"].map((first) => invitePerson(browser, request, baseURL!, first, tag)));
    people.push(ada, vic, nia);
    const theirs = await uploadSentinel(ada, roads, "ada_roads");
    await uploadSentinel(vic, roads, "vic_roads");
    await uploadSentinel(nia, roads, "nia_roads");
    const project = `Survey ${tag}`;
    const projectId = await createProject(ada, project, { addTables: [theirs.id] });
    await share(ada, projectId, vic, "viewer");
    for (const person of [vic, nia]) await routeHouse(person.context, { basemapStyleStub: true });
    const page = await vic.context.newPage();

    await test.step("by person: one's own as Yours, the owner's under their name and SQL name", async () => {
      await page.goto("/sql");
      await expect(grouping(page).getByRole("button", { name: "By person" })).toHaveAttribute("aria-pressed", "true");
      const yours = sources(page).getByRole("button", { name: roads, exact: true });
      const owners = sources(page).getByRole("button", { name: `${ada.sqlName}.${roads}`, exact: true });
      await expect(yours).toBeVisible({ timeout: 15_000 });
      await expect(owners).toBeVisible();
      await expect(sources(page).getByText("Yours", { exact: true })).toBeVisible();
      const eyebrow = sources(page).getByRole("paragraph").filter({ hasText: ada.name });
      await expect(eyebrow).toContainText(ada.name);
      await expect(eyebrow.getByText(`· ${ada.sqlName}`, { exact: true })).toBeVisible();
      await expect(sources(page).getByRole("button", { name: `${nia.sqlName}.${roads}`, exact: true })).toHaveCount(0);
    });

    await test.step("by project, remembered for the account across a reload", async () => {
      await grouping(page).getByRole("button", { name: "By project" }).click();
      await expect(grouping(page).getByRole("button", { name: "By project" })).toHaveAttribute("aria-pressed", "true");
      await expect(sources(page).getByText(project, { exact: true })).toBeVisible();
      await expect(sources(page).getByText("Not in a project", { exact: true })).toBeVisible();
      await expect(sources(page).getByText("Yours", { exact: true })).toHaveCount(0);
      await page.reload();
      await expect(grouping(page).getByRole("button", { name: "By project" })).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
      await expect(sources(page).getByText(project, { exact: true })).toBeVisible();
      expect((await (await vic.api.get("/api/settings")).json()).sourceGrouping).toBe("project");
      expect((await (await nia.api.get("/api/settings")).json()).sourceGrouping).toBe("person");
      // Another account's console keeps its own choice.
      const other = await nia.context.newPage();
      await other.goto("/sql");
      await expect(grouping(other).getByRole("button", { name: "By person" })).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
      await other.close();
      await grouping(page).getByRole("button", { name: "By person" }).click();
    });

    await test.step("a join of one's own roads with the owner's returns both sentinels", async () => {
      await runSql(page, `SELECT a.sentinel AS mine, b.sentinel AS theirs FROM ${roads} a, ${ada.sqlName}.${roads} b`);
      const results = page.getByRole("region", { name: "Results" });
      await expect(results.getByRole("cell", { name: "vic_roads", exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(results.getByRole("cell", { name: "ada_roads", exact: true })).toBeVisible();
      await expect(results.getByRole("cell", { name: "nia_roads", exact: true })).toHaveCount(0);
    });

    await test.step("a non-member's console lists nothing of the owner's and cannot read it", async () => {
      const other = await nia.context.newPage();
      await other.goto("/sql");
      await expect(sources(other).getByRole("button", { name: roads, exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(sources(other).getByRole("button", { name: `${ada.sqlName}.${roads}`, exact: true })).toHaveCount(0);
      await runSql(other, `SELECT sentinel FROM ${ada.sqlName}.${roads}`);
      // The console's own error note; the assistant's context line repeats it.
      await expect(other.getByRole("region", { name: "Results" }).getByText("The query refers to an unknown table.", { exact: false })).toBeVisible({ timeout: 20_000 });
      await expect(other.getByRole("cell", { name: "ada_roads", exact: true })).toHaveCount(0);
    });
  } finally {
    await closeAll(people);
  }
});
