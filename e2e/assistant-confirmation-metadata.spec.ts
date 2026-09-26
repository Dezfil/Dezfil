// Renderer contract fixtures: all
// current gate words arrive as documented recovery metadata. No gate is
// executed here; real approval/decline and target binding have route tests.
import { test, expect } from "@playwright/test";
import { buildTools } from "../src/lib/tools/tools";
import { createMap, routeHouse } from "./support";

const gates = buildTools().filter((tool) => tool.confirm || tool.confirmWhen);
const gateNames = ["delete_palette", "delete_postgis_connection", "delete_table", "clear_table_geometry", "delete_recipe", "remove_recipe_step", "run_recipe", "delete_project", "delete_map", "delete_layer", "publish_map", "unpublish_map"].sort();
for (const width of [1440, 1000]) test.describe(`confirmation words at ${width}px`, () => {
  test.use({ viewport: { width, height: 1000 } });
  test("every gate shows both resolved words after mount recovery and dismissal", async ({ page, context }) => {
    expect(gates.map((g) => g.name).sort()).toEqual(gateNames);
    await routeHouse(context, { basemapStyleStub: true });
    await page.goto("/");
    const map = await createMap(page, "Confirmation renderer fixture");
    let current = gates[0];
    const receipt = () => ({ id: "fixture-run", state: "awaiting_confirmation", text: "Ready for your decision.", actions: [], incomplete: false,
      pending: { id: "fixture-pending", runId: "fixture-run", tool: current.name, args: { id: "exact-target" },
        confirmation: { target: current.confirmation!.target.replace("{target}", "Named target (exact-target)"), consequence: current.confirmation!.consequence } } });
    await page.route("**/api/assistant", (route) => route.fulfill({ json: { enabled: true, provider: "scripted", model: "metadata-fixture", stepBudget: 16 } }));
    await page.route("**/api/assistant/pending", (route) => route.fulfill({ json: { pending: [receipt().pending] } }));
    await page.route("**/api/assistant/runs/fixture-run", (route) => route.fulfill({ json: receipt() }));
    for (const gate of gates) {
      current = gate;
      await page.goto(`/maps/${map}`);
      const pane = page.locator("[data-assistant-pane]");
      if (await pane.getAttribute("data-open") !== "true") await page.locator("header").getByRole("button", { name: "Open assistant", exact: true }).click();
      // Since the tab's locator recovers a run it was already showing on its
      // own; the door is pressed only when the pane offers it.
      const group = pane.getByRole("group", { name: receipt().pending.confirmation.target, exact: true });
      const door = pane.getByRole("button", { name: /^Recover pending action:/ });
      if (!(await group.count()) && (await door.count())) await door.click();
      await expect(group).toBeVisible();
      await expect(group.getByText(receipt().pending.confirmation.consequence, { exact: true })).toBeVisible();
      await expect(group).not.toContainText(gate.name);
      await page.locator("header").getByRole("button", { name: "Close assistant", exact: true }).click();
      await page.locator("header").getByRole("button", { name: "Open assistant", exact: true }).click();
      await expect(group).toBeVisible();
      const bounds = await group.boundingBox();
      expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
  });
});
