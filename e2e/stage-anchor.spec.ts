// The builder's stage-control stack: the column and the buttons belong to
// the shared component, placement belongs to the builder. Those two jobs
// must never share one element's `position`: the component's rule
// (`relative`, the basemap panel's anchor) and the builder's rule
// (`absolute`, the canvas placement) are single-class selectors of equal
// specificity from two different CSS modules, so which one wins depends
// on nothing but the order the bundler emits the two files — and that
// order differs between the dev server's per-module chunks and a
// production build's merged chunk. When `relative` wins, the stack stops
// shrink-wrapping, grows into an in-flow block as wide as the canvas, and
// its `pointer-events: auto` swallows hover and click over the map's top
// band. These assertions are therefore computed style and hit-testing,
// not pixels: they must hold identically under `next dev` and a
// production build. They were seen red on a production build the day
// they were written, before the wrapper element made the placement rule
// order-independent.
import { test, expect } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { createMap, routeHouse, trackConsole } from "./support";

const runId = Date.now().toString(36);

test.use({ viewport: { width: 1440, height: 900 } });

test("the stage stack shrink-wraps and the map keeps its top band", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  const consoleErrors = trackConsole(page);
  await page.goto("/maps");
  const mapId = await createMap(page, `stage anchor ${runId}`);
  await page.goto(`/maps/${mapId}`);

  const stack = page.locator('[class*="stageStack"]').first();
  // First paint gets a long leash: on a cold dev-server cache the
  // builder's first compile alone can exceed the default expect budget.
  await expect(stack.getByRole("button", { name: "Zoom in" })).toBeVisible({
    timeout: 60_000,
  });

  // Placement: the anchor is absolute, so the stack floats over the
  // canvas instead of pushing into its flow.
  await expect(page.locator('[class*="stageAnchor"]').first()).toHaveCSS(
    "position",
    "absolute",
  );

  // Shrink-wrap: the column is one button wide, not the canvas's width.
  const box = await stack.boundingBox();
  expect(box, "stage stack is on screen").not.toBeNull();
  expect(box!.width, "the stack shrink-wraps to its buttons").toBeLessThan(100);

  // Interaction: a point in the top band, well right of the stack,
  // belongs to the map, not to a stack grown across it.
  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return {
        tag: el?.tagName ?? "",
        cls:
          el instanceof HTMLElement && typeof el.className === "string"
            ? el.className
            : "",
        inStack: Boolean(el?.closest('[class*="stageStack"]')),
      };
    },
    [box!.x + 350, box!.y + 10] as [number, number],
  );
  expect(
    hit.inStack,
    `the top band hit-tests past the stack (hit <${hit.tag} class="${hit.cls}">)`,
  ).toBe(false);

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected, "no new console errors").toEqual([]);
});
