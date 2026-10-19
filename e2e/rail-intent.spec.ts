// The workspace rail's pointer intent (the dwell revised to 150ms by
// field ruling, -08-19; the hot zone made the builder's rule and the
// dwell brought to 100ms).
//
// Everything here is measured from the rail's box — never read from a
// class or the shell's own state, which could not fail. Two rules, by
// page, and every case names the page its contract belongs to:
//
// - On the MAP BUILDER, the hot zone is the collapsed
//   rail's left two-thirds. A pointer crossing into the right third —
//   the corridor to the inspector card — never expands it; one resting
//   on the left two-thirds expands it only after the dwell, never on
//   entry; the right third never initiates but its links still activate.
// - OFF THE BUILDER, the whole collapsed rail is the hot
//   zone, and the dwell still holds: a rest anywhere on it expands after
//   the dwell, entry alone never does, and a crossing that leaves the
//   rail never does.
// - On EVERY page an expanded rail retains the pointer across its full
//   width and collapses on leave, and keyboard focus expands with no
//   dwell.
//
// The dwell is short, shorter than the harness takes to drive a crossing
// on a busy machine, so the cases that time a gesture stop the page's
// clock around it rather than racing it: a crossing then takes no page
// time at all however long its moves take, and a rest is moved on to the
// dwell explicitly. The dwell is a timer the page's clock owns; the
// rail's width transition and the frames it is drawn in run on real
// time, so a timer that fires still shows as width. The widths a gesture
// renders are recorded by a ResizeObserver, which keeps no timer of its
// own and so watches on while the page's clock is stopped. What is left
// to the harness is that the rail can hear the pointer before the first
// move, and the cases wait for that rather than for a quiet machine; a
// case that cannot meet a condition of its own fails naming the harness,
// never the rail.
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { test, expect } from "@playwright/test";
import type { BrowserContext, Page, Route } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { createMap, routeHouse, trackConsole } from "./support";

const VIEWPORT = { width: 1440, height: 900 };
const COLLAPSED = 54;
const EXPANDED = 210;
/** The dwell, stated as a setting (RailShell). A rest is moved on to one
 * millisecond short of it, where the rail must still be collapsed, and
 * then past it, where it must open. */
const DWELL_MS = 100;
/** A pause safely past the dwell plus the width transition. */
const SETTLE_MS = 1100;
/** Real time for a timer that fired to show as width: the shell's
 * re-render, then the transition's first frames, which in headless move
 * the width 40 to 60ms after the attribute flips and well past 100px by
 * 80ms. */
const SHOW_MS = 400;
/** A point inside the left two-thirds (which end at 36px of the 54px). */
const LEFT_ZONE_X = 18;
/** A point inside the right third (past 36px = 2/3 of the collapsed 54px). */
const RIGHT_THIRD_X = 44;

const rail = (page: Page) =>
  page.locator('nav[aria-label="Product navigation"]');

async function railBox(page: Page) {
  const box = await rail(page).boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function expectRailWidth(page: Page, width: number) {
  await expect
    .poll(async () => Math.round((await railBox(page)).width), {
      timeout: 3000,
    })
    .toBe(width);
}

/** Ready for the pointer: the pointer parked far from the rail, and the
 * rail's pointer handler attached (read from the props record React keeps
 * on the element once it has hydrated it). A move that lands before then
 * arms nothing, and a resting pointer sends no second move, so the case
 * would read a product that never answered. */
async function readyForPointer(page: Page) {
  await page.mouse.move(1200, 500);
  await expect
    .poll(() =>
      rail(page).evaluate((nav) => {
        const props = Object.keys(nav).find((k) => k.startsWith("__reactProps$"));
        return (
          props !== undefined &&
          typeof (nav as unknown as Record<string, { onPointerMove?: unknown }>)[props]
            .onPointerMove === "function"
        );
      }),
    )
    .toBe(true);
}

/** A workspace page, opened and ready for the pointer. */
async function openPage(page: Page, path: string) {
  await page.goto(path);
  await readyForPointer(page);
}

/** The builder: a fresh map, opened, its panel strip mounted, its map
 * canvas up, and ready for the pointer. The house route policy keeps the
 * basemap off the network. */
async function openBuilder(
  page: Page,
  context: BrowserContext,
  name: string,
  handler?: (route: Route) => Promise<boolean> | boolean,
) {
  await routeHouse(context, { basemapStyleStub: true, handler });
  await page.goto("/maps");
  const mapId = await createMap(page, name);
  await page.goto(`/maps/${mapId}`);
  await expect(
    page.getByRole("tablist", { name: "Builder panels" }),
  ).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
  await readyForPointer(page);
  return mapId;
}

/** Stop the page's clock (installed by the case before it opened the
 * page). From here no timer the page sets fires until the case moves page
 * time on itself. The clock only moves forward, so it stops a second
 * ahead of the page's own reading, which covers the round trip between
 * the two; the pointer is parked off the rail, so no dwell is armed for
 * that second to fire. */
async function stopPageTime(page: Page) {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1000);
}

type Watched = Window & { __railWidest?: number };

/** From here on, record the widest the rail is rendered. A ResizeObserver
 * is told every box size the rail is drawn at, with no timer of its own,
 * so it keeps watching while the page's clock is stopped, and a widening
 * too brief for a later read to catch is still recorded. */
async function watchRailWidth(page: Page) {
  await rail(page).evaluate((nav) => {
    const w = window as Watched;
    w.__railWidest = nav.getBoundingClientRect().width;
    new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
        w.__railWidest = Math.max(w.__railWidest ?? 0, width);
      }
    }).observe(nav);
  });
}

const railWidest = (page: Page) =>
  page.evaluate(() => Math.round((window as Watched).__railWidest ?? Number.NaN));

/** Come to rest at (x, y) with the page's clock stopped, then move page
 * time on to one millisecond short of the dwell: the rail has not begun
 * to widen, whatever real time passes. The last millisecond opens it. */
async function restAndExpectDwell(page: Page, x: number, y: number) {
  await stopPageTime(page);
  await watchRailWidth(page);
  await page.mouse.move(x, y);
  await page.clock.runFor(DWELL_MS - 1);
  await page.waitForTimeout(SHOW_MS);
  expect(
    await railWidest(page),
    `collapsed through ${DWELL_MS - 1}ms of rest`,
  ).toBe(COLLAPSED);
  await page.clock.runFor(1);
  await expectRailWidth(page, EXPANDED);
  await page.clock.resume();
}

/** Sweep the pointer from `from` to `to` in `steps` interpolated moves,
 * each `stepPauseMs` of real time apart, with the page's clock stopped:
 * for the rail the whole crossing takes no time, so its dwell cannot
 * elapse inside it however slowly the harness moves. Then page time moves
 * well past the dwell, where a timer the crossing armed and failed to
 * cancel fires, and on in real time through the settle: the rail must
 * never have been drawn wider than collapsed. */
async function crossAndExpectNeverWider(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
  stepPauseMs = 0,
) {
  await page.mouse.move(from.x, from.y);
  await stopPageTime(page);
  await watchRailWidth(page);
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
    if (stepPauseMs > 0) await page.waitForTimeout(stepPauseMs);
  }
  await page.clock.runFor(DWELL_MS * 10);
  await page.waitForTimeout(SHOW_MS);
  await page.clock.resume();
  await page.waitForTimeout(SETTLE_MS);
  expect(
    await railWidest(page),
    "never drawn wider than collapsed, through the crossing and the settle",
  ).toBeLessThanOrEqual(COLLAPSED + 1);
}

test.use({ viewport: VIEWPORT });

// The builder: the left two-thirds are the hot zone, the right third is
// the corridor. ----

test("on the builder, a pointer crossing into the right third (the corridor) never expands it", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await page.clock.install();
  await openBuilder(page, context, "Rail corridor");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;

  // Cross the hot zone left-to-right in one interpolated sweep and come
  // to rest in the right third, as a pointer heading for the inspector
  // card does: three steps, two of them in the zone — a hand crosses
  // 36px well inside the dwell. Leaving the hot zone cancels the armed
  // timer; a timer that survived the exit would still fire and visibly
  // widen the rail (expansion is state, not :hover), so the page time
  // moved on after the crossing and the watch through the settle are
  // what prove the cancel.
  await crossAndExpectNeverWider(
    page,
    { x: box.x - 8, y: midY },
    { x: box.x + COLLAPSED - 6, y: midY },
    3,
  );

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("on the builder, resting on the left two-thirds expands after the dwell, never on entry", async ({
  page,
  context,
}) => {
  await page.clock.install();
  await openBuilder(page, context, "Rail hot zone");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;

  // Until the dwell has passed the rail has not begun to move — entry
  // alone must not expand it — and remaining there opens it.
  await restAndExpectDwell(page, box.x + LEFT_ZONE_X, midY);
});

test("on the builder, the right third never expands the rail, but its links still activate", async ({
  page,
  context,
}) => {
  await openBuilder(page, context, "Rail right third");
  const box = await railBox(page);

  const dataLink = rail(page).getByRole("link", { name: /data/i }).first();
  const linkBox = await dataLink.boundingBox();
  expect(linkBox).not.toBeNull();
  const x = box.x + RIGHT_THIRD_X;
  const linkY = linkBox!.y + linkBox!.height / 2;

  // Rest in the right third well past dwell + transition: still collapsed.
  await page.mouse.move(x, linkY);
  await page.waitForTimeout(SETTLE_MS);
  expect(Math.round((await railBox(page)).width)).toBe(COLLAPSED);

  // The link under that same point still activates on click.
  await page.mouse.click(x, linkY);
  await expect(page).toHaveURL(/\/data/);
});

// ---- Every page: what expansion and keyboard focus do once they happen
// is page-independent; run on the gallery. ----

test("on every page (run on the gallery), an expanded rail retains the pointer across its full width, and collapses on leave", async ({
  page,
}) => {
  await openPage(page, "/maps");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;

  await page.mouse.move(box.x + LEFT_ZONE_X, midY);
  await expectRailWidth(page, EXPANDED);

  // Move deep into the expanded rail's right side: still open.
  await page.mouse.move(box.x + EXPANDED - 12, midY);
  await page.waitForTimeout(600);
  expect(Math.round((await railBox(page)).width)).toBe(EXPANDED);

  // Leave: collapse.
  await page.mouse.move(box.x + EXPANDED + 260, midY);
  await expectRailWidth(page, COLLAPSED);
});

test("on every page (run on the gallery), keyboard focus expands the rail without any pointer", async ({
  page,
}) => {
  // Opening the page parks the pointer far from the rail, so only focus
  // can expand it.
  await openPage(page, "/maps");

  const railEl = rail(page);
  let inRail = false;
  for (let i = 0; i < 30 && !inRail; i += 1) {
    await page.keyboard.press("Tab");
    inRail = await railEl.evaluate(
      (nav) => nav.contains(document.activeElement),
    );
  }
  expect(inRail).toBe(true);
  await expectRailWidth(page, EXPANDED);
});

// Off the builder: the whole collapsed rail is the hot zone. The dwell
// holds on every page: the dwell is wanted, not an instant open — so a
// crossing never opens it
// anywhere and entry alone never does either. ----

test("off the builder (the maps gallery): resting on the right third expands after the dwell, never on entry", async ({
  page,
}) => {
  await page.clock.install();
  await openPage(page, "/maps");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;

  // Until the dwell has passed the rail has not begun to move: the wider
  // zone changes where a rest counts, not whether it must be a rest.
  // Remaining there opens it — the reading `main` cannot give, where the
  // right third is inert on every page.
  await restAndExpectDwell(page, box.x + RIGHT_THIRD_X, midY);
});

test("off the builder (the data explorer, reached through the rail): the right third expands after the dwell", async ({
  page,
}) => {
  await page.clock.install();
  await openPage(page, "/maps");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;

  // Reach the second page the ordinary way, through the rail's own link
  // (a client navigation); the pointer is then parked clear of the rail,
  // so the reading below starts from a collapsed rail with no armed
  // dwell.
  await rail(page).getByRole("link", { name: /data/i }).first().click();
  await expect(page).toHaveURL(/\/data/);
  await readyForPointer(page);
  await expectRailWidth(page, COLLAPSED);

  await restAndExpectDwell(page, box.x + RIGHT_THIRD_X, midY);
});

test("off the builder (the maps gallery): a pointer crossing the whole rail never expands it", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  await page.clock.install();
  await openPage(page, "/maps");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;

  // Cross the rail and LEAVE it on the far side, all inside the dwell:
  // with the whole rail hot there is no inert third to come to rest in,
  // so the crossing must exit the rail entirely, as a pointer heading
  // for the page does. Leaving cancels the armed timer; the page time
  // moved on after the crossing and the watch through the settle are
  // what prove the cancel.
  await crossAndExpectNeverWider(
    page,
    { x: box.x - 8, y: midY },
    { x: box.x + COLLAPSED + 40, y: midY },
    4,
  );

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("navigating builder → gallery → builder applies each page's rule, with no reload", async ({
  page,
  context,
}) => {
  // A name unique to this run: the instance keeps earlier runs' maps, and
  // the gallery's card control below is found by it.
  const name = `Rail hover ${Date.now().toString(36)}`;
  const mapId = await openBuilder(page, context, name);
  // A marker the document keeps only if every navigation below is a
  // client transition; a reload would lose it.
  await page.evaluate(() => {
    (window as unknown as { __railProbe?: string }).__railProbe = "kept";
  });
  const box = await railBox(page);
  const mapsLink = rail(page).getByRole("link", { name: /maps/i }).first();
  const linkBox = await mapsLink.boundingBox();
  expect(linkBox).not.toBeNull();
  const x = box.x + RIGHT_THIRD_X;
  const y = linkBox!.y + linkBox!.height / 2;

  // The builder: the right third is the corridor and never opens it.
  await page.mouse.move(x, y);
  await page.waitForTimeout(SETTLE_MS);
  expect(Math.round((await railBox(page)).width)).toBe(COLLAPSED);

  // Leave through the link under the pointer: a client navigation.
  await page.mouse.click(x, y);
  await expect(page).toHaveURL(/\/maps$/);

  // The gallery: the same position is now a resting hover. A pointer that
  // has not moved sends no event, so the nudge is what a hand does.
  await page.mouse.move(x + 1, y);
  await expectRailWidth(page, EXPANDED);

  // Leave to collapse, then back into the builder by the card itself
  // (a client push, not a load).
  await page.mouse.move(box.x + EXPANDED + 300, y);
  await expectRailWidth(page, COLLAPSED);
  await page
    .getByRole("link", { name: `Open ${name}`, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/maps/${mapId}$`));

  // The builder again: the corridor rule is back, without a reload.
  await page.mouse.move(x, y);
  await page.waitForTimeout(SETTLE_MS);
  expect(Math.round((await railBox(page)).width)).toBe(COLLAPSED);
  expect(
    await page.evaluate(
      () => (window as unknown as { __railProbe?: string }).__railProbe,
    ),
  ).toBe("kept");
});

// ---- Review, two findings, each with the case that
// failed before its fix. ----

test("a navigation the rail did not start, landing on the builder while a dwell is armed, does not open the corridor", async ({
  page,
  context,
}) => {
  // the zone is the route's, so a pending dwell can outlive
  // the zone it was armed under. A right-third rest on the gallery arms
  // the dwell; a map-card push the rail did not start commits inside it;
  // on the builder that same pointer sits in the inert corridor, and the
  // timer must not open the rail. The rail's cancel-on-click cannot see
  // a click that was not its own.
  //
  // The transition has to land inside the 100ms dwell to be the case at
  // all, so the builder's route response is fetched at once and HELD
  // until the pointer has armed the dwell, then released; and the page's
  // timers are paused from just before the pointer arms the dwell until
  // the push has committed, so the dwell cannot fire first however long
  // the commit takes on a busy machine.
  await page.clock.install();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  let held = 0;
  const name = `Rail armed ${Date.now().toString(36)}`;
  const mapId = await openBuilder(page, context, name, async (route) => {
    const url = new URL(route.request().url());
    const rsc =
      route.request().headers()["rsc"] === "1" || url.searchParams.has("_rsc");
    if (!holding || !rsc || !/^\/maps\/[^/]+$/.test(url.pathname)) return false;
    held += 1;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
    return true;
  });
  // The builder's client chunks are now cached; back to the gallery by
  // the rail's own link, and quiet.
  await rail(page).getByRole("link", { name: /maps/i }).first().click();
  await expect(page).toHaveURL(/\/maps$/);
  await readyForPointer(page);
  await expectRailWidth(page, COLLAPSED);
  const box = await railBox(page);
  const x = box.x + RIGHT_THIRD_X;
  const y = box.y + box.height / 2;

  // The push the rail did not start, held at its response...
  holding = true;
  await page
    .getByRole("link", { name: `Open ${name}`, exact: true })
    .click();
  await expect.poll(() => held, { timeout: 5000 }).toBeGreaterThan(0);
  // ...the page's timers stop...
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + DWELL_MS);
  // ...the pointer arms the gallery's dwell in the right third...
  await page.mouse.move(x, y);
  // ...and the navigation commits, inside the dwell.
  release();
  await page.waitForURL(new RegExp(`/maps/${mapId}$`));
  expect(
    Math.round((await railBox(page)).width),
    "the dwell had not fired when the navigation committed",
  ).toBe(COLLAPSED);
  await page.clock.resume();

  // The builder: the pointer is in the corridor; the dwell that was armed
  // on the gallery must not open the rail here.
  await page.waitForTimeout(SETTLE_MS);
  expect(Math.round((await railBox(page)).width)).toBe(COLLAPSED);
  // The rail still works on this page: the left zone opens it.
  await page.mouse.move(box.x + LEFT_ZONE_X, y);
  await expectRailWidth(page, EXPANDED);
});

test("harness: a crossing far slower than the dwell is still a crossing for the rail, and the watch sees a widening", async ({
  page,
}) => {
  // Under load the harness's own crossing took 220 to 251ms of real time
  // against a 100ms dwell. With the page's clock stopped that cannot
  // matter: here each step of the crossing is a whole dwell of real time
  // apart, and the rail must still read it as a crossing. Were the dwell
  // ever moved to a timer the page's clock does not own, this case fails
  // naming the harness, not the rail.
  await page.clock.install();
  await openPage(page, "/maps");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;
  await crossAndExpectNeverWider(
    page,
    { x: box.x - 8, y: midY },
    { x: box.x + COLLAPSED + 40, y: midY },
    4,
    DWELL_MS,
  );

  // The watch is not blind: a widening the rail did not make is recorded.
  await watchRailWidth(page);
  await rail(page).evaluate((nav) => {
    nav.style.width = "120px";
  });
  await expect
    .poll(() => railWidest(page), { timeout: 3000 })
    .toBeGreaterThan(COLLAPSED + 1);
  await rail(page).evaluate((nav) => {
    nav.style.width = "";
  });
});
