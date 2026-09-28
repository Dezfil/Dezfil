// Published-view theme: the mode the publisher composes in is captured
// at publication from both product surfaces, served pre-paint in the
// route's HTML, switchable by the reader for the current page load only,
// and updatable in place over the API without rotating the token. The
// theme switch preserves the live viewer — no canvas remount. Light
// chrome asserts the exact light token, dark the exact night token, and
// the attached screenshot pair is the charter's placement evidence.
//
// retired per-link memory, so the reload steps below assert the opposite
// of what they once did: the switch is gone, a value left under the old
// storage key is ignored, and an authored change reaches a reader who
// already switched.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  FIXTURES_DIR,
  addLayer,
  createMap,
  publishMap,
  readPublished,
  routeHouse,
  saveSettled,
  seedCsv,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `pth_${runId}`;

const LIGHT_BG = "rgb(237, 241, 236)"; // --bg light (#edf1ec)
const DARK_BG = "rgb(11, 14, 20)"; // --bg night (#0b0e14)

const wrapperTheme = (page: Page) =>
  page
    .locator("[data-published-view]")
    .getAttribute("data-view-theme");

const wrapperBg = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector("[data-published-view]");
    return el ? getComputedStyle(el).backgroundColor : null;
  });

test("the publisher's light mode reaches readers; the toggle is live and load-local", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });

  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, tableName, csv);
  const mapId = await createMap(page, "theme capture");
  await addLayer(page, mapId, tableName, `SELECT * FROM ${tableName}`);

  let token = "";
  await test.step("publishing from the builder in light mode captures light", async () => {
    // The workspace default is light — no setup makes this arm.
    await page.goto(`/maps/${mapId}`);
    await expect(
      page.getByRole("button", { name: new RegExp(`^${tableName}`) }),
    ).toBeVisible({ timeout: 30_000 });
    await saveSettled(page);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByRole("button", { name: "Publish map" }).click();
    await expect(page.getByText("Published · just now")).toBeVisible();
    const link =
      (await page
        .locator("[data-publish-url]")
        .getAttribute("data-publish-url")) ?? "";
    token = new URL(link).pathname.split("/")[2];
    expect(token.length).toBeGreaterThan(10);
    const published = await readPublished<{ theme: string }>(page, token);
    expect(published.theme).toBe("light");
  });

  await test.step("the served HTML carries the authored mode before paint", async () => {
    const html = await (await page.request.get(`/v/${token}`)).text();
    expect(html).toContain('data-view-theme="light"');
    expect(html).toContain("data-published-view");
  });

  const readerContext = await context.browser()!.newContext({ baseURL: test.info().project.use.baseURL, storageState: { cookies: [], origins: [] } });
  await routeHouse(readerContext, { basemapStyleStub: true });
  const reader = await readerContext.newPage();
  const readerErrors = trackConsole(reader);
  await test.step("the page opens light and the switch is live, without a canvas remount", async () => {
    await reader.goto(`/v/${token}`);
    await expect(reader.locator(".maplibregl-canvas")).toBeVisible();
    expect(await wrapperTheme(reader)).toBe("light");
    expect(await wrapperBg(reader)).toBe(LIGHT_BG);
    await test
      .info()
      .attach("published-light", {
        body: await reader.screenshot(),
        contentType: "image/png",
      });

    // A sentinel on the live canvas node: a remount would shed it.
    await reader.evaluate(() => {
      (
        document.querySelector(".maplibregl-canvas") as unknown as {
          __keep: boolean;
        }
      ).__keep = true;
    });
    await reader
      .getByRole("button", { name: "Switch to dark theme" })
      .click();
    expect(await wrapperTheme(reader)).toBe("dark");
    expect(await wrapperBg(reader)).toBe(DARK_BG);
    expect(
      await reader.evaluate(
        () =>
          (
            document.querySelector(".maplibregl-canvas") as unknown as {
              __keep?: boolean;
            }
          ).__keep === true,
      ),
    ).toBe(true);
    await test
      .info()
      .attach("published-dark", {
        body: await reader.screenshot(),
        contentType: "image/png",
      });
  });

  // Retired per-link memory. These two steps assert the replacement
  // contract, in the direction that can actually fail: the switch must
  // be GONE after a reload, and a value left behind storage key must be
  // ignored rather than honored.
  await test.step("the switch does not survive a reload — the authored mode returns", async () => {
    await reader.reload();
    await expect(reader.locator(".maplibregl-canvas")).toBeVisible();
    expect(await wrapperTheme(reader)).toBe("light");
    expect(await wrapperBg(reader)).toBe(LIGHT_BG);
    const html = await (await page.request.get(`/v/${token}`)).text();
    expect(html).toContain('data-view-theme="light"');
  });

  await test.step("a value left by the retired per-link memory is ignored", async () => {
    // Seed exactly what wrote, then load the link. Under the old
    // contract this browser would open dark forever; the authored mode
    // wins.
    await reader.evaluate(
      (t) => localStorage.setItem(`dezfil-view-theme:${t}`, "dark"),
      token,
    );
    await reader.goto(`/v/${token}`);
    await expect(reader.locator(".maplibregl-canvas")).toBeVisible();
    expect(await wrapperTheme(reader)).toBe("light");
    expect(await wrapperBg(reader)).toBe(LIGHT_BG);
  });

  await test.step("an authored change reaches a reader who already switched", async () => {
    // The field-reported failure, as a test: switch as a reader, have
    // the author change the default, reload — the change must land. Under
    // the old memory it never did, which is what made a theme change look
    // like it needed a republish.
    await reader.getByRole("button", { name: "Switch to dark theme" }).click();
    expect(await wrapperTheme(reader)).toBe("dark");
    await page.evaluate(async (id) => {
      const r = await fetch(`/api/maps/${id}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: "dark" }),
      });
      if (!r.ok) throw new Error(await r.text());
    }, mapId);
    await reader.reload();
    await expect(reader.locator(".maplibregl-canvas")).toBeVisible();
    expect(await wrapperTheme(reader)).toBe("dark");
    // And back again, to prove the reload follows the author rather than
    // simply keeping what the reader picked.
    await page.evaluate(async (id) => {
      await fetch(`/api/maps/${id}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: "light" }),
      });
    }, mapId);
    await reader.reload();
    await expect(reader.locator(".maplibregl-canvas")).toBeVisible();
    expect(await wrapperTheme(reader)).toBe("light");
  });

  await test.step("a stated mode updates the active publication in place", async () => {
    const before = token;
    const after = await page.evaluate(async (id) => {
      const r = await fetch(`/api/maps/${id}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: "dark" }),
      });
      if (!r.ok) throw new Error(await r.text());
      return ((await r.json()) as { token: string }).token;
    }, mapId);
    expect(after).toBe(before);
    const published = await readPublished<{ theme: string }>(page, token);
    expect(published.theme).toBe("dark");
    const html = await (await page.request.get(`/v/${token}`)).text();
    expect(html).toContain('data-view-theme="dark"');
  });

  await test.step("an empty-body publish changes nothing (existing callers)", async () => {
    await publishMap(page, mapId); // the older call shape
    const published = await readPublished<{ theme: string }>(page, token);
    expect(published.theme).toBe("dark");
  });

  await test.step("the toggle is keyboard-operable and exposes its state", async () => {
    await reader.goto(`/v/${token}`);
    const toggle = reader.getByRole("button", {
      name: /Switch to (light|dark) theme/,
    });
    await expect(toggle).toBeVisible();
    // aria-pressed says dark-is-on; the fresh page is authored dark now.
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    await toggle.focus();
    expect(
      await toggle.evaluate((el) => el.matches(":focus-visible")),
    ).toBe(true);
    await reader.keyboard.press("Enter");
    expect(await wrapperTheme(reader)).toBe("light");
    expect(
      await reader
        .getByRole("button", { name: "Switch to dark theme" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  await test.step("the console stayed clean", async () => {
    expect(
      consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
    ).toEqual([]);
    expect(
      readerErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
    ).toEqual([]);
  });
  await readerContext.close();
});

test("the Maps screen captures the composing mode too", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  // The dark arm: the workspace remembers dark before the page boots.
  await context.addInitScript(() => {
    try {
      localStorage.setItem("dezfil-theme", "dark");
    } catch {
      /* private mode */
    }
  });

  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, `${tableName}_g`, csv);
  const name = `gallery dark publish ${runId}`;
  const mapId = await createMap(page, name);
  await addLayer(page, mapId, `${tableName}_g`, `SELECT * FROM ${tableName}_g`);
  await page.goto("/maps");
  await page.getByRole("button", { name: `Publish ${name}` }).click();
  await expect(
    page.getByRole("button", { name: `Copy share link for ${name}` }),
  ).toBeVisible();
  const token = await page.evaluate(async (id) => {
    const r = await fetch(`/api/maps/${id}`, { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    return ((await r.json()) as { publishToken: string }).publishToken;
  }, mapId);
  const published = await readPublished<{ theme: string }>(page, token);
  expect(published.theme).toBe("dark");
  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

// The published viewer's control stack: one cluster, always navigable,
// gated by the author's checklist, reduced inside an embed.
test("the published stack is one cluster the author gates", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });

  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, `${tableName}_s`, csv);
  const mapId = await createMap(page, `stack ${runId}`);
  await addLayer(page, mapId, `${tableName}_s`, `SELECT * FROM ${tableName}_s`);
  const token = await page.evaluate(async (id) => {
    const r = await fetch(`/api/maps/${id}/publish`, { method: "POST" });
    if (!r.ok) throw new Error(await r.text());
    return ((await r.json()) as { token: string }).token;
  }, mapId);

  const readerContext = await context.browser()!.newContext({ baseURL: test.info().project.use.baseURL, storageState: { cookies: [], origins: [] } });
  await routeHouse(readerContext, { basemapStyleStub: true });
  const reader = await readerContext.newPage();
  const readerErrors = trackConsole(reader);

  await test.step("every control renders, and no native cluster does", async () => {
    await reader.goto(`/v/${token}`);
    await expect(reader.locator(".maplibregl-canvas")).toBeVisible();
    for (const name of [
      "Zoom in",
      "Zoom out",
      "Point north",
      "Fit to data",
      "Basemap",
    ]) {
      await expect(reader.getByRole("button", { name })).toBeVisible();
    }
    await expect(
      reader.getByRole("button", { name: /Tilt the map|Back to flat/ }),
    ).toBeVisible();
    await expect(
      reader.getByRole("button", { name: /Switch to (light|dark) theme/ }),
    ).toBeVisible();
    // The stock MapLibre cluster is retired on every surface — it was the
    // second, differently-styled compass, and it vanished whenever the
    // widget rail appeared.
    await expect(reader.locator(".maplibregl-ctrl-group")).toHaveCount(0);
    // The picker is a button, never a tab: the published page carries no
    // builder chrome, and tab semantics here would be untrue as well.
    await expect(reader.getByRole("tab", { name: "Basemap" })).toHaveCount(0);
  });

  await test.step("a basemap pick swaps the live style and its credit", async () => {
    // What makes this provable: the style stub answers every OpenFreeMap
    // URL with the same empty document, so reading the loaded style back
    // cannot distinguish one vector style from another. The REQUEST can —
    // MapLibre only fetches a style URL because setStyle was called with
    // it, so the request is evidence the pick reached the canvas rather
    // than only the card's pressed state.
    const styleRequests: string[] = [];
    reader.on("request", (r) => {
      if (r.url().includes("/styles/")) styleRequests.push(r.url());
    });
    await reader.getByRole("button", { name: "Basemap" }).click();
    // The panel's rise animation is live, not a keyframe or curve that
    // resolves to nothing (the / / class: an undefined token in the
    // animation shorthand silently yields animation-name none, which
    // lint:tokens cannot catch once the token is merely wrong rather
    // than missing). The liveness form.
    expect(
      await reader
        .getByRole("button", { name: "Streets", exact: true })
        .locator("xpath=ancestor::*[contains(@class, 'panel')][1]")
        .evaluate((el) => getComputedStyle(el).animationName),
    ).not.toBe("none");
    await reader.getByRole("button", { name: "Streets", exact: true }).click();
    await expect
      .poll(() => styleRequests.some((u) => u.endsWith("/styles/liberty")), {
        timeout: 15_000,
      })
      .toBe(true);
    // Picking closes the panel and returns focus to the trigger, so the
    // keyboard does not land in a dismissed subtree.
    await expect(reader.getByRole("button", { name: "Streets", exact: true })).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "Basemap" })).toBeFocused();

    // Imagery is configured per instance, never shipped: with none
    // configured, the picker offers no imagery card at all.
    await reader.getByRole("button", { name: "Basemap" }).click();
    await expect(
      reader.getByRole("button", { name: "Satellite", exact: true }),
    ).toHaveCount(0);
    // The credit follows the pick: a reader's own choice moves it too.
    await reader.getByRole("button", { name: "Light", exact: true }).click();
    await expect(reader.getByText("© OpenMapTiles")).toBeVisible();
  });

  await test.step("unchecking a control removes it from the next load", async () => {
    await page.evaluate(async (id) => {
      const r = await fetch(`/api/maps/${id}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          viewerControls: { basemap: false, theme: false },
        }),
      });
      if (!r.ok) throw new Error(await r.text());
    }, mapId);
    await reader.goto(`/v/${token}`);
    await expect(reader.locator(".maplibregl-canvas")).toBeVisible();
    await expect(reader.getByRole("button", { name: "Basemap" })).toHaveCount(0);
    await expect(
      reader.getByRole("button", { name: /Switch to (light|dark) theme/ }),
    ).toHaveCount(0);
    // Navigation is never the author's to remove.
    await expect(reader.getByRole("button", { name: "Zoom in" })).toBeVisible();
    await expect(
      reader.getByRole("button", { name: "Point north" }),
    ).toBeVisible();
    await expect(
      reader.getByRole("button", { name: "Fit to data" }),
    ).toBeVisible();
  });

  await test.step("fit to data reframes, and reframes to the same place twice", async () => {
    await reader.goto(`/v/${token}`);
    await expect(reader.locator(".maplibregl-canvas")).toBeVisible();
    await reader.waitForTimeout(1500);

    // Shots of the rendered map with floating chrome masked, so the
    // comparison is about the camera and nothing else.
    const shot = () =>
      reader.screenshot({
        mask: [
          reader.locator('[class*="stageStack"]'),
          reader.locator('[class*="corner"]'),
          reader.locator('[class*="BasemapCredit-module"]'),
          reader.locator('[class*="offline"]'),
        ],
      });

    const dragAway = async (base: Buffer) => {
      const box = await reader.locator(".maplibregl-canvas").boundingBox();
      if (!box) throw new Error("no canvas box");
      // Start over open canvas: the corners carry the title, legend and
      // attribution, and a drag begun on those never reaches the map.
      await reader.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
      await reader.mouse.down();
      await reader.mouse.move(box.x + box.width * 0.22, box.y + box.height * 0.2, {
        steps: 14,
      });
      await reader.mouse.up();
      await expect
        .poll(async () => !(await shot()).equals(base), { timeout: 15_000 })
        .toBe(true);
    };

    const fit = reader.getByRole("button", { name: "Fit to data" });
    await expect(fit).toBeVisible();

    await dragAway(await shot());
    await fit.click();
    await reader.waitForTimeout(1500);
    const firstFit = await shot();

    // The second press is the arm that matters: the canvas keys its fit
    // effect on reference identity, so a reused bounds value would leave
    // the camera where the drag left it while the first press still
    // looked correct. Landing on the same frame twice is what rules that
    // out — and it is a claim about the frame, not merely about motion.
    await dragAway(firstFit);
    await fit.click();
    await expect
      .poll(async () => (await shot()).equals(firstFit), { timeout: 15_000 })
      .toBe(true);
  });

  await test.step("at 1024x600 the top-left column clears the viewport bottom", async () => {
    // Criterion 9, measured rather than argued: with every control on,
    // the stack is seven buttons tall and the title, failure rows and a
    // top-left legend stack beneath it. The column is bounded so the whole
    // group stays inside the viewport at the smallest desktop size the
    // suite exercises.
    // The previous step left two controls unchecked; this one is about
    // the full-height column, so put them back first.
    await page.evaluate(async (id) => {
      await fetch(`/api/maps/${id}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          viewerControls: { basemap: true, theme: true, tilt: true, fit: true },
        }),
      });
    }, mapId);
    await reader.setViewportSize({ width: 1024, height: 600 });
    await reader.goto(`/v/${token}`);
    await expect(reader.locator(".maplibregl-canvas")).toBeVisible();
    await expect(reader.getByRole("button", { name: "Basemap" })).toBeVisible();
    // The map's name reads as the column's heading, so it sits above the
    // controls.
    const titleBox = await reader.locator('[class*="titleBar"]').boundingBox();
    const stackBox = await reader
      .locator('[class*="stageStack"]')
      .boundingBox();
    if (!titleBox || !stackBox) throw new Error("no title or stack");
    expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(stackBox.y);

    const column = reader.locator('[class*="cornerTopLeft"]');
    const box = await column.boundingBox();
    if (!box) throw new Error("no top-left column");
    expect(box.y + box.height).toBeLessThanOrEqual(600);
    // The controls specifically: everything above them in the column is
    // either fixed height or bounded, so they stay reachable.
    expect(stackBox.y + stackBox.height).toBeLessThanOrEqual(600);

    // The picker opens upward from its trigger, so it stays on screen
    // rather than running off the bottom of a short viewport.
    await reader.getByRole("button", { name: "Basemap" }).click();
    const panel = reader.locator('[class*="BasemapPicker-module"][class*="panel"]');
    const panelBox = await panel.boundingBox();
    if (!panelBox) throw new Error("no picker panel");
    expect(panelBox.y).toBeGreaterThanOrEqual(0);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(600);
    await reader.keyboard.press("Escape");
    await reader.setViewportSize({ width: 1280, height: 720 });
  });

  await test.step("an embed renders the reduced set", async () => {
    // Re-enable everything first, so the embed's reduction is the embed's
    // doing and not a leftover checklist.
    await page.evaluate(async (id) => {
      await fetch(`/api/maps/${id}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          viewerControls: {
            basemap: true,
            theme: true,
            tilt: true,
            fit: true,
            coords: true,
          },
        }),
      });
    }, mapId);
    // Prove the positive arm on the same publication and fine-pointer
    // browser before asserting the embed omits it. Otherwise a missing
    // readout could be an idle-cursor false pass.
    await reader.goto(`/v/${token}`);
    const fullCanvas = reader.locator(".maplibregl-canvas");
    await expect(fullCanvas).toBeVisible();
    const fullCanvasBox = await fullCanvas.boundingBox();
    if (!fullCanvasBox) throw new Error("no full-reader canvas");
    await reader.mouse.move(
      fullCanvasBox.x + fullCanvasBox.width / 2,
      fullCanvasBox.y + fullCanvasBox.height / 2,
    );
    await expect(reader.getByTitle("Copy coordinates")).toBeVisible();

    await reader.goto(`/v/${token}?embed=1`);
    const embedCanvas = reader.locator(".maplibregl-canvas");
    await expect(embedCanvas).toBeVisible();
    const embedCanvasBox = await embedCanvas.boundingBox();
    if (!embedCanvasBox) throw new Error("no embed canvas");
    await reader.mouse.move(
      embedCanvasBox.x + embedCanvasBox.width / 2,
      embedCanvasBox.y + embedCanvasBox.height / 2,
    );
    await expect(reader.getByTitle("Copy coordinates")).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "Zoom in" })).toBeVisible();
    await expect(
      reader.getByRole("button", { name: "Point north" }),
    ).toBeVisible();
    await expect(
      reader.getByRole("button", { name: "Fit to data" }),
    ).toBeVisible();
    await expect(reader.getByRole("button", { name: "Basemap" })).toHaveCount(0);
    await expect(
      reader.getByRole("button", { name: /Switch to (light|dark) theme/ }),
    ).toHaveCount(0);
    await expect(
      reader.getByRole("button", { name: /Tilt the map|Back to flat/ }),
    ).toHaveCount(0);
  });

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
  expect(
    readerErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
  await readerContext.close();
});
