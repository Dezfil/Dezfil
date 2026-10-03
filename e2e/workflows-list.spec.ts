import { test, expect, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { seedCsv, trackConsole } from "./support";

/**
 * The workflows list and the workflow page: the browser flow — create, open,
 * rename, the list's facts and filters, the remembered view, duplicate, the
 * two-click delete. Every fact the page shows is the API's; the chain is
 * authored through the API so the page renders what it is told.
 */

const runId = Date.now().toString(36);
const table = `wf_stations_${runId}`;
const fresh = `Reach ${runId}`;
const chainName = `Chain ${runId}`;

async function createChain(page: Page): Promise<string> {
  return page.evaluate(
    async ({ chainName, table }) => {
      const headers = { "content-type": "application/json" };
      const made = await fetch("/api/recipes", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: chainName }),
      });
      if (!made.ok) throw new Error(await made.text());
      const { recipe } = (await made.json()) as { recipe: { id: string } };
      const steps = [
        { operation: "sql_step", parameters: { sql: `SELECT name FROM ${table}`, name: `${table}_one` } },
        { operation: "sql_step", parameters: { sql: `SELECT count(*) AS n FROM ${table}_one`, name: `${table}_two` } },
      ];
      for (const step of steps) {
        const added = await (async function readThenWriteWorkflowSetup() { const basis = await (await fetch(`/api/recipes/${recipe.id}`)).json(); return fetch(`/api/recipes/${recipe.id}/steps`, {
          method: "POST",
          headers: { ...headers, "X-Edit-Revision": basis.editRevision },
          body: JSON.stringify(step),
        }); })();
        if (!added.ok) throw new Error(await added.text());
      }
      return recipe.id;
    },
    { chainName, table },
  );
}

test("the workflows list: create, open, rename, facts, filters, view, duplicate, delete", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await page.goto("/workflows");
  await seedCsv(page, table, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  const chainId = await createChain(page);
  await page.reload();

  await test.step("a card wears the API's facts: nodes, sources, and the status chip", async () => {
    const card = page.getByRole("article").filter({ hasText: chainName });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("2 nodes");
    await expect(card).toContainText("1 source");
    await expect(card).toContainText("Never run");
  });

  await test.step("the filters keep what the spec says", async () => {
    await page.getByRole("button", { name: /^Needs attention/ }).click();
    await expect(page.getByRole("article").filter({ hasText: chainName })).toHaveCount(0);
    await page.getByRole("button", { name: /^Never run/ }).click();
    await expect(page.getByRole("article").filter({ hasText: chainName })).toHaveCount(1);
    await page.getByRole("button", { name: /^All/ }).click();
    // A search with no match is a content result with its own note, not the
    // workspace-empty state. The grid keeps its standing New tile either way
    // (as the Maps gallery does), so the telling place is the list view: its
    // empty-state tile appears only when there are no workflows at all.
    await page.getByRole("button", { name: "List view" }).click();
    await page.getByRole("textbox", { name: "Search workflows" }).fill(`nothing named this ${runId}`);
    await expect(page.getByText("No workflows match. Clear the search or filters.")).toBeVisible();
    await expect(page.getByRole("button", { name: "New workflow" })).toHaveCount(1);
    await page.getByRole("textbox", { name: "Search workflows" }).fill("");
    await expect(page.getByRole("button", { name: `Open ${chainName}` })).toHaveCount(1);
    await page.getByRole("button", { name: "Grid view" }).click();
    await expect(page.getByRole("article").filter({ hasText: chainName })).toHaveCount(1);
  });

  await test.step("New workflow asks for a name, creates, and opens the page; the crumb renames and survives a reload", async () => {
    await page.getByRole("button", { name: "New workflow" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New workflow" });
    await dialog.getByRole("textbox").fill(fresh);
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]+$/);
    await expect(page.locator("[data-workflow-frame]")).toContainText("No nodes yet");
    await page.getByRole("button", { name: fresh, exact: true }).click();
    await page.getByRole("textbox", { name: "Workflow name" }).fill(`${fresh} renamed`);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: `${fresh} renamed`, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: `${fresh} renamed`, exact: true })).toBeVisible();
  });

  await test.step("opening a workflow reaches the canvas", async () => {
    await page.goto(`/workflows/${chainId}`);
    await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
    // One source and two nodes, the nodes wearing the API's state.
    await expect(page.locator("[data-node]")).toHaveCount(3);
    await expect(page.locator("[data-node]").filter({ hasText: `${table}_one` })).toHaveAttribute("data-state", "never run");
  });

  await test.step("the view is remembered across a reload", async () => {
    await page.goto("/workflows");
    await page.getByRole("button", { name: "List view" }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("data-on", "true");
    await page.getByRole("button", { name: "Grid view" }).click();
  });

  await test.step("Duplicate makes a copy; Delete arms, then deletes", async () => {
    const card = page.getByRole("article").filter({ hasText: chainName }).first();
    await card.hover();
    await card.getByRole("button", { name: `Duplicate ${chainName}` }).click();
    const copy = page.getByRole("article").filter({ hasText: `${chainName} copy` });
    await expect(copy).toHaveCount(1);
    await copy.hover();
    await copy.getByRole("button", { name: `Delete ${chainName} copy` }).click();
    const armed = copy.getByRole("button", { name: `Confirm deleting ${chainName} copy` });
    await expect(armed).toContainText("Delete?");
    await armed.click();
    await expect(page.getByRole("article").filter({ hasText: `${chainName} copy` })).toHaveCount(0);
  });

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});
