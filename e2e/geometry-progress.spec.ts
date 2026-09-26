import { test, expect, type Locator } from "@playwright/test";
import { routeHouse, seedCsv } from "./support";

// Requests remain the real API paths; hand-released responses hold each wait
// long enough to prove its visible state, independent of machine speed.
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
async function busyIcon(button: Locator) {
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button.locator("svg")).toBeVisible();
  const spinner = button.locator('[data-tone="current"]');
  await expect(spinner).toBeVisible();
  const colors = await spinner.evaluate(el => {
    const style = getComputedStyle(el);
    return { top: style.borderTopColor, foreground: style.color, animation: el.getAnimations()[0]?.playState };
  });
  expect(colors.top).toBe(colors.foreground);
  expect(colors.animation).toBe("running");
  // Pixel evidence without platform-specific golden files: both the icon
  // and spinner must paint contrasting ink against the filled button.
  for (const graphic of [button.locator("svg"), spinner]) {
    const png = await graphic.screenshot({ animations: "allow" });
    const ink = await button.evaluate(async (_el, base64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${base64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
      // The top-left corner is outside these inset strokes.
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const difference = Math.hypot(pixels[i] - pixels[0], pixels[i + 1] - pixels[1], pixels[i + 2] - pixels[2]);
        if (difference > 45) count++;
      }
      return count;
    }, png.toString("base64"));
    expect(ink, "visible icon/spinner ink in the captured pixels").toBeGreaterThan(5);
  }
  const first = await spinner.screenshot({ animations: "allow" });
  await new Promise(resolve => setTimeout(resolve, 180));
  const second = await spinner.screenshot({ animations: "allow" });
  expect(first.equals(second), "the busy sign changes painted pixels").toBe(false);
}

for (const theme of ["light", "dark"] as const) {
  test(`geometry waits, kept icons and Data preview in ${theme}`, async ({ page, context }) => {
    await routeHouse(context);
    await page.addInitScript(t => localStorage.setItem("dezfil-theme", t), theme);
    const name = `geometry_wait_${theme}_${Date.now().toString(36)}`;
    await page.goto("/data");
    await seedCsv(page, name, 'id,payload\n1,"LINESTRING (10 20, 11 21)"\n2,bad\n');
    await page.goto(`/tables/${name}`);
    await expect(page.getByRole("tab", {name:"Map preview"})).toHaveAttribute("aria-selected", "true");
    const opened = gate(), checked = gate(), applied = gate();
    const route = `/api/tables/${name}/geometry`;
    let failApply = true;
    await page.route(`**${route}`, async intercepted => {
      if (intercepted.request().method() === "GET") await opened.promise;
      if (intercepted.request().method() === "PUT" && failApply) {
        await applied.promise;
        failApply = false;
        return intercepted.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({error:{code:"geometry_choice_invalid",message:"The synthetic write failed."}}) });
      }
      await intercepted.continue();
    });
    await page.route(`**${route}/preview`, async intercepted => { await checked.promise; await intercepted.continue(); });
    const door = page.locator('[data-set-geometry-door="primary"]');
    const dock = page.locator("[data-set-geometry-panel]");
    await door.click();
    await expect(page.getByRole("tab", {name:"Data preview"})).toHaveAttribute("aria-selected", "true");
    await expect(dock.getByRole("status")).toHaveText("Reading geometry choices…");
    await busyIcon(door);
    opened.release();
    await expect(dock.getByRole("status")).toHaveText("Checking the rows…");
    const waiting = dock.getByRole("button", { name:"Apply: checking…" });
    await expect(waiting).toBeDisabled();
    const fits = await waiting.evaluate(el => el.getBoundingClientRect().right <= el.closest("aside")!.getBoundingClientRect().right);
    expect(fits, "the waiting button stays within the dock").toBe(true);
    checked.release();
    await expect(dock.getByRole("button", {name:"Apply", exact:true})).toBeEnabled();
    await dock.getByRole("button", {name:"Apply", exact:true}).click();
    await expect(dock.getByRole("status")).toHaveText("Writing geometry for all rows…");
    await busyIcon(dock.getByRole("button", {name:"Applying…"}));
    applied.release();
    await expect(dock.getByRole("alert")).toContainText("The synthetic write failed.");
    await dock.getByRole("button", {name:"Apply", exact:true}).click();
    await expect(dock).toHaveCount(0);
    await expect(page.getByRole("tab", {name:"Data preview"})).toHaveAttribute("aria-selected", "true");
    // Change, the assumed-CRS chip, and the address all use the same door.
    for (const selector of ['[data-set-geometry-door="change"]', '[data-set-geometry-door="crs"]']) {
      await page.getByRole("tab", {name:"Map preview"}).click();
      await page.locator(selector).click();
      await expect(page.getByRole("tab", {name:"Data preview"})).toHaveAttribute("aria-selected", "true");
      await dock.getByRole("button", {name:"Cancel", exact:true}).click();
    }
    await page.goto(`/tables/${name}?geometry=set`);
    await expect(dock).toBeVisible();
    await expect(page.getByRole("tab", {name:"Data preview"})).toHaveAttribute("aria-selected", "true");
    await dock.getByRole("button", {name:"Cancel", exact:true}).click();
    const removed = await page.request.delete(`/api/tables/${name}`);
    expect(removed.ok()).toBe(true);
  });
}
