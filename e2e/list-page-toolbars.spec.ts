// The five list pages' toolbar and grid from zero items on: the
// toolbar's persistent controls present at zero and in the same order
// as with items; the Data page's derived source chips still following
// what it holds; no persistent control vanishing or moving merely
// because the list stopped being empty; Connections' search and sort;
// the new-item card as the grid's first cell on the four pages that
// draw a grid, Connections keeping its single centred card; the
// Connections list in the shared list frame, outer to outer; and the
// four corrections the design round found. One test per criterion, so a
// red run names what is wrong rather than stopping at the first
// difference.
//
// The zero-state tests want a fresh data directory (the runbook's
// isolated instance): they run before any seeding here and skip, naming
// the reason, when the instance already holds something. The transition
// test then seeds exactly one item per page, so its "first item" state
// is the one the criterion describes.
//
// removed the heading's count pill, which this file had been using as
// its readiness anchor on five populated reads. Each of those waits now
// stands on the seeded item's own name (or, for the stubbed ledger, on
// its three rows): the same synchronisation point, moved rather than
// deleted, since deleting it would leave a race that passes locally.
import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { routeHouse, seedCsv } from "./support";

const runId = Date.now().toString(36);
const CSV = "name,lng,lat\nBuoy A,7.10,53.52\n";

type Box = { x: number; y: number; w: number; h: number };
type Control = { key: string; box: Box };

type PageSpec = {
  path: string;
  title: string;
  /** The controls the page keeps at every size, in the order the row
   * shows them. A control is keyed by its accessible name with any count
   * suffix stripped ("All · 3" reads as "All"); the search box is keyed
   * as "search", so a placeholder rename is not this list's business.
   * Chips a page derives from what it holds are not here. */
  persistent: string[];
  /** The ghost tile's caption, the zero state's readiness anchor. */
  emptyMark: string;
  /** The ghost tile's accessible name: its label with its caption, so
   * the heading's primary button, which shares the label, never stands
   * in for it (the first red run resolved two). */
  ghost: RegExp;
  /** Draws a grid: the ghost is its first cell at zero and afterwards. */
  grid: boolean;
  /** Adds one real item through the API (Connections is stubbed). */
  seedOne: ((page: Page, n: number) => Promise<void>) | null;
  /** The nth seeded item's own name. Count pill was this file's
   * readiness anchor for "the item has landed"; removed it, so every
   * such wait stands on the item itself, which says the same thing and
   * says it about content rather than about a number. */
  itemName: (n: number) => string;
};

const api = (page: Page, method: string, pathName: string, body?: unknown) =>
  page.evaluate(
    async ({ method, pathName, body }) => {
      const r = await fetch(pathName, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok && r.status !== 204) throw new Error(await r.text());
      const text = r.status === 204 ? "" : await r.text();
      return text ? (JSON.parse(text) as unknown) : null;
    },
    { method, pathName, body },
  );

const PAGES: PageSpec[] = [
  {
    path: "/projects",
    title: "Projects",
    persistent: ["search", "Sort projects", "Grid view", "List view"],
    emptyMark: "A name, nothing else",
    ghost: /^New project .*nothing else/i,
    grid: true,
    seedOne: async (page, n) => {
      await api(page, "POST", "/api/projects", { name: `Shelf ${n} ${runId}` });
    },
    itemName: (n) => `Shelf ${n} ${runId}`,
  },
  {
    path: "/maps",
    title: "Maps",
    persistent: [
      "Filter by project",
      "search",
      "All",
      "Published",
      "Drafts",
      "Sort maps",
      "Grid view",
      "List view",
    ],
    emptyMark: "Start from a blank map",
    ghost: /^New map Start from/,
    grid: true,
    seedOne: async (page, n) => {
      await api(page, "POST", "/api/maps", { name: `Chart ${n} ${runId}` });
    },
    itemName: (n) => `Chart ${n} ${runId}`,
  },
  {
    path: "/workflows",
    title: "Workflows",
    persistent: [
      "Filter by project",
      "search",
      "All",
      "Needs attention",
      "Never run",
      "Sort workflows",
      "Grid view",
      "List view",
    ],
    emptyMark: "Start from a blank canvas",
    ghost: /^New workflow Start from/,
    grid: true,
    seedOne: async (page, n) => {
      await api(page, "POST", "/api/recipes", {
        name: `Chain ${n} ${runId}`,
        origin: "workflow",
      });
    },
    itemName: (n) => `Chain ${n} ${runId}`,
  },
  {
    path: "/data",
    title: "Data",
    persistent: [
      "Filter by project",
      "search",
      "All",
      "Sort tables",
      "Grid view",
      "List view",
    ],
    emptyMark: "Upload a file or import from a source",
    ghost: /^Add data Upload a file/,
    grid: true,
    // A CSV upload: the first item legitimately introduces the Files chip.
    seedOne: async (page, n) => {
      await seedCsv(page, `lpt_${n}_${runId}`, CSV);
    },
    itemName: (n) => `lpt_${n}_${runId}`,
  },
  {
    path: "/connections",
    title: "Connections",
    persistent: ["search", "Sort connections"],
    emptyMark: "Snapshot tables from a PostGIS database",
    ghost: /^Add connection Snapshot/,
    grid: false,
    seedOne: null,
    itemName: (n) => `Warehouse ${n}`,
  },
];

/* Connections are tested against a live database on creation, so the
   ledger is stubbed at the list route with a count the
   test moves; everything else on the page reaches the real instance. */
type StubConnection = {
  id: string;
  name: string;
  createdAt: string;
  lastCheckedAt: string | null;
  status: "connected" | "never_checked";
};

const json = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

function connection(c: StubConnection) {
  return {
    id: c.id,
    name: c.name,
    host: "db.internal",
    port: 5432,
    database: "mobility",
    username: "dezfil_ro",
    ssl: true,
    createdAt: c.createdAt,
    status: c.status,
    lastCheckedAt: c.lastCheckedAt,
    lastCheckError: null,
    serverVersion: c.status === "connected" ? "PostgreSQL 16.4" : null,
    postgisVersion: c.status === "connected" ? "3.4.2" : null,
  };
}

const warehouses = (count: number): StubConnection[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `c-${i}`,
    name: `Warehouse ${i + 1}`,
    createdAt: "2026-08-31T08:00:00.000Z",
    lastCheckedAt: "2026-08-31T08:00:00.000Z",
    status: "connected",
  }));

async function stubConnections(
  context: BrowserContext,
  initial: StubConnection[],
) {
  const stub = { list: initial, tested: [] as string[] };
  await routeHouse(context, {
    handler: async (route) => {
      const { pathname } = new URL(route.request().url());
      const method = route.request().method();
      if (pathname === "/api/connections/postgis" && method === "GET") {
        await json(route, stub.list.map(connection));
        return true;
      }
      const testMatch = /^\/api\/connections\/postgis\/([^/]+)\/test$/.exec(pathname);
      if (testMatch && method === "POST") {
        const found = stub.list.find((c) => c.id === testMatch[1]);
        if (!found) return false;
        stub.tested.push(found.id);
        await json(route, connection({ ...found, status: "connected" }));
        return true;
      }
      if (
        method === "GET" &&
        /^\/api\/connections\/postgis\/[^/]+\/snapshots$/.test(pathname)
      ) {
        await json(route, { snapshots: [] });
        return true;
      }
      return false;
    },
  });
  return stub;
}

/* The toolbar's controls in DOM order, each keyed by its accessible name
   with any count suffix stripped, with its box. Absent toolbar: an empty
   census, so a red run says "none" rather than timing out. */
const toolbar = (page: Page) => page.locator('main [class*="toolbar"]');

async function census(page: Page): Promise<Control[]> {
  if ((await toolbar(page).count()) === 0) return [];
  return toolbar(page)
    .first()
    .evaluate((el) =>
      Array.from(el.querySelectorAll("input, select, button")).map((c) => {
        const r = c.getBoundingClientRect();
        const box = { x: r.x, y: r.y, w: r.width, h: r.height };
        if (c.tagName === "INPUT") return { key: "search", box };
        const name = c.getAttribute("aria-label") ?? c.textContent ?? "";
        return {
          key: name.replace(/\s*·\s*[\d,]+/g, "").trim(),
          box,
        };
      }),
    );
}

const keysOf = (controls: Control[]) => controls.map((c) => c.key);
const persistentOf = (spec: PageSpec, keys: string[]) =>
  keys.filter((k) => spec.persistent.includes(k));

const title = (page: Page) => page.locator("main h1").first();
/** The count drew inside the title and took away. Read here
 * at the one-item state, which is the only place the suites reach it. */
const countMark = (page: Page) => title(page).locator("[data-heading-count]");
/** The populated readiness anchor: the page's own nth seeded item on
 * screen. It replaces count pill, which removed — the same
 * synchronisation point, read off content instead of off a number. */
const itemOf = (page: Page, spec: PageSpec, n: number) =>
  page.locator("main").getByText(spec.itemName(n)).first();
const ghostOf = (page: Page, spec: PageSpec) =>
  page.locator("main").getByRole("button", { name: spec.ghost });

/** The ghost's placement: its box, its parent's box and layout, and
 * whether it is the parent's first element. */
async function ghostPlacement(ghost: Locator) {
  return ghost.evaluate((el) => {
    const parent = el.parentElement!;
    const r = el.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    const cs = getComputedStyle(parent);
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      first: parent.firstElementChild === el,
      parentDisplay: cs.display,
      parentJustify: cs.justifyContent,
      parentContentLeft: p.x + parseFloat(cs.paddingLeft),
      parentCenter: p.x + p.width / 2,
      siblings: parent.children.length,
      followedByCard: el.nextElementSibling?.tagName.toLowerCase() === "article",
    };
  });
}

async function heldCounts(page: Page) {
  const held = await Promise.all([
    api(page, "GET", "/api/projects"),
    api(page, "GET", "/api/maps"),
    api(page, "GET", "/api/recipes?origin=workflow"),
    api(page, "GET", "/api/tables"),
  ]);
  return held.map((h) =>
    Array.isArray(h) ? h.length : ((h as { recipes: unknown[] }).recipes ?? []).length,
  );
}

async function gotoZero(page: Page, spec: PageSpec) {
  await page.goto(spec.path);
  await expect(title(page)).toContainText(spec.title);
  // The zero state has resolved once the ghost tile's caption stands
  // (the pending heading and toolbar are silent too).
  await expect(page.getByText(spec.emptyMark)).toBeVisible();
}

/** The four galleries in grid view, pinned through the settings API and
 * awaited before any of them is opened: the view is a workspace-wide
 * preference that the run before this one leaves wherever it was (the
 * export-project journey leaves Projects in list view), and a gallery
 * opened in list view draws no first-cell tile. Pinned rather than
 * clicked, so the stored value can never land after a click. Wants a
 * loaded page for the request's origin. */
async function pinGridViews(page: Page) {
  const grid = { view: "grid" };
  await api(page, "PATCH", "/api/settings", {
    viewPrefs: { maps: grid, data: grid, workflows: grid, projects: grid },
  });
}

/** The ghost's left edge at zero, kept for the with-items comparison. */
const zeroGhostLeft: Record<string, number> = {};

test("every page shows its persistent toolbar controls at zero, in the row's order", async ({
  page,
  context,
}) => {
  await stubConnections(context, []);
  await page.goto("/maps");
  await pinGridViews(page);
  const counts = await heldCounts(page);
  console.log(`zero state: the instance holds ${counts.join("/")} (projects/maps/workflows/tables; connections stubbed at 0)`);
  test.skip(
    counts.some((n) => n > 0),
    "the instance already holds something: the zero state wants a fresh data directory",
  );

  // Read all five before judging, so a red run names every page.
  const seen: Record<string, string[]> = {};
  for (const spec of PAGES) {
    await gotoZero(page, spec);
    seen[spec.path] = keysOf(await census(page));
  }
  const expected = Object.fromEntries(PAGES.map((p) => [p.path, p.persistent]));
  const found = Object.fromEntries(
    PAGES.map((p) => [p.path, persistentOf(p, seen[p.path])]),
  );
  expect(
    found,
    `the persistent controls at zero, in order; the full rows read ${JSON.stringify(seen)}`,
  ).toEqual(expected);
});

test("the new-item card is the grid's first cell at zero; Connections keeps its single centred card (zero half)", async ({
  page,
  context,
}) => {
  await stubConnections(context, []);
  await page.goto("/maps");
  await pinGridViews(page);
  const counts = await heldCounts(page);
  test.skip(
    counts.some((n) => n > 0),
    "the instance already holds something: the zero state wants a fresh data directory",
  );

  const placements: Record<string, Awaited<ReturnType<typeof ghostPlacement>>> = {};
  for (const spec of PAGES) {
    await gotoZero(page, spec);
    const ghost = ghostOf(page, spec);
    await expect(ghost).toHaveCount(1);
    placements[spec.path] = await ghostPlacement(ghost);
  }
  for (const spec of PAGES) {
    const p = placements[spec.path];
    if (spec.grid) {
      expect.soft(p.parentDisplay, `${spec.path}: the card sits in a grid`).toBe("grid");
      expect.soft(p.first, `${spec.path}: the card is the first cell`).toBe(true);
      expect
        .soft(
          Math.abs(p.x - p.parentContentLeft),
          `${spec.path}: the card's left edge ${p.x} against the grid's ${p.parentContentLeft}`,
        )
        .toBeLessThanOrEqual(1);
      zeroGhostLeft[spec.path] = p.x;
    } else {
      // Connections: one card, centred in its own block, no grid cell.
      expect.soft(p.siblings, `${spec.path}: the single empty card`).toBe(1);
      expect
        .soft(
          Math.abs(p.x + p.w / 2 - p.parentCenter),
          `${spec.path}: the card centred (${p.x + p.w / 2} against ${p.parentCenter})`,
        )
        .toBeLessThanOrEqual(1);
    }
  }
});

test("no persistent control disappears or moves when the first item lands; a derived chip's reflow is allowed and named", async ({
  page,
  context,
}) => {
  const stub = await stubConnections(context, []);
  await page.goto("/maps");
  await pinGridViews(page);
  const counts = await heldCounts(page);
  test.skip(
    counts.some((n) => n > 0),
    "the instance already holds something: the transition wants a fresh data directory",
  );

  const CHIP_GAP = 6;
  const report: string[] = [];
  const problems: string[] = [];
  for (const spec of PAGES) {
    await gotoZero(page, spec);
    const before = await census(page);
    if (spec.seedOne) await spec.seedOne(page, 1);
    else stub.list = warehouses(1);
    await page.goto(spec.path);
    // The first item has landed once the page shows it. (count pill
    // stood here; removed it, and the item itself is the same
    // synchronisation point.)
    await expect(itemOf(page, spec, 1), `${spec.path}: the first item`).toBeVisible();
    // at ONE item, which is the state only this test reaches: the
    // heading is its title and nothing else. Soft, so the loop still
    // reports every page.
    expect
      .soft(await countMark(page).count(), `${spec.path}: no count mark at one item`)
      .toBe(0);
    expect
      .soft(
        (await title(page).innerText()).trim(),
        `${spec.path}: the title alone at one item`,
      )
      .toBe(spec.title);
    const after = await census(page);

    const beforeKeys = keysOf(before);
    const afterKeys = keysOf(after);
    // The chips the first item derived: present after, absent before.
    const derived = after.filter((c) => !beforeKeys.includes(c.key));
    const derivedAdvance = derived.reduce((sum, c) => sum + c.box.w + CHIP_GAP, 0);
    const lastDerivedIndex = derived.length
      ? after.indexOf(derived[derived.length - 1])
      : -1;
    report.push(
      `${spec.path}: derived ${JSON.stringify(derived.map((c) => c.key))}${
        derived.length ? ` (advance ${derivedAdvance.toFixed(1)} px)` : ""
      }`,
    );

    for (const key of spec.persistent) {
      const b = before.find((c) => c.key === key);
      const a = after.find((c) => c.key === key);
      if (!b) {
        problems.push(`${spec.path}: "${key}" absent at zero`);
        continue;
      }
      if (!a) {
        problems.push(`${spec.path}: "${key}" vanished with the first item`);
        continue;
      }
      const dx = a.box.x - b.box.x;
      const dy = a.box.y - b.box.y;
      const dw = a.box.w - b.box.w;
      const dh = a.box.h - b.box.h;
      const afterChips = lastDerivedIndex >= 0 && afterKeys.indexOf(key) > lastDerivedIndex;
      const allowedDx = afterChips && Math.abs(dx - derivedAdvance) <= 1;
      if (Math.abs(dx) > 1 && !allowedDx) {
        problems.push(`${spec.path}: "${key}" moved ${dx.toFixed(1)} px sideways for no reason but the emptiness ending`);
      } else if (allowedDx && Math.abs(dx) > 1) {
        report.push(`${spec.path}: "${key}" moved ${dx.toFixed(1)} px, the derived chip's own advance`);
      }
      if (Math.abs(dy) > 1) problems.push(`${spec.path}: "${key}" moved ${dy.toFixed(1)} px down`);
      if (Math.abs(dw) > 1 || Math.abs(dh) > 1) {
        problems.push(`${spec.path}: "${key}" resized by ${dw.toFixed(1)}×${dh.toFixed(1)} px`);
      }
    }
  }
  console.log(report.join("\n"));
  expect(problems, `controls between zero and the first item:\n${report.join("\n")}`).toEqual([]);
});

test("with items the card is still the grid's first cell, the row keeps its order, and Connections grows no cell (with items)", async ({
  page,
  context,
}) => {
  const stub = await stubConnections(context, warehouses(3));
  await page.goto("/maps");
  await pinGridViews(page);
  // Three of each, on top of whatever the instance holds.
  for (const spec of PAGES) {
    if (!spec.seedOne) continue;
    for (const n of [2, 3]) await spec.seedOne(page, n);
  }
  stub.list = warehouses(3);

  for (const spec of PAGES) {
    await page.goto(spec.path);
    await expect(title(page)).toContainText(spec.title);
    // With items: the second seeded item, which this test just added.
    await expect(itemOf(page, spec, 2), `${spec.path}: a seeded item`).toBeVisible();
    const order = persistentOf(spec, keysOf(await census(page)));
    expect.soft(order, `${spec.path}: the persistent controls' order with items`).toEqual(spec.persistent);
    const ghost = ghostOf(page, spec);
    if (!spec.grid) {
      await expect(ghost, `${spec.path}: no ghost once it holds entries`).toHaveCount(0);
      continue;
    }
    await expect(ghost).toHaveCount(1);
    const p = await ghostPlacement(ghost);
    expect.soft(p.parentDisplay, `${spec.path}: the card sits in the grid`).toBe("grid");
    expect.soft(p.first, `${spec.path}: the card is the first cell`).toBe(true);
    expect.soft(p.followedByCard, `${spec.path}: the first item follows the card`).toBe(true);
    if (spec.path in zeroGhostLeft) {
      expect
        .soft(Math.abs(p.x - zeroGhostLeft[spec.path]), `${spec.path}: the card's left edge as at zero`)
        .toBeLessThanOrEqual(1);
    } else {
      console.log(`${spec.path}: no zero-state left edge recorded (the zero test skipped)`);
    }
  }
});

test("the Data page's source chips still follow what it holds: none at zero, Files once a CSV is there (a guard)", async ({
  page,
  context,
}) => {
  await page.goto("/data");
  // The chips as this instance holds them: the same page, the listing
  // answered empty by the network boundary, then the real one.
  let empty = true;
  await routeHouse(context, {
    handler: async (route) => {
      const { pathname } = new URL(route.request().url());
      if (empty && route.request().method() === "GET" && pathname === "/api/tables") {
        await json(route, []);
        return true;
      }
      return false;
    },
  });
  const chips = () =>
    page
      .getByRole("group", { name: "Filter tables" })
      .getByRole("button")
      .allInnerTexts()
      .then((t) => t.map((s) => s.replace(/\s*·\s*[\d,]+/g, "").trim()));

  await page.goto("/data");
  await expect(page.getByText("Upload a file or import from a source")).toBeVisible();
  expect(await chips(), "at zero: the All chip alone").toEqual(["All"]);

  empty = false;
  await seedCsv(page, `lpt_guard_${runId}`, CSV);
  await page.goto("/data");
  // The CSV has landed once the page lists it by name.
  await expect(
    page.locator("main").getByText(`lpt_guard_${runId}`).first(),
    "the guard CSV",
  ).toBeVisible();
  const withCsv = await chips();
  expect(withCsv[0], "All stays first").toBe("All");
  expect(withCsv, "a CSV introduces the Files chip").toContain("Files");
});

test("Connections has a search that narrows by name and the reference's sort, from zero, by keyboard", async ({
  page,
  context,
}) => {
  const stub = await stubConnections(context, []);
  await page.goto("/connections");
  await expect(page.getByText("Snapshot tables from a PostGIS database")).toBeVisible();
  const search = page.getByLabel("Search connections");
  const sort = page.getByLabel("Sort connections");
  await expect(search, "the search at zero").toBeVisible();
  await expect(sort, "the sort at zero").toBeVisible();
  await expect(sort.locator("option", { hasText: "Recently checked" })).toHaveCount(1);
  // Keyboard: the row's shortcut reaches the search, Tab the sort.
  await page.locator("body").click();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sort).toBeFocused();

  stub.list = [
    { id: "c-alder", name: "Alder", createdAt: "2026-08-01T08:00:00.000Z", lastCheckedAt: "2026-08-30T08:00:00.000Z", status: "connected" },
    { id: "c-birch", name: "Birch", createdAt: "2026-08-02T08:00:00.000Z", lastCheckedAt: null, status: "never_checked" },
    { id: "c-cedar", name: "Cedar", createdAt: "2026-08-03T08:00:00.000Z", lastCheckedAt: "2026-08-31T08:00:00.000Z", status: "connected" },
  ];
  await page.goto("/connections");
  // The ledger of three has rendered: the count the sort and the search
  // are read from, so the reads below never run against a short list.
  await expect(
    page.locator("main").getByRole("link", { name: /^Open / }),
    "the three stubbed connections",
  ).toHaveCount(3);
  const names = () =>
    page
      .locator("main")
      .getByRole("link", { name: /^Open / })
      .evaluateAll((links) =>
        links.map((l) => (l.getAttribute("aria-label") ?? "").replace(/^Open /, "")),
      );

  expect(await names(), "Recently checked: latest first, never last").toEqual(["Cedar", "Alder", "Birch"]);
  await sort.selectOption({ label: "Name A–Z" });
  expect(await names(), "Name A–Z").toEqual(["Alder", "Birch", "Cedar"]);
  await sort.selectOption({ label: "Recently checked" });

  await search.fill("bir");
  expect(await names(), "the search narrows by name").toEqual(["Birch"]);
  await expect(page.locator("main h1 + p").first()).toHaveText("1 of 3 shown");
  await search.fill("zzz-none");
  await expect(page.getByText("No connections match. Clear the search.")).toBeVisible();
  await search.fill("");
  expect(await names(), "cleared").toEqual(["Cedar", "Alder", "Birch"]);
});

/* The outer list frame: the ancestor of the column header's cell, which
   is how both trees expose it (a span in a header row in a frame). */
const frameOf = (page: Page, columnLabel: string) =>
  page.locator(`xpath=//main//span[normalize-space(.)="${columnLabel}"]/../..`).first();
const headerOf = (page: Page, columnLabel: string) =>
  page.locator(`xpath=//main//span[normalize-space(.)="${columnLabel}"]/..`).first();

const framePaint = (frame: Locator) =>
  frame.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      radius: cs.borderTopLeftRadius,
      border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
      shadow: cs.boxShadow,
      background: cs.backgroundColor,
    };
  });
const headerPaint = (header: Locator) =>
  header.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
      transform: cs.textTransform,
      weight: cs.fontWeight,
      color: cs.color,
      background: cs.backgroundColor,
    };
  });

test("Connections' list renders in the shared list frame, outer to outer, and its actions still work", async ({
  page,
  context,
}) => {
  const stub = await stubConnections(context, warehouses(3));
  await page.goto("/maps");
  const maps = (await api(page, "GET", "/api/maps")) as unknown[];
  if (maps.length === 0) await api(page, "POST", "/api/maps", { name: `Frame ${runId}` });

  // The other page's frame: Maps in list view, pinned through the
  // settings before the page opens (a click here raced the stored grid
  // view the test before this one had pinned: 's window, met once in
  // the round's whole run).
  await api(page, "PATCH", "/api/settings", { viewPrefs: { maps: { view: "list" } } });
  await page.goto("/maps");
  const mapsFrame = frameOf(page, "Map name");
  await expect(mapsFrame).toBeVisible();
  const reference = await framePaint(mapsFrame);
  const referenceHeader = await headerPaint(headerOf(page, "Map name"));
  const referenceRow = await page
    .locator("main")
    .getByRole("button", { name: /^Open / })
    .first()
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      return `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`;
    });
  // Maps back to grid for the tests after this one, pinned rather than
  // clicked so the stored value is settled before anyone navigates.
  await pinGridViews(page);

  await page.goto("/connections");
  await expect(
    page.locator("main").getByRole("link", { name: /^Open / }),
    "the three stubbed connections",
  ).toHaveCount(3);
  const frame = frameOf(page, "Snapshots");
  await expect(frame).toBeVisible();
  expect(await framePaint(frame), "the outer frame's corners, border, shadow and surface").toEqual(reference);
  expect(await headerPaint(headerOf(page, "Snapshots")), "the column header's rule").toEqual(referenceHeader);
  const row = page.locator("main").getByRole("link", { name: "Open Warehouse 1" });
  expect(
    await row.evaluate((el) => {
      const cs = getComputedStyle(el);
      return `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`;
    }),
    "the row's spacing",
  ).toBe(referenceRow);

  // Every action a connection had: open, Test on its row, the menu.
  await expect(row).toHaveAttribute("href", "/connections/c-0");
  await row.locator("..").getByRole("button", { name: "Test", exact: true }).click();
  await expect.poll(() => stub.tested).toEqual(["c-0"]);
  await expect(page).toHaveURL(/\/connections$/);
  const menu = page.getByRole("button", { name: "More actions for Warehouse 1" });
  await menu.click();
  await expect(page.getByRole("menuitem", { name: "Import tables" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Copy server address" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.keyboard.press("Escape");
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/connections\/c-0$/);
});

test("the four corrections: the title's letter-spacing, the sort's corners, the caption's casing, the placeholder naming data", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  const letterSpacing = () => title(page).evaluate((el) => getComputedStyle(el).letterSpacing);

  await page.goto("/maps");
  // The caption is read off the grid's tile, so Projects must be in grid view.
  await pinGridViews(page);
  await expect(title(page)).toContainText("Maps");
  const mapsSpacing = await letterSpacing();
  const sortRadius = await page
    .getByLabel("Sort maps")
    .evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  const searchRadius = await page
    .getByLabel("Search maps")
    .evaluate((el) => getComputedStyle(el.closest("label")!).borderTopLeftRadius);
  expect.soft(sortRadius, `the sort control's corners against the search box's (${searchRadius})`).toBe(searchRadius);

  await page.goto("/data");
  await expect(title(page)).toContainText("Data");
  // The title's letter-spacing: equal to its sibling's. This held once
  // made the heading one shared rule; it is measured here so it cannot
  // part again.
  expect.soft(await letterSpacing(), "the Data title's letter-spacing against Maps'").toBe(mapsSpacing);
  const placeholder = await page
    .locator('main [class*="toolbar"] input')
    .first()
    .getAttribute("placeholder");
  expect.soft(placeholder, "the search placeholder names data").toMatch(/data/i);
  expect.soft(placeholder, "the search placeholder no longer says tables").not.toMatch(/tables/i);

  await page.goto("/projects");
  await expect(title(page)).toContainText("Projects");
  // Exact, so the lower-case fragment cannot stand in for the sentence.
  await expect(
    page.getByText("A name, nothing else", { exact: true }),
    "the tile caption cased like its siblings",
  ).toBeVisible();
});

/* the toolbar's chips keep their counts while the
   heading loses its own. The census above keys a control by its
   accessible name with any "· N" suffix STRIPPED, so a green census is
   no evidence at all here — this reads the chips' own text. */
test("Maps, Workflows and Data keep their chip counts, read from the chips themselves", async ({
  page,
}) => {
  await page.goto("/maps");
  await pinGridViews(page);
  // One more of each, so the run stands on its own seeding whatever
  // the instance already held.
  for (const spec of PAGES) {
    if (spec.seedOne) await spec.seedOne(page, 4);
  }
  const chipped = [
    { path: "/maps", group: "Filter maps" },
    { path: "/workflows", group: "Filter workflows" },
    { path: "/data", group: "Filter tables" },
  ];
  // Read all three before judging, so a red run names every page.
  const seen: Record<string, string[]> = {};
  for (const { path, group } of chipped) {
    const spec = PAGES.find((p) => p.path === path)!;
    await page.goto(path);
    // The counts appear only once the listing has resolved, so
    // the page's own seeded item settles the read first.
    await expect(itemOf(page, spec, 4), `${path}: a seeded item`).toBeVisible();
    seen[path] = (
      await page
        .getByRole("group", { name: group })
        .getByRole("button")
        .allInnerTexts()
    ).map((t) => t.replace(/\s+/g, " ").trim());
  }
  const bare: string[] = [];
  for (const [path, texts] of Object.entries(seen)) {
    expect(texts.length, `${path}: the page draws chips`).toBeGreaterThan(0);
    for (const text of texts) {
      if (!/^\S.* · [\d,]+$/.test(text)) bare.push(`${path}: "${text}"`);
    }
  }
  expect(
    bare,
    `every chip carries its count; the chips read ${JSON.stringify(seen)}`,
  ).toEqual([]);
});
