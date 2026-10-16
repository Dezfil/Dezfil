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
// The dwell is short, so the harness measures its own conditions rather
// than assuming them: pages are opened to a quiet main thread, crossings
// time their own round trips, and the watched windows must have been
// observed continuously. A case that cannot meet its condition fails
// naming the harness, never the rail.
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
/** The dwell, stated as a setting (RailShell): the crossings below must
 * complete inside it, and each measures its own harness time against it
 * so a slow harness names itself rather than the product. */
const DWELL_MS = 100;
/** A pause safely past the dwell plus the width transition. */
const SETTLE_MS = 1100;
/** A point inside the left two-thirds (which end at 36px of the 54px). */
const LEFT_ZONE_X = 18;
/** A point inside the right third (past 36px = 2/3 of the collapsed 54px). */
const RIGHT_THIRD_X = 44;
/** How long after arrival the rail must still be collapsed: inside the
 * dwell with room for timer jitter, and far enough into an undwelled
 * animation that it could not still read as collapsed. Measured on a
 * seeded zero dwell: the attribute flips within 6ms of arrival but the
 * rendered width holds at 54 until the transition's first frame, 40 to
 * 60ms later in headless, and reads 109px or more by 80ms; with the real
 * dwell the width first moves at 113ms or later. */
const ON_ENTRY_WINDOW_MS = 80;
/** How long a crossing is watched for a flicker: past the dwell and the
 * whole expansion animation, so a timer that fired late shows too. */
const CROSSING_WATCH_MS = 500;
/** The widest gap a watched window may have between two samples and still
 * count as observed: a stall longer than this could hide a state change
 * behind the window's last sample. */
const MAX_SAMPLE_GAP_MS = 20;

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

/** Wait for the page's main thread to be quiet, measured rather than
 * assumed: while a page hydrates or a map initialises, one pointer round
 * trip can cost 40ms or more, a sweep made of such trips could not cross
 * the hot zone inside the dwell, and a stall inside a watched window
 * defers the very state change the window is meant to see. So probe
 * moves far from the rail until three trips in a row are cheap. */
async function awaitQuiet(page: Page) {
  const deadline = Date.now() + 10_000;
  let quiet = 0;
  while (quiet < 3 && Date.now() < deadline) {
    const t = Date.now();
    await page.mouse.move(1200, 500 + (quiet % 2));
    quiet = Date.now() - t < 20 ? quiet + 1 : 0;
  }
  expect(quiet, "the page's main thread went quiet").toBe(3);
}

/** A workspace page, opened and quiet. */
async function openPage(page: Page, path: string) {
  await page.goto(path);
  await awaitQuiet(page);
}

/** The builder: a fresh map, opened, its panel strip mounted, its map
 * canvas up, and quiet. The house route policy keeps the basemap off the
 * network. */
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
  await awaitQuiet(page);
  return mapId;
}

type Watch = { seen: boolean; last: number; gap: number; widths: number[] };
type Armed = Window & { __railWatch?: Promise<Watch> };

/** Arm an in-page watcher on the rail: from its next pointermove, sample
 * the rail's box width every millisecond or so through `windowMs`, in
 * the page's own clock, recording the widest gap between samples. Armed
 * and awaited BEFORE the move that should trip it, so the move cannot be
 * dispatched first; collected after. */
async function armWatch(page: Page, windowMs: number) {
  await rail(page).evaluate((nav, windowMs) => {
    (window as Armed).__railWatch = new Promise<Watch>((resolve) => {
      let t0: number | null = null;
      let prev: number | null = null;
      let gap = 0;
      let last = 0;
      const widths: number[] = [];
      nav.addEventListener(
        "pointermove",
        () => {
          if (t0 === null) {
            t0 = performance.now();
            // Arrival is the first point of the window: the gap to the
            // first sample counts, or a stall there would hide the whole
            // window behind one late sample.
            prev = t0;
          }
        },
        { capture: true, once: true },
      );
      const started = performance.now();
      const tick = () => {
        const now = performance.now();
        if (t0 !== null) {
          last = now - t0;
          if (prev !== null) gap = Math.max(gap, now - prev);
          prev = now;
          widths.push(nav.getBoundingClientRect().width);
          if (last >= windowMs)
            return resolve({ seen: true, last, gap, widths });
        } else if (now - started > 3000) {
          return resolve({ seen: false, last, gap, widths });
        }
        setTimeout(tick, 1);
      };
      tick();
    });
  }, windowMs);
}

/** Collect the armed watcher and require that its window was actually
 * seen: the pointer arrived, the whole window elapsed, and no stall
 * inside it, from arrival on, could have hidden a state change behind
 * the last sample. */
async function collectWatch(page: Page, windowMs: number) {
  const { seen, last, gap, widths } = await page.evaluate(
    () => (window as Armed).__railWatch!,
  );
  expect(seen, "the rail received the pointer").toBe(true);
  expect(last, "the window after arrival was observed").toBeGreaterThanOrEqual(
    windowMs,
  );
  expect(
    gap,
    `the window was continuously observed (widest gap ${gap.toFixed(1)}ms)`,
  ).toBeLessThan(MAX_SAMPLE_GAP_MS);
  return widths;
}

/** Come to rest at (x, y) and watch the rail from the pointer's arrival
 * through `windowMs`: every sample must still be collapsed. One read
 * straight after the move cannot show a dwell — the first millisecond of
 * an animation leaves the width at 54 too — so the window is observed
 * in-page; it is well inside the dwell, and an animation with no dwell
 * is visibly wider long before it ends. */
async function restOnAndExpectCollapsedThrough(
  page: Page,
  x: number,
  y: number,
  windowMs: number,
) {
  await armWatch(page, windowMs);
  await page.mouse.move(x, y);
  const widths = await collectWatch(page, windowMs);
  expect(
    Math.round(Math.max(...widths)),
    `collapsed through ${windowMs}ms after arrival (${widths.length} samples)`,
  ).toBe(COLLAPSED);
}

/** Sweep the pointer from `from` to `to` in `steps` interpolated moves and
 * watch the rail from its first pointermove through `watchMs`: it must
 * never have been wider than collapsed. A crossing that leaves the rail
 * collapses it again on leave, so a dwell that fired mid-crossing would
 * show only as a flicker a sample taken after the sweep can miss; the
 * watcher samples through it. Each step is a round trip of its own, so
 * the sweep also times itself against the dwell. */
async function crossAndExpectNeverWider(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
  watchMs: number,
) {
  await page.mouse.move(from.x, from.y);
  await armWatch(page, watchMs);
  const sweepStart = Date.now();
  await page.mouse.move(to.x, to.y, { steps });
  expect(
    Date.now() - sweepStart,
    "the harness crossed inside the dwell",
  ).toBeLessThan(DWELL_MS);
  const widths = await collectWatch(page, watchMs);
  expect(
    Math.round(Math.max(...widths)),
    `never wider than collapsed through ${watchMs}ms after arrival`,
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
  await openBuilder(page, context, "Rail corridor");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;

  // Cross the hot zone left-to-right in one interpolated sweep and come
  // to rest in the right third, as a pointer heading for the inspector
  // card does: three steps, two of them in the zone — a hand crosses
  // 36px in that order of time. Leaving the hot zone cancels the armed
  // timer; a timer that survived the exit would still fire and visibly
  // widen the rail (expansion is state, not :hover), so the watched
  // window and the sampling after it are what prove the cancel.
  await crossAndExpectNeverWider(
    page,
    { x: box.x - 8, y: midY },
    { x: box.x + COLLAPSED - 6, y: midY },
    3,
    CROSSING_WATCH_MS,
  );
  const start = Date.now();
  while (Date.now() - start < SETTLE_MS) {
    expect(Math.round((await railBox(page)).width)).toBeLessThanOrEqual(
      COLLAPSED + 1,
    );
    await page.waitForTimeout(80);
  }

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("on the builder, resting on the left two-thirds expands after the dwell, never on entry", async ({
  page,
  context,
}) => {
  await openBuilder(page, context, "Rail hot zone");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;

  // Through the first stretch after entry the rail has not begun to move
  // — entry alone must not expand it.
  await restOnAndExpectCollapsedThrough(
    page,
    box.x + LEFT_ZONE_X,
    midY,
    ON_ENTRY_WINDOW_MS,
  );

  // Remaining there opens it.
  await expectRailWidth(page, EXPANDED);
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
  // The quiet probe parks the pointer far from the rail, so only focus
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
  await openPage(page, "/maps");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;

  // Through the first stretch after entry the rail has not begun to
  // move: the wider zone changes where a rest counts, not whether it
  // must be a rest.
  await restOnAndExpectCollapsedThrough(
    page,
    box.x + RIGHT_THIRD_X,
    midY,
    ON_ENTRY_WINDOW_MS,
  );

  // Remaining there opens it — the reading `main` cannot give, where
  // the right third is inert on every page.
  await expectRailWidth(page, EXPANDED);
});

test("off the builder (the data explorer, reached through the rail): the right third expands after the dwell", async ({
  page,
}) => {
  await openPage(page, "/maps");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;

  // Reach the second page the ordinary way, through the rail's own link
  // (a client navigation); the quiet probe then parks the pointer clear
  // of the rail, so the reading below starts from a collapsed rail with
  // no armed dwell.
  await rail(page).getByRole("link", { name: /data/i }).first().click();
  await expect(page).toHaveURL(/\/data/);
  await awaitQuiet(page);
  await expectRailWidth(page, COLLAPSED);

  await restOnAndExpectCollapsedThrough(
    page,
    box.x + RIGHT_THIRD_X,
    midY,
    ON_ENTRY_WINDOW_MS,
  );
  await expectRailWidth(page, EXPANDED);
});

test("off the builder (the maps gallery): a pointer crossing the whole rail never expands it", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  await openPage(page, "/maps");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;

  // Cross the rail and LEAVE it on the far side, all inside the dwell:
  // with the whole rail hot there is no inert third to come to rest in,
  // so the crossing must exit the rail entirely, as a pointer heading
  // for the page does. Leaving cancels the armed timer; the watched
  // window and the sampling after it are what prove the cancel.
  await crossAndExpectNeverWider(
    page,
    { x: box.x - 8, y: midY },
    { x: box.x + COLLAPSED + 40, y: midY },
    4,
    CROSSING_WATCH_MS,
  );
  const start = Date.now();
  while (Date.now() - start < SETTLE_MS) {
    expect(Math.round((await railBox(page)).width)).toBeLessThanOrEqual(
      COLLAPSED + 1,
    );
    await page.waitForTimeout(80);
  }

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

  // Leave to collapse, then back into the builder by the card's own
  // control (a client push, not a load).
  await page.mouse.move(box.x + EXPANDED + 300, y);
  await expectRailWidth(page, COLLAPSED);
  await page
    .getByRole("button", { name: `Open ${name} in the builder`, exact: true })
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
  await awaitQuiet(page);
  await expectRailWidth(page, COLLAPSED);
  const box = await railBox(page);
  const x = box.x + RIGHT_THIRD_X;
  const y = box.y + box.height / 2;

  // The push the rail did not start, held at its response...
  holding = true;
  await page
    .getByRole("button", { name: `Open ${name} in the builder`, exact: true })
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

test("harness: a watched window names a stall between the pointer's arrival and its first sample", async ({
  page,
}) => {
  // the continuity guard measured gaps between samples only,
  // so a stall after arrival but before the first sample was invisible
  // — the watcher reported the window seen with one sample taken after
  // the stall, and the same stall that hid the window would have
  // postponed the animation it was meant to catch. The reproduction: a
  // listener registered after the watcher's, so it runs once arrival is
  // timed, blocks the main thread past the whole window. The guard must
  // refuse that window.
  await openPage(page, "/maps");
  const box = await railBox(page);
  const midY = box.y + box.height / 2;
  await armWatch(page, ON_ENTRY_WINDOW_MS);
  await rail(page).evaluate((nav, stallMs) => {
    nav.addEventListener(
      "pointermove",
      () => {
        const until = performance.now() + stallMs;
        while (performance.now() < until) {
          /* the seeded stall */
        }
      },
      { capture: true, once: true },
    );
  }, ON_ENTRY_WINDOW_MS + 10);
  await page.mouse.move(box.x + RIGHT_THIRD_X, midY);
  await expect(collectWatch(page, ON_ENTRY_WINDOW_MS)).rejects.toThrow(
    /continuously observed/,
  );
});
