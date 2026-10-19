// The person's look, where it lives and when it arrives. Every account
// here is invited through the accounts API for this run and picks its
// look through the documented own-settings write, so the suite's fixture
// account keeps Dezfil's default look for every other journey.
//
// - The served document: a workspace page fetched over HTTP as the person
//   carries their look on the <html> start tag, in markup that styles the
//   page with no script, and an entry screen and a published page carry
//   none. The same check is shown red over the document with the look
//   taken off the tag, and over one whose look a script applies.
// - The first frame: an init script records the root as the parser
//   created it and again at the first animation frame, before anything
//   paints; both show the person's picks in a fresh browser, for a second
//   account too, and after one account signs out and another signs in.
//   The same check is shown red over a rewritten document whose look a
//   script applies after load.
// - A pick in the Appearance tab changes the page at once, and the list
//   page and the builder reached from it without a reload.
// - The Side menu's three behaviors on a list page and in the builder,
//   measured from the boxes on screen.
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { captureBasis, fixtureHeaders } from "../scripts/revision-fixtures.mjs";
import { isAllowedConsoleError } from "./console-allowlist";
import { seed } from "./export-fixture";
import {
  delayLook,
  describeEvidence,
  frameEvidence,
  frameProblems,
  installFrameRecorder,
  reversedEvidence,
  rootLook,
  servedLookProblems,
  setLook,
  stripLook,
  type LookAttributes,
} from "./look-evidence";
import { closeAll, invitePerson, PASSWORD, runTag, type Person } from "./sharing-support";
import { createMap, routeHouse, trackConsole, type ConsoleError } from "./support";

type Look = Record<string, string>;

/** Four picks off the default, one of them the rail standing open. */
const LOOK_A: Look = { color: "harbor", corners: "soft", rail: "open", background: "plain" };
/** Five picks off the default, sharing no value with the first. */
const LOOK_B: Look = { color: "heather", contrast: "more", font: "system", background: "hex", rail: "icons" };

const attrs = (look: Look): LookAttributes =>
  Object.fromEntries(Object.entries(look).map(([key, value]) => [`data-look-${key}`, value]).sort(([a], [b]) => a.localeCompare(b)));

/** The accent as the interface paints it: Kelp's and Harbor's light inks. */
const KELP_ACCENT = "rgb(13, 125, 92)";
const HARBOR_ACCENT = "rgb(43, 98, 166)";

/** The rail's two widths, and what the open rail moves every left edge beside it by. */
const COLLAPSED = 54;
const OPEN = 210;
const SHIFT = OPEN - COLLAPSED;
/** Past the rail's 100 ms dwell plus its width transition. */
const SETTLE_MS = 1100;

const rail = (page: Page) => page.locator('nav[aria-label="Product navigation"]');

function expectQuiet(errors: ConsoleError[]) {
  for (const err of errors) expect(isAllowedConsoleError(err.text, err.url), `${err.text} (${err.url ?? "no url"})`).toBe(true);
}

test.describe("the person's look", () => {
  test("the workspace document carries it on the <html> tag in markup; an entry screen and a published page carry none", async ({ browser, request, baseURL }) => {
    const people: Person[] = [];
    try {
      const person = await invitePerson(browser, request, baseURL!, "Served", runTag());
      people.push(person);
      await setLook(person.api, LOOK_A);

      await test.step("a workspace document, fetched over HTTP as the person", async () => {
        for (const path of ["/maps", "/settings/appearance"]) {
          const response = await person.api.get(path);
          expect(response.status(), path).toBe(200);
          const served = await response.text();
          expect(servedLookProblems(served, attrs(LOOK_A)), path).toEqual([]);
          // The red the same check must show: the look taken off the tag,
          // and the look applied by a script instead of carried in markup.
          const stripped = servedLookProblems(stripLook(served), attrs(LOOK_A));
          expect(stripped.length, `${path} without the look on its tag`).toBeGreaterThan(0);
          expect(stripped.join(" ")).toContain("the <html> start tag carries {}");
          const scripted = servedLookProblems(delayLook(served, attrs(LOOK_A)), attrs(LOOK_A));
          expect(scripted.some((problem) => problem.startsWith("a script applies a look")), `${path} with its look applied by script`).toBe(true);
        }
      });

      await test.step("an entry screen, as the signed-in person and as nobody", async () => {
        const accept = await person.api.get("/accept");
        expect(accept.status()).toBe(200);
        const entry = await accept.text();
        expect(entry).toContain("Choose your password");
        expect(servedLookProblems(entry, {})).toEqual([]);
        const nobody = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
        try {
          const signIn = await nobody.request.get("/sign-in");
          expect(signIn.status()).toBe(200);
          expect(servedLookProblems(await signIn.text(), {})).toEqual([]);
        } finally { await nobody.close(); }
      });

      await test.step("a published page, opened by the person", async () => {
        const created = await person.api.post("/api/maps", { data: { name: "Published look" } });
        expect(created.status()).toBe(201);
        const map = await created.json();
        const published = await person.api.post(`/api/maps/${map.id}/publish`, { headers: fixtureHeaders(captureBasis(map)) });
        expect(published.status(), await published.text()).toBe(201);
        const { token } = await published.json();
        const viewer = await person.api.get(`/v/${token}`);
        expect(viewer.status()).toBe(200);
        expect(servedLookProblems(await viewer.text(), {})).toEqual([]);

        await test.step("an address no page answers under the published or the render root, as the person and as nobody", async () => {
          const nobody = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
          try {
            const PUBLISHED = ["/v", `/v/${token}/extra`, "/v/no-such-token/extra/more"];
            const RENDER = ["/render", `/render/${map.id}/extra`];
            const served = async (who: "person" | "nobody", path: string) => {
              const response = await (who === "person" ? person.api : nobody.request).get(path, { maxRedirects: 0 });
              return { status: response.status(), location: response.headers().location ?? null, body: await response.text() };
            };
            for (const who of ["person", "nobody"] as const) {
              // A published address is public: whoever asks gets the published
              // view's not-found page, never the gate and never a look.
              for (const path of PUBLISHED) {
                const { status, location, body } = await served(who, path);
                expect({ status, location }, `${who} ${path}`).toEqual({ status: 404, location: null });
                expect(servedLookProblems(body, {}), `${who} ${path}`).toEqual([]);
                expect(body, `${who} ${path}`).toContain("Map not found");
                expect(body, `${who} ${path}`).toContain("This link is no longer available.");
                expect(body, `${who} ${path}`).not.toContain("Nothing is at this address.");
              }
            }
            // The render root is the authoring surface the server's renderer
            // reads: the person gets its plain not-found, nobody the gate,
            // as for a map's own render address.
            for (const path of RENDER) {
              const { status, location, body } = await served("person", path);
              expect({ status, location }, `person ${path}`).toEqual({ status: 404, location: null });
              expect(servedLookProblems(body, {}), `person ${path}`).toEqual([]);
              // Its one line, as markup or in the framework's payload, and none
              // of the words every workspace document carries.
              expect(body, `person ${path}`).toContain("Page not found");
              expect(body, `person ${path}`).not.toContain("Nothing is at this address.");
              expect(body, `person ${path}`).not.toContain("Map not found");
              const gated = await served("nobody", path);
              const own = await served("nobody", `/render/${map.id}`);
              expect({ status: gated.status, location: gated.location }, `nobody ${path}`).toEqual({ status: own.status, location: own.location });
              expect(gated.location ?? "", `nobody ${path}`).toMatch(/\/(sign-in|setup)(\?|$)/);
            }
            // The workspace's own unknown addresses, a page's and an API's,
            // answer 404 with the workspace's not-found page, the look on its
            // root; nobody gets the gate's own answer.
            for (const path of ["/no-such-page", "/api/nope", `/api/maps/${map.id}/nope`]) {
              const { status, location, body } = await served("person", path);
              expect({ status, location }, `person ${path}`).toEqual({ status: 404, location: null });
              expect(servedLookProblems(body, attrs(LOOK_A)), `person ${path}`).toEqual([]);
              expect(body, `person ${path}`).toContain("Page not found");
              expect(body, `person ${path}`).toContain("Nothing is at this address.");
              expect(body, `person ${path}`).not.toContain("Map not found");
            }
            const gated = await served("nobody", "/no-such-page");
            expect(gated.status, "nobody /no-such-page").toBe(307);
            expect(gated.location ?? "", "nobody /no-such-page").toMatch(/\/(sign-in|setup)(\?|$)/);
          } finally { await nobody.close(); }
        });
      });
    } finally {
      await closeAll(people);
    }
  });

  test("it shows from the first painted frame in a fresh browser, and each account sees its own", async ({ browser, request, baseURL }) => {
    const people: Person[] = [];
    try {
      const tag = runTag();
      const first = await invitePerson(browser, request, baseURL!, "First", tag);
      people.push(first);
      const second = await invitePerson(browser, request, baseURL!, "Second", tag);
      people.push(second);
      await setLook(first.api, LOOK_A);
      await setLook(second.api, LOOK_B);

      await test.step("a fresh browser signed in as the person: the created root and the first frame carry the look", async () => {
        // The context holds the session and nothing else: no page has
        // ever loaded in it, so no browser storage could decide anything.
        const page = await first.context.newPage();
        const errors = trackConsole(page);
        expect(await first.context.storageState().then((state) => state.origins.length)).toBe(0);
        await installFrameRecorder(page);
        await page.goto("/maps");
        const evidence = await frameEvidence(page);
        console.log(describeEvidence("first account, /maps", evidence));
        expect(frameProblems(evidence, attrs(LOOK_A))).toEqual([]);
        // The same record turned around fails the same check: a creation
        // after a page script, or a first paint before the frame.
        for (const { label, evidence: reversed } of reversedEvidence(evidence)) {
          expect(frameProblems(reversed, attrs(LOOK_A)).length, label).toBe(1);
        }
        expectQuiet(errors);
        await page.close();
      });

      await test.step("the same check fails over a document whose look a script applies after load", async () => {
        const page = await first.context.newPage();
        await installFrameRecorder(page);
        await page.route((url) => url.pathname === "/maps", async (route) => {
          if (route.request().resourceType() !== "document") return route.continue();
          const response = await route.fetch();
          const headers = { ...response.headers() };
          delete headers["content-length"];
          await route.fulfill({ response, headers, body: delayLook(await response.text(), attrs(LOOK_A)) });
        });
        await page.goto("/maps");
        const evidence = await frameEvidence(page);
        console.log(describeEvidence("first account, /maps rewritten with its look applied after load", evidence));
        expect(evidence.creation?.look).toEqual({});
        expect(frameProblems(evidence, attrs(LOOK_A)).length).toBeGreaterThan(0);
        // The rewritten page did take the look, late: the check caught
        // when it arrived, not a page without one.
        await expect.poll(() => rootLook(page)).toEqual(attrs(LOOK_A));
        await page.close();
      });

      await test.step("a second account, in a fresh browser of its own, sees its own look", async () => {
        const page = await second.context.newPage();
        const errors = trackConsole(page);
        await installFrameRecorder(page);
        await page.goto("/data");
        const evidence = await frameEvidence(page);
        console.log(describeEvidence("second account, /data", evidence));
        expect(frameProblems(evidence, attrs(LOOK_B))).toEqual([]);
        expectQuiet(errors);
        await page.close();
      });

      await test.step("one account signs out and another signs in in the same browser: the second's look from its first paint", async () => {
        const page = await first.context.newPage();
        await page.goto("/maps");
        expect(await rootLook(page)).toEqual(attrs(LOOK_A));
        await page.close();
        expect((await first.api.post("/api/auth/sign-out")).status()).toBe(200);
        const signedIn = await first.api.post("/api/auth/sign-in", { data: { email: second.email, password: PASSWORD } });
        expect(signedIn.status(), await signedIn.text()).toBe(200);
        const next = await first.context.newPage();
        const errors = trackConsole(next);
        await installFrameRecorder(next);
        await next.goto("/maps");
        const evidence = await frameEvidence(next);
        console.log(describeEvidence("second account after the first signed out, same browser, /maps", evidence));
        // Exactly the second's picks: nothing of the first's (its corners,
        // its open rail, its plain background) is left on the root.
        expect(frameProblems(evidence, attrs(LOOK_B))).toEqual([]);
        expectQuiet(errors);
        await next.close();
      });
    } finally {
      await closeAll(people);
    }
  });

  test("a pick changes the page at once, and the list page and the builder reached from it", async ({ browser, request, baseURL }) => {
    const people: Person[] = [];
    try {
      const person = await invitePerson(browser, request, baseURL!, "Picker", runTag());
      people.push(person);
      await routeHouse(person.context, { basemapStyleStub: true });
      const page = await person.context.newPage();
      const errors = trackConsole(page);
      await page.goto("/maps");
      await createMap(page, "Look at once");

      const ink = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).color);
      await page.goto("/settings/appearance");
      const color = page.getByRole("radiogroup", { name: "Color" });
      await expect(color.getByRole("radio", { name: "Kelp" })).toHaveAttribute("aria-checked", "true");
      expect(await rootLook(page)).toEqual({});
      const settings = rail(page).getByRole("link", { name: "Settings" });
      expect(await ink(settings)).toBe(KELP_ACCENT);
      // A mark on this document: it survives only while no page reloads.
      await page.evaluate(() => { (window as { __sameDocument?: boolean }).__sameDocument = true; });
      const sameDocument = () => page.evaluate(() => (window as { __sameDocument?: boolean }).__sameDocument === true);

      await test.step("the pick changes the page at once and is kept", async () => {
        await color.getByRole("radio", { name: "Harbor" }).click();
        await expect.poll(() => rootLook(page)).toEqual({ "data-look-color": "harbor" });
        await expect.poll(() => ink(settings)).toBe(HARBOR_ACCENT);
        await expect.poll(async () => (await (await person.api.get("/api/settings")).json()).look.color).toBe("harbor");
        expect(await sameDocument()).toBe(true);
      });

      await test.step("a list page reached by the rail shows it, with no reload", async () => {
        await rail(page).getByRole("link", { name: "Maps" }).click();
        await expect(page).toHaveURL(/\/maps$/);
        await expect(page.getByRole("link", { name: "Open Look at once", exact: true })).toBeVisible();
        expect(await sameDocument()).toBe(true);
        expect(await rootLook(page)).toEqual({ "data-look-color": "harbor" });
        expect(await ink(rail(page).getByRole("link", { name: "Maps" }))).toBe(HARBOR_ACCENT);
      });

      await test.step("the builder reached from the list shows it, with no reload", async () => {
        await page.getByRole("link", { name: "Open Look at once", exact: true }).click();
        const panels = page.getByRole("tablist", { name: "Builder panels" });
        await expect(panels).toBeVisible({ timeout: 30_000 });
        expect(await sameDocument()).toBe(true);
        expect(await rootLook(page)).toEqual({ "data-look-color": "harbor" });
        expect(await ink(panels.getByRole("tab", { selected: true }))).toBe(HARBOR_ACCENT);
      });

      await test.step("a full load of each is served with it", async () => {
        for (const path of ["/maps", page.url()]) {
          await page.goto(path);
          expect(await rootLook(page)).toEqual({ "data-look-color": "harbor" });
          expect(await ink(rail(page).getByRole("link", { name: "Maps" }))).toBe(HARBOR_ACCENT);
        }
        expect(await ink(page.getByRole("tablist", { name: "Builder panels" }).getByRole("tab", { selected: true }))).toBe(HARBOR_ACCENT);
      });
      expectQuiet(errors);
    } finally {
      await closeAll(people);
    }
  });

  test.describe("the Side menu", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("opens on hover, stands open or stays icons, on a list page and in the builder", async ({ browser, request, baseURL }) => {
      const people: Person[] = [];
      try {
        const person = await invitePerson(browser, request, baseURL!, "Rail", runTag());
        people.push(person);
        await routeHouse(person.context, { basemapStyleStub: true });
        const page = await person.context.newPage();
        const errors = trackConsole(page);
        const { mapId } = await seed(page);

        const railWidth = async () => Math.round((await rail(page).boundingBox())!.width);
        const expectRailWidth = (width: number) => expect.poll(railWidth, { timeout: 3_000 }).toBe(width);
        /** Rest the pointer on the rail's left two-thirds (the builder's hot zone, and the whole rail elsewhere). */
        const restOnRail = async () => {
          const box = (await rail(page).boundingBox())!;
          await page.mouse.move(box.x + 18, box.y + box.height / 2);
          await page.waitForTimeout(SETTLE_MS);
        };
        const awayFromRail = () => page.mouse.move(1200, 500);
        /** Keyboard focus into the rail: focus the control just before the
         * rail's first item, then one Tab, so the rail is reached by key. */
        const tabIntoRail = async () => {
          await awayFromRail();
          await page.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="Product navigation"]')!;
            const focusable = Array.from(document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'))
              .filter((el) => el.getClientRects().length > 0);
            const first = focusable.findIndex((el) => nav.contains(el));
            focusable[first - 1]?.focus();
          });
          await page.keyboard.press("Tab");
          expect(await page.evaluate(() => document.activeElement?.closest('nav[aria-label="Product navigation"]') != null), "one Tab reaches the rail").toBe(true);
        };
        const leaveFocus = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        /** No finite animation or transition is still running: the shell has settled in. */
        const settled = () => expect.poll(() => page.evaluate(() => document.getAnimations()
          .filter((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity).length), { timeout: 5_000 }).toBe(0);
        /** How visible the rail's own word for an item is. */
        const labelOpacity = (name: string) => rail(page).getByText(name, { exact: true }).evaluate((el) => getComputedStyle(el).opacity);
        const left = async (locator: Locator) => Math.round((await locator.boundingBox())!.x);
        const right = async (locator: Locator) => { const box = (await locator.boundingBox())!; return Math.round(box.x + box.width); };

        const main = page.locator("main").first();
        const openList = async () => {
          await page.goto("/maps");
          await expect(page.getByRole("link", { name: "Open Export flow", exact: true })).toBeVisible();
          await settled();
        };
        const inspector = page.locator('[class*="MapBuilder-module"][class*="__rail"]').filter({ has: page.getByRole("tablist", { name: "Builder panels" }) });
        const head = page.locator('header [class*="headCard"]');
        const stage = page.locator('[class*="canvasCol"]').first();
        const stack = page.locator('[class*="stageStack"]').first();
        const legend = page.locator('[class*="overlayCorner"][data-corner="bottom-left"]').first();
        const status = page.locator('[class*="statusCorner"]').first();
        const openBuilder = async () => {
          await page.goto(`/maps/${mapId}`);
          await expect(page.getByText("12 features").first()).toBeVisible({ timeout: 30_000 });
          await expect(legend).toBeVisible();
          await settled();
        };
        const builderEdges = async () => ({
          inspector: await left(inspector),
          stage: await left(stage),
          stack: await left(stack),
          legend: await left(legend),
          status: await left(status),
          headLeft: await left(head),
        });
        /** The header card reaches the inspector's right edge, measured once it has settled. */
        const expectHeadReachesInspector = async () =>
          expect.poll(async () => (await right(head)) - (await right(inspector)), { timeout: 5_000 }).toBe(0);

        let listLeft = 0;
        let edges: Awaited<ReturnType<typeof builderEdges>> | null = null;
        let headRight = 0;

        await test.step("Opens on hover: a resting pointer and keyboard focus open the rail over the page; nothing moves", async () => {
          await setLook(person.api, { rail: "hover" });
          await openList();
          expect(await rootLook(page)).toEqual({});
          await expectRailWidth(COLLAPSED);
          expect(await labelOpacity("Projects")).toBe("0");
          listLeft = await left(main);
          await restOnRail();
          await expectRailWidth(OPEN);
          expect(await left(main)).toBe(listLeft);
          await awayFromRail();
          await expectRailWidth(COLLAPSED);
          await tabIntoRail();
          await expectRailWidth(OPEN);
          expect(await left(main)).toBe(listLeft);
          await leaveFocus();

          await openBuilder();
          await expectRailWidth(COLLAPSED);
          edges = await builderEdges();
          await expectHeadReachesInspector();
          headRight = await right(head);
          await restOnRail();
          await expectRailWidth(OPEN);
          expect(await builderEdges()).toEqual(edges);
          await awayFromRail();
          await expectRailWidth(COLLAPSED);
        });

        await test.step("Always open: the rail stands open beside the page, and everything beside it moves right, lined up", async () => {
          await setLook(person.api, { rail: "open" });
          await openList();
          expect(await rootLook(page)).toEqual({ "data-look-rail": "open" });
          await awayFromRail();
          await expectRailWidth(OPEN);
          await expect.poll(() => labelOpacity("Projects")).toBe("1");
          expect(await left(main)).toBe(listLeft + SHIFT);
          await restOnRail();
          await awayFromRail();
          await expectRailWidth(OPEN);

          await openBuilder();
          await expectRailWidth(OPEN);
          const moved = await builderEdges();
          const base = edges!;
          expect(moved).toEqual({
            inspector: base.inspector + SHIFT,
            stage: base.stage + SHIFT,
            stack: base.stack + SHIFT,
            legend: base.legend + SHIFT,
            status: base.status + SHIFT,
            // The header card keeps its left edge.
            headLeft: base.headLeft,
          });
          // The rail stands beside the inspector, not over it.
          expect(await right(rail(page))).toBeLessThanOrEqual(moved.inspector);
          // The header card keeps its left edge and widens to the inspector's
          // right edge: the header's actions give it the room, the whole
          // row staying on screen.
          await expectHeadReachesInspector();
          const actionsRight = await right(page.locator('header [class*="actions"]').first());
          console.log(`[rail] 1440 x 900, Always open: header card right ${await right(head)}, inspector right ${await right(inspector)}, under Opens on hover ${headRight}, actions right ${actionsRight}`);
          expect(actionsRight).toBeLessThanOrEqual(1440);
          await page.setViewportSize({ width: 1920, height: 1080 });
          await openBuilder();
          await expectRailWidth(OPEN);
          expect(await left(head)).toBe(base.headLeft);
          await expectHeadReachesInspector();
          console.log(`[rail] 1920 x 1080, Always open: header card right ${await right(head)}, inspector right ${await right(inspector)}`);
          await page.setViewportSize({ width: 1440, height: 900 });
        });

        await test.step("Icons only: the rail never opens by pointer or focus, and each item names itself beside its icon", async () => {
          await setLook(person.api, { rail: "icons" });
          await openList();
          expect(await rootLook(page)).toEqual({ "data-look-rail": "icons" });
          expect(await left(main)).toBe(listLeft);
          const bubble = page.locator("[data-hint-bubble]");
          /** The hint stands beside the item's icon, right of it and level with it, never over it. */
          const expectHintBeside = async (item: Locator, text: string) => {
            await expect(bubble).toHaveText(text);
            await expect(bubble).toHaveAttribute("data-beside", "true");
            const itemBox = (await item.boundingBox())!;
            const bubbleBox = (await bubble.boundingBox())!;
            expect(bubbleBox.x).toBeGreaterThanOrEqual(itemBox.x + itemBox.width);
            expect(bubbleBox.y).toBeLessThan(itemBox.y + itemBox.height);
            expect(bubbleBox.y + bubbleBox.height).toBeGreaterThan(itemBox.y);
          };
          const maps = rail(page).getByRole("link", { name: "Maps" });
          const mapsBox = (await maps.boundingBox())!;
          await page.mouse.move(mapsBox.x + 18, mapsBox.y + mapsBox.height / 2);
          await page.waitForTimeout(SETTLE_MS);
          await expectRailWidth(COLLAPSED);
          expect(await labelOpacity("Projects")).toBe("0");
          await expectHintBeside(maps, "Maps");
          const account = rail(page).getByRole("link", { name: `${person.name}, account` });
          const accountBox = (await account.boundingBox())!;
          await page.mouse.move(accountBox.x + 18, accountBox.y + accountBox.height / 2);
          await page.waitForTimeout(SETTLE_MS);
          await expectRailWidth(COLLAPSED);
          await expectHintBeside(account, person.name);
          await tabIntoRail();
          await page.waitForTimeout(SETTLE_MS);
          await expectRailWidth(COLLAPSED);
          await leaveFocus();

          await openBuilder();
          expect(await builderEdges()).toEqual(edges);
          await restOnRail();
          await expectRailWidth(COLLAPSED);
          await tabIntoRail();
          await page.waitForTimeout(SETTLE_MS);
          await expectRailWidth(COLLAPSED);
          await leaveFocus();
        });
        expectQuiet(errors);
      } finally {
        await closeAll(people);
      }
    });
  });
});
