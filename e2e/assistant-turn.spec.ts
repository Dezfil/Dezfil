// The turn in flight and the rendered reply (of, all): the message at once
// and once, the indicator, one line per action from running to settled,
// the lines above the answer live and settled, the caret, Stop in Send's
// slot during execution and while a card waits, the stopped parked turn,
// the announcements, focus, reduced motion, and the markdown subset with
// its security corpus. Beats are released only after they are observed,
// through the provider fixture's acknowledged points and the tool
// harness's barrier; product dispatches are counted at the harness, on the
// server's side of loopback, and provider calls at the fixture. Stop
// during execution and the recovery paths have suites of their own
// (assistant-stop.spec.ts, assistant-receipt.spec.ts).
//
// Environment: the documented gate with the tool harness: the instance
// booted with the harness preload naming 3303 as its own address, the
// scripted provider on 3202. Run with DEZFIL_BASE_URL at the server.
import { test, expect, type Page } from "@playwright/test";
import { assistantProviderFixture } from "./assistant-provider-fixture";
import { assistantToolHarness, harnessTarget } from "./assistant-tool-harness";
import { routeHouse } from "./support";
import { api, box, composer, entries, onBuilder, pane, seed, sendAndIdentify, sendButton, stopButton, turnView } from "./assistant-turn-support";

const provider = assistantProviderFixture();
const harness = assistantToolHarness(harnessTarget());
test.beforeAll(async () => { await provider.start(); await harness.start(); });
test.afterAll(async () => { await provider.stop(); await harness.stop(); });
test.beforeEach(async ({ context, page }) => {
  provider.reset(); harness.reset();
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");
  const open = await api(page, "GET", "/api/assistant/pending") as { pending: { runId: string }[] };
  for (const p of open.pending) await api(page, "DELETE", `/api/assistant/runs/${p.runId}`).catch(() => undefined);
});

test.describe("the gate's wiring", () => {
  test("a scripted read-only turn reaches the tool harness, so a dispatch count can go red", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push({ calls: [{ name: "list_tables", args: {} }] }, { text: "Listed." });
    await sendAndIdentify(page, "List the tables");
    await expect(pane(page).getByText("Listed.", { exact: true })).toBeVisible();
    expect(harness.reads.length + harness.dispatches.length,
      "no loop request reached the harness: boot the instance with the harness preload").toBeGreaterThan(0);
    expect(harness.reads.some((r) => r.path.startsWith("/api/tables") || r.path.startsWith("/api/catalogue"))).toBe(true);
    expect(provider.captures).toHaveLength(2);
  });
});

/** Whether anything outside the transcript paints over its visible area:
 * points sampled over the transcript's box must land on the transcript or
 * on one of its own descendants. Pane chrome and overlays are what this
 * catches; the transcript's own content legitimately fills it. */
/** The transcript's element on either tree: the hook, or the pane's one
 * vertically scrolling column on the shipped tree. */
const TRANSCRIPT_EL = `(() => { const pane = document.querySelector("[data-assistant-pane]"); return pane?.querySelector("[data-transcript]") ?? Array.from(pane?.querySelectorAll("div") ?? []).find((d) => getComputedStyle(d).overflowY === "auto") ?? null; })()`;
async function stopInsideTranscript(page: Page): Promise<boolean | null> {
  return page.evaluate((expr) => {
    const el = eval(expr) as HTMLElement | null;
    const stop = Array.from(document.querySelectorAll("[data-assistant-pane] button")).find((b) => b.textContent?.trim() === "Stop");
    if (!el || !stop) return null;
    return el.contains(stop);
  }, TRANSCRIPT_EL);
}
async function transcriptObscured(page: Page): Promise<boolean> {
  return page.evaluate((expr) => {
    const el = eval(expr) as HTMLElement | null;
    if (!el) throw new Error("no transcript element");
    const r = el.getBoundingClientRect();
    const points: [number, number][] = [];
    for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.1, 0.35, 0.65, 0.9]) points.push([r.left + r.width * fx, r.top + r.height * fy]);
    return points.some(([x, y]) => { const at = document.elementFromPoint(x, y); return at !== null && at !== el && !el.contains(at); });
  }, TRANSCRIPT_EL);
}

test.describe("item 1 red: the reply's markdown", () => {
  test("bold, a list item and inline code in a settled reply render as their elements", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push({ text: "The layer **parks** now has five classes on `area_m2`.\n\n- Breaks: 0.4 and 1.1 ha\n- Ramp: kelp" });
    const runId = await sendAndIdentify(page, "Colour the parks by area");
    await expect(pane(page).getByText("Ramp: kelp", { exact: false })).toBeVisible();
    // Seeded defect on the shipped tree: the asterisks and backticks show as typed.
    expect(await pane(page).innerText(), "no markdown delimiter shows in the pane").not.toContain("**");
    const answer = turnView(page, runId).locator("[data-turn-answer]");
    await expect(answer).toBeVisible();
    await expect(answer.locator("strong")).toHaveText("parks");
    await expect(answer.locator("code")).toHaveText("area_m2");
    await expect(answer.locator("ul > li")).toHaveCount(2);
    expect(await answer.innerText()).not.toContain("**");
  });
});

test.describe("item 3 reds: the turn in flight", () => {
  test("while the reply is held before its first word, the message is in the transcript once, under its run", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push({ chunks: ["Held ", "answer."], hold: { first: true } });
    const runId = await sendAndIdentify(page, "Say something while I watch");
    await provider.reached("0:first");
    // Seeded defect on the shipped tree: the message enters the transcript only at settlement.
    await expect(pane(page).getByText("Say something while I watch", { exact: true })).toHaveCount(1);
    await expect(turnView(page, runId).locator("[data-turn-message]")).toHaveCount(1);
    await expect(turnView(page, runId).locator("[data-turn-message]")).toHaveText("Say something while I watch");
    await expect(pane(page).getByText("Say something while I watch", { exact: true })).toHaveCount(1);
    provider.release("0:first");
    await expect(pane(page).getByText("Held answer.", { exact: true })).toBeVisible();
    await expect(pane(page).getByText("Say something while I watch", { exact: true })).toHaveCount(1);
  });

  test("Stop stands outside the transcript and nothing obscures the transcript while a turn runs; a seeded overlay makes the check fail", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push({ chunks: ["A held ", "reply."], hold: { first: true } });
    await sendAndIdentify(page, "Hold the reply");
    await provider.reached("0:first");
    await expect(stopButton(page)).toHaveCount(1);
    // Seeded defect on the shipped tree: the Stop is a child of the transcript, a flex child
    // filling its column.
    expect(await stopInsideTranscript(page), "Stop is outside the transcript").toBe(false);
    expect(await transcriptObscured(page), "nothing paints over the transcript").toBe(false);
    // The check can fail: a seeded overlay over the transcript's middle is caught.
    await page.evaluate(() => {
      const pane = document.querySelector("[data-assistant-pane]")!;
      const t = (pane.querySelector("[data-transcript]") ?? Array.from(pane.querySelectorAll("div")).find((d) => getComputedStyle(d).overflowY === "auto"))!.getBoundingClientRect();
      const seed = document.createElement("div"); seed.setAttribute("data-seeded-overlay", "");
      Object.assign(seed.style, { position: "fixed", left: `${t.left + t.width * 0.4}px`, top: `${t.top + t.height * 0.3}px`, width: "40px", height: "40px", zIndex: "9999", background: "transparent" });
      document.body.appendChild(seed);
    });
    expect(await transcriptObscured(page), "the seeded overlay is caught").toBe(true);
    await page.evaluate(() => document.querySelector("[data-seeded-overlay]")?.remove());
    provider.release("0:first");
    await expect(pane(page).getByText("A held reply.", { exact: true })).toBeVisible();
  });

  test("a running action's line carries the running mark in the check's place until its outcome lands", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    harness.barrier("rename", (method, path) => method === "PATCH" && path.startsWith("/api/layers/"));
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Renamed while watched" } }] }, { text: "Renamed." });
    await sendAndIdentify(page, "Rename the layer slowly");
    await harness.reached("rename");
    const running = entries(page).filter({ has: page.locator("[data-status='running']") }).or(pane(page).locator("[data-record-entry][data-status='running']"));
    await expect(pane(page).locator("[data-record-entry][data-status='running']")).toHaveCount(1);
    // Seeded defect on the shipped tree: the running line's status dot is empty.
    await expect(pane(page).locator("[data-record-entry][data-status='running'] [data-running-mark]")).toHaveCount(1);
    void running;
    harness.release("rename");
    await expect(pane(page).locator("[data-record-entry][data-tool='update_layer']")).toHaveAttribute("data-status", "succeeded");
    await expect(pane(page).locator("[data-record-entry][data-tool='update_layer'] [data-running-mark]")).toHaveCount(0);
    await expect(pane(page).getByText("Renamed.", { exact: true })).toBeVisible();
  });

  test("the record sits above the answer once settled, on a fresh turn and on every turn already in the transcript", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "First order" } }] }, { text: "First reply." });
    const first = await sendAndIdentify(page, "First turn");
    await expect(pane(page).getByText("First reply.", { exact: true })).toBeVisible();
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Second order" } }] }, { text: "Second reply." });
    const second = await sendAndIdentify(page, "Second turn");
    await expect(pane(page).getByText("Second reply.", { exact: true })).toBeVisible();
    for (const [runId, name, reply] of [[first, "First order", "First reply."], [second, "Second order", "Second reply."]] as const) {
      // Geometry read from the words on either tree: the record holding the
      // action's line, and the reply's text.
      const record = await box(pane(page).locator("[data-record]").filter({ hasText: `Updated the layer ${name}` }));
      const answer = await box(pane(page).getByText(reply, { exact: true }));
      // Seeded defect on the shipped tree: the settled record is drawn under the answer.
      expect(record.y + record.height, `the record of ${name} ends above its answer`).toBeLessThanOrEqual(answer.y + 0.5);
      const view = turnView(page, runId);
      await expect(view.locator("[data-record-entry]")).toHaveCount(1);
      await expect(view.locator("[data-record-entry]").getByRole("button")).toContainText(`Updated the layer ${name}`);
      await expect(view.locator("[data-turn-answer]")).toContainText(reply);
    }
  });
});

test.describe("item 1: the rendering boundary's corpus in the browser", () => {
  const CORPUS = [
    "Done. <script>window.__pwned = 1</script> That was all.",
    'Hover <b onmouseover="window.__pwned = 2">here</b> please.',
    "The map: ![parks](http://127.0.0.1:3303/corpus/markdown-image.png) shows it.",
    'Look: <img src="http://127.0.0.1:3303/corpus/raw-image.png" alt="x"> there.',
    '<iframe src="http://127.0.0.1:3303/corpus/frame.html"></iframe> framed.',
    "Open [the map](javascript:window.__pwned=3) now.",
    "Open [the map](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) now.",
    "Open [the map](vbscript:MsgBox(1)) now.",
  ];
  test("every payload arrives, shows as its literal text, makes no forbidden node or attribute and issues no request", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    const hits: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/corpus/")) hits.push(r.url()); });
    provider.replies.push({ text: CORPUS.join("\n\n") });
    await sendAndIdentify(page, "Show me the corpus");
    await expect(pane(page).getByText("framed.", { exact: false })).toBeVisible();
    // Arrival: the fixture served the reply and the pane shows its last words.
    expect(provider.captures).toHaveLength(1);
    // Soft, so a mutated boundary reports every conjunct it breaks.
    const text = await pane(page).innerText();
    for (const payload of CORPUS) expect.soft(text, "the exact literal text").toContain(payload);
    await expect.soft(pane(page).locator("script, img, iframe, object, embed, [onmouseover], [onerror], [onload]"), "no forbidden node or handler attribute").toHaveCount(0);
    await expect.soft(pane(page).locator("a"), "no anchor").toHaveCount(0);
    expect.soft(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), "no payload ran").toBeUndefined();
    await page.waitForTimeout(400);
    expect.soft(hits, "no request left the page for a payload").toEqual([]);
  });
});

test.describe("item 1: only a reply's text renders", () => {
  test("the message, a refusal's reason and an inspection holding markdown characters stay literal", async ({ page }) => {
    const { mapId, table } = await seed(page);
    await onBuilder(page, mapId);
    const sql = `-- **not bold** and \`not code\`\nSELECT count(*) AS n FROM ${table}`;
    provider.replies.push({ calls: [{ name: "run_sql", args: { sql } }, { name: "**teleport**", args: {} }] }, { text: "Counted, and one thing I could not do." });
    await sendAndIdentify(page, "Count **these** rows with `care`");
    await expect(pane(page).getByText("Counted, and one thing I could not do.", { exact: true })).toBeVisible();
    // The message as typed, delimiters and all.
    await expect(pane(page).getByText("Count **these** rows with `care`", { exact: true })).toHaveCount(1);
    // The refusal's reason names the unknown tool with its asterisks.
    const refused = pane(page).locator("[data-record-entry][data-status='refused']");
    await expect(refused.getByRole("button")).toContainText("Unknown tool: **teleport**");
    expect(await refused.locator("strong").count()).toBe(0);
    // The inspection holds exactly the submitted SQL.
    const ran = pane(page).locator("[data-record-entry][data-tool='run_sql']");
    await ran.getByRole("button").click();
    await expect(ran.locator("[data-sql]")).toHaveText(sql);
    expect(await ran.locator("[data-sql] strong, [data-sql] code").count()).toBe(0);
  });
});

test.describe("the message's representation, by turn identity", () => {
  /** Where the message stands, counted by identity: the provisional live
   * view before a run is known, the run's view once reserved, and the
   * settled turns; never by matching text across the transcript. */
  const messagesIn = (page: Page, key: string) => pane(page).locator(`[data-turn="${key}"] [data-turn-message]`);
  const userInputs = (capture: { input: { role?: string; content?: unknown }[] }, message: string) =>
    capture.input.filter((item) => item.role === "user" && JSON.stringify(item.content).includes(message)).length;

  test("while the reservation is held: one provisional message in the transcript, no provider call; then the run's own view carries it", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    await page.route("**/api/assistant/runs", async (route) => { if (route.request().method() !== "POST") { await route.continue(); return; } const response = await route.fetch(); await held; await route.fulfill({ response }); }, { times: 1 });
    provider.replies.push({ text: "Reserved and answered." });
    const request = page.waitForRequest((r) => r.url().endsWith("/api/assistant/messages") && r.method() === "POST");
    await composer(page).fill("Hold my reservation");
    await sendButton(page).click();
    await expect(messagesIn(page, "live")).toHaveCount(1);
    await expect(messagesIn(page, "live")).toHaveText("Hold my reservation");
    await expect(composer(page)).toHaveValue("");
    expect(provider.captures, "no provider call while the reservation is held").toHaveLength(0);
    release();
    const runId = (await request).postDataJSON().runId as string;
    await expect(messagesIn(page, runId)).toHaveCount(1);
    await expect(pane(page).getByText("Reserved and answered.", { exact: true })).toBeVisible();
    await expect(pane(page).getByText("Hold my reservation", { exact: true })).toHaveCount(1);
  });

  test("a failed reservation: no provider call, the not-started note, the words back in the draft and out of the transcript", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    await page.route("**/api/assistant/runs", async (route) => { if (route.request().method() !== "POST") { await route.continue(); return; } await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "An unexpected server error occurred." } }) }); }, { times: 1 });
    provider.replies.push({ text: "Never sent." });
    await composer(page).fill("Reserve me badly");
    await sendButton(page).click();
    await expect(pane(page).locator("[role='alert']")).toBeVisible();
    await expect(composer(page)).toHaveValue("Reserve me badly");
    // Out of the transcript (the composer holds it as the draft, which is
    // where the words stand now).
    await expect(pane(page).locator("[data-turn-message]")).toHaveCount(0);
    await expect(pane(page).locator("[data-turn]").getByText("Reserve me badly", { exact: true })).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(provider.captures).toHaveLength(0);
    // A retry is a deliberate act: pressing Send again sends it.
    provider.replies.length = 0; provider.replies.push({ text: "Sent the second time." });
    await sendButton(page).click();
    await expect(pane(page).getByText("Sent the second time.", { exact: true })).toBeVisible();
    await expect(pane(page).locator("[data-turn-message]")).toHaveCount(1);
    await expect(pane(page).locator("[data-turn-message]")).toHaveText("Reserve me badly");
    expect(provider.captures).toHaveLength(1);
  });

  test("a rejected unbound submission: no provider call, the reservation released, the refusal's reason and the draft restored", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    const released: string[] = [];
    page.on("request", (r) => { if (r.method() === "DELETE" && r.url().includes("/api/assistant/runs/")) released.push(r.url()); });
    await page.route("**/api/assistant/messages", async (route) => { await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "invalid_request", message: "The submission was refused before any work." } }) }); }, { times: 1 });
    provider.replies.push({ text: "Never sent." });
    await composer(page).fill("Refuse me");
    await sendButton(page).click();
    // The route said why it refused, and that reason stands: the generic
    // not-started note is for a submission nothing explained.
    await expect(pane(page).getByText("The submission was refused before any work.", { exact: true })).toBeVisible();
    await expect(pane(page).getByText("The message wasn't started.", { exact: false })).toHaveCount(0);
    await expect(composer(page)).toHaveValue("Refuse me");
    await expect(pane(page).locator("[data-turn-message]")).toHaveCount(0);
    expect(released.length, "the unused reservation was released").toBe(1);
    await page.waitForTimeout(300);
    expect(provider.captures).toHaveLength(0);
  });

  test("accepted execution: once in the transcript at every beat and once in each captured model input, never doubled through history", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push({ text: "First answer." });
    await sendAndIdentify(page, "The first message");
    await expect(pane(page).getByText("First answer.", { exact: true })).toBeVisible();
    // A second turn with an action: the message is in the transcript once
    // while the action runs, once at settlement, and once in each of the
    // two captured inputs (the turn's and its continuation's), while the
    // first turn's message travels in history once.
    harness.barrier("rename", (method, path) => method === "PATCH" && path.startsWith("/api/layers/"));
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Once" } }] }, { text: "Second answer." });
    const second = await sendAndIdentify(page, "The second message");
    await harness.reached("rename");
    await expect(messagesIn(page, second)).toHaveCount(1);
    await expect(pane(page).getByText("The second message", { exact: true })).toHaveCount(1);
    harness.release("rename");
    await expect(pane(page).getByText("Second answer.", { exact: true })).toBeVisible();
    // Settled: two messages in the pane, one each (their run's own view is task 10's).
    await expect(pane(page).locator("[data-turn-message]")).toHaveCount(2);
    await expect(pane(page).locator("[data-turn-message]").filter({ hasText: "The second message" })).toHaveCount(1);
    await expect(pane(page).locator("[data-turn-message]").filter({ hasText: "The first message" })).toHaveCount(1);
    await expect.poll(() => provider.captures.length).toBe(3);
    expect(userInputs(provider.captures[0], "The first message")).toBe(1);
    for (const capture of provider.captures.slice(1)) {
      expect(userInputs(capture, "The second message"), "the current message once per model input").toBe(1);
      expect(userInputs(capture, "The first message"), "the earlier message once, through history").toBe(1);
    }
  });
});

test.describe("one structure live and settled", () => {
  test("an inspection opened before settlement is open after it, and settled turns keep their run's identity, order and entries as their records sit above their answers", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    // An earlier settled turn, so settlement of the next one is measured on a populated transcript.
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Earlier" } }] }, { text: "Earlier reply." });
    const earlier = await sendAndIdentify(page, "Earlier turn");
    await expect(pane(page).getByText("Earlier reply.", { exact: true })).toBeVisible();
    // The next turn: its action settles, then its reply is held; the inspection opens while the
    // turn is live.
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Inspected" } }] }, { chunks: ["Held ", "then settled."], hold: { first: true } });
    const runId = await sendAndIdentify(page, "Inspect me mid-turn");
    // The fourth scripted reply of this page: the earlier turn took two, this turn's first is the
    // third.
    await provider.reached("3:first");
    const view = turnView(page, runId);
    const line = view.locator("[data-record-entry][data-tool='update_layer']");
    await expect(line).toHaveAttribute("data-status", "succeeded");
    await line.getByRole("button").click();
    await expect(line.locator("[data-inspection]")).toBeVisible();
    await expect(line.locator("[data-inputs]")).toContainText("Inspected");
    provider.release("3:first");
    await expect(view.locator("[data-turn-answer]")).toContainText("Held then settled.");
    await expect(composer(page)).toBeEnabled();
    // Settled: the same view, the inspection still open, the record above the answer.
    await expect(view).toHaveCount(1);
    await expect(view).not.toHaveAttribute("data-live", "true");
    await expect(line.locator("[data-inspection]")).toBeVisible();
    await expect(line.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    const record = await box(view.locator("[data-record]"));
    const answer = await box(view.locator("[data-turn-answer]"));
    expect(record.y + record.height).toBeLessThanOrEqual(answer.y + 0.5);
    // The earlier turn kept its identity, its message, its one entry and its order.
    const views = pane(page).locator("[data-turn]");
    await expect(views).toHaveCount(2);
    expect(await views.evaluateAll((els) => els.map((el) => el.getAttribute("data-turn")))).toEqual([earlier, runId]);
    await expect(turnView(page, earlier).locator("[data-turn-message]")).toHaveText("Earlier turn");
    await expect(turnView(page, earlier).locator("[data-record-entry]")).toHaveCount(1);
    await expect(turnView(page, earlier).locator("[data-record-entry]").getByRole("button")).toContainText("Updated the layer Earlier");
    await expect(turnView(page, runId).locator("[data-turn-message]")).toHaveText("Inspect me mid-turn");
  });
});

test.describe("the indicator, the running mark and the caret through the beats", () => {
  const indicator = (page: Page) => pane(page).locator("[data-thinking]");
  const caret = (page: Page) => pane(page).locator("[data-caret]");

  test("present before the first event and between settled actions and the first word; absent during a running action, while parked and once text shows; a text-only turn's words take its place", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    // Before the first event: the provider holds its first reply before any delta.
    harness.barrier("rename", (method, path) => method === "PATCH" && path.startsWith("/api/layers/"));
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Indicated" } }], hold: { first: true } }, { chunks: ["Done ", "with it."], hold: { first: true, chunks: true } });
    const runId = await sendAndIdentify(page, "Rename and tell me");
    await provider.reached("0:first");
    await expect(indicator(page)).toHaveCount(1);
    await expect(pane(page).locator("[data-record-entry]")).toHaveCount(0);
    provider.release("0:first");
    // During the running action: the mark, no indicator.
    await harness.reached("rename");
    await expect(pane(page).locator("[data-record-entry][data-status='running'] [data-running-mark]")).toHaveCount(1);
    await expect(indicator(page)).toHaveCount(0);
    harness.release("rename");
    // Actions settled, the first word awaited: the indicator returns under the lines.
    await provider.reached("1:first");
    await expect(pane(page).locator("[data-record-entry][data-tool='update_layer']")).toHaveAttribute("data-status", "succeeded");
    await expect(indicator(page)).toHaveCount(1);
    const indicatorBox = await box(indicator(page));
    const recordBox = await box(turnView(page, runId).locator("[data-record]"));
    expect(indicatorBox.y, "the indicator stands under the lines").toBeGreaterThanOrEqual(recordBox.y + recordBox.height - 0.5);
    provider.release("1:first");
    // Text shows: the indicator is gone and the caret is on the text.
    await provider.reached("1:chunk:0");
    await expect(turnView(page, runId).locator("[data-turn-answer]")).toContainText("Done");
    await expect(indicator(page)).toHaveCount(0);
    await expect(caret(page)).toHaveCount(1);
    provider.release("1:chunk:0");
    await expect(turnView(page, runId).locator("[data-turn-answer]")).toContainText("Done with it.");
    await expect(composer(page)).toBeEnabled();
    await expect(caret(page)).toHaveCount(0);
    await expect(indicator(page)).toHaveCount(0);
  });

  test("while a confirmation waits there is no indicator, the message, the lines and the card stay", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Before the gate" } }, { name: "delete_layer", args: { id: layerId } }] });
    const runId = await sendAndIdentify(page, "Rename, then delete");
    const card = pane(page).locator("[data-confirmation]");
    await expect(card).toBeVisible();
    await expect(indicator(page)).toHaveCount(0);
    await expect(turnView(page, runId).locator("[data-turn-message]")).toHaveText("Rename, then delete");
    await expect(turnView(page, runId).locator("[data-record-entry][data-tool='update_layer']")).toHaveAttribute("data-status", "succeeded");
    await expect(turnView(page, runId).locator("[data-confirmation]")).toHaveCount(1);
  });

  test("a text-only turn shows its first words where the indicator stood", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push({ chunks: ["Five ", "classes."], hold: { first: true, chunks: true } });
    const runId = await sendAndIdentify(page, "Text only");
    await provider.reached("0:first");
    await expect(indicator(page)).toHaveCount(1);
    const stood = await box(indicator(page));
    provider.release("0:first");
    await provider.reached("0:chunk:0");
    await expect(indicator(page)).toHaveCount(0);
    const words = await box(turnView(page, runId).locator("[data-turn-answer]"));
    expect(Math.abs(words.y - stood.y), "the words take the indicator's place").toBeLessThanOrEqual(6);
    await expect(caret(page)).toHaveCount(1);
    provider.release("0:chunk:0");
    await expect(turnView(page, runId).locator("[data-turn-answer]")).toContainText("Five classes.");
  });

  test("two actions with one refusal keep one line each, identity and position held, live and settled; a call refused without execution shows no running state", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    harness.barrier("rename", (method, path) => method === "PATCH" && path.startsWith("/api/layers/"));
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Held rename" } }, { name: "teleport_map", args: { id: mapId } }] }, { text: "One done, one refused.", hold: { first: true } });
    const runId = await sendAndIdentify(page, "Rename and teleport");
    await harness.reached("rename");
    const lines = turnView(page, runId).locator("[data-record-entry]");
    await expect(lines).toHaveCount(1);
    const firstId = await lines.first().getAttribute("data-record-entry");
    await expect(lines.first()).toHaveAttribute("data-status", "running");
    harness.release("rename");
    await provider.reached("1:first");
    await expect(lines).toHaveCount(2);
    const ids = async () => lines.evaluateAll((els) => els.map((el) => `${el.getAttribute("data-record-entry")}:${el.getAttribute("data-status")}`));
    expect((await ids())[0]).toBe(`${firstId}:succeeded`);
    expect((await ids())[1]).toMatch(/:refused$/);
    // The refused call never ran: it never wore the running state (its
    // refusal arrived as its first and only event) and carries no mark.
    await expect(lines.nth(1).locator("[data-running-mark]")).toHaveCount(0);
    await expect(lines.nth(1).getByRole("button")).toContainText("Unknown tool: teleport_map");
    const liveIds = await ids();
    provider.release("1:first");
    await expect(pane(page).getByText("One done, one refused.", { exact: true })).toBeVisible();
    await expect(composer(page)).toBeEnabled();
    expect(await ids(), "settled: the same lines in the same order").toEqual(liveIds);
    await expect(lines).toHaveCount(2);
  });

  test("text before actions, several segments and text after a later action render in order, the caret on the active segment only", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push(
      { chunks: ["Starting ", "now."], calls: [{ name: "update_layer", args: { id: layerId, name: "Mid" } }], hold: { chunks: true } },
      { chunks: ["Renamed. ", "Next."], calls: [{ name: "list_tables", args: {} }], hold: { chunks: true } },
      { chunks: ["All ", "done."], hold: { chunks: true } },
    );
    const runId = await sendAndIdentify(page, "Talk, act, talk, act, talk");
    const answer = turnView(page, runId).locator("[data-turn-answer]");
    await provider.reached("0:chunk:0");
    await expect(answer).toHaveText("Starting");
    await expect(caret(page)).toHaveCount(1);
    provider.release("0:chunk:0");
    await provider.reached("1:chunk:0");
    await expect(answer).toContainText("Starting now.");
    await expect(answer).toContainText("Renamed.");
    // The caret on the active segment only: the last block of the answer.
    await expect(caret(page)).toHaveCount(1);
    expect(await caret(page).evaluate((el) => el.closest("[data-turn-answer]")!.lastElementChild!.contains(el))).toBe(true);
    provider.release("1:chunk:0");
    await provider.reached("2:chunk:0");
    await expect(answer).toContainText("All");
    await expect(turnView(page, runId).locator("[data-record-entry]")).toHaveCount(2);
    provider.release("2:chunk:0");
    await expect(answer).toContainText("All done.");
    await expect(composer(page)).toBeEnabled();
    await expect(caret(page)).toHaveCount(0);
    const text = await answer.innerText();
    expect(text.indexOf("Starting now.")).toBeLessThan(text.indexOf("Renamed. Next."));
    expect(text.indexOf("Renamed. Next.")).toBeLessThan(text.indexOf("All done."));
    // The lines above the whole answer, in order.
    const record = await box(turnView(page, runId).locator("[data-record]"));
    expect(record.y + record.height).toBeLessThanOrEqual((await box(answer)).y + 0.5);
  });
});

test.describe("the controls through execution, a parked card, settlement and a recovery read", () => {
  const stopControls = (page: Page) => pane(page).getByRole("button", { name: "Stop", exact: true });
  const slot = (page: Page) => pane(page).locator("[data-slot-control]");

  test("Stop in Send's slot during execution and while a card waits, one stop control, the input disabled with Working…; Send again at settlement; the ordinary controls during a recovery read", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    // Execution, held before the first delta.
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Slot" } }, { name: "publish_map", args: { id: mapId } }], hold: { first: true } });
    await sendAndIdentify(page, "Rename then publish");
    await provider.reached("0:first");
    await expect(slot(page)).toHaveAttribute("data-slot-control", "stop");
    await expect(stopControls(page)).toHaveCount(1);
    await expect(composer(page)).toBeDisabled();
    await expect(composer(page)).toHaveAttribute("placeholder", "Working…");
    provider.release("0:first");
    // Parked: the same.
    await expect(pane(page).locator("[data-confirmation]")).toBeVisible();
    await expect(slot(page)).toHaveAttribute("data-slot-control", "stop");
    await expect(stopControls(page)).toHaveCount(1);
    await expect(composer(page)).toBeDisabled();
    await expect(composer(page)).toHaveAttribute("placeholder", "Working…");
    // Cancel declines the presented action and the turn continues, wearing the running controls
    // again, then settles: Send.
    provider.replies.push({ text: "Left unpublished.", hold: { first: true } });
    await pane(page).locator("[data-confirmation]").getByRole("button", { name: "Cancel", exact: true }).click();
    await provider.reached("1:first");
    await expect(slot(page)).toHaveAttribute("data-slot-control", "stop");
    provider.release("1:first");
    await expect(pane(page).getByText("Left unpublished.", { exact: true })).toBeVisible();
    await expect(slot(page)).toHaveAttribute("data-slot-control", "send");
    await expect(composer(page)).toBeEnabled();
    await expect(composer(page)).toHaveAttribute("placeholder", "Ask the assistant…");
    await expect(stopControls(page)).toHaveCount(0);
    // A recovery read wears the ordinary controls (an earlier version
    // drained the response before aborting,
    // so the run had settled and the read's branch never ran). The run is
    // genuinely unsettled: its mutation is held at the harness, Stop leaves
    // it running until the mutation lands, and the pane offers the outcome
    // door. The door's read is held by a route, and every assertion runs.
    harness.barrier("held", (method, path) => method === "PATCH" && path.startsWith("/api/layers/"));
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Read while settling" } }] }, { text: "Never said." });
    const held = await sendAndIdentify(page, "Rename slowly");
    await harness.reached("held");
    const cancelled = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/api/assistant/runs/${held}/cancel`));
    await stopControls(page).click();
    await cancelled;
    const door = pane(page).getByRole("button", { name: "Check request outcome", exact: true });
    await expect(door).toBeVisible({ timeout: 15_000 });
    await expect(pane(page).getByText("still settling", { exact: false })).toBeVisible();
    expect((await api(page, "GET", `/api/assistant/runs/${held}`) as { state: string }).state, "the run is still running").toBe("running");
    let reading = false;
    await page.route(`**/api/assistant/runs/${held}`, async (route) => { reading = true; await new Promise((r) => setTimeout(r, 1500)); await route.continue(); }, { times: 1 });
    await door.click();
    await expect.poll(() => reading).toBe(true);
    // During the read: the controls captured in one synchronous read while
    // the route holds the receipt, then asserted on that capture, so a
    // retrying assertion cannot pass by waiting for the read to end.
    await expect(pane(page).locator("[data-phase]")).toHaveAttribute("data-phase", "reading");
    const during = await pane(page).evaluate((el) => ({
      phase: el.querySelector("[data-phase]")?.getAttribute("data-phase"),
      slot: el.querySelector("[data-slot-control]")?.getAttribute("data-slot-control"),
      placeholder: el.querySelector("textarea")?.getAttribute("placeholder"),
      disabled: el.querySelector("textarea")?.hasAttribute("disabled"),
      stops: Array.from(el.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Stop").length,
    }));
    expect(during).toEqual({ phase: "reading", slot: "send", placeholder: "Ask the assistant…", disabled: true, stops: 0 });
    // The read finds the run still running: the door and the note again.
    await expect(door).toBeVisible({ timeout: 15_000 });
    await expect(pane(page).locator("[data-phase]")).toHaveAttribute("data-phase", "idle");
    harness.release("held");
    await expect.poll(async () => (await api(page, "GET", `/api/assistant/runs/${held}`) as { state: string }).state, { timeout: 15_000 }).toBe("interrupted");
    await door.click();
    await expect(turnView(page, held).locator("[data-record-entry][data-tool='update_layer']")).toHaveAttribute("data-status", "succeeded");
    await expect(composer(page)).toBeEnabled();
    await expect(slot(page)).toHaveAttribute("data-slot-control", "send");
  });

  test("a Stop whose abandonment response is lost still settles the turn from the receipt; if that read fails too, a recovery door stays", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    // The DELETE reaches the server and succeeds; its response is lost.
    provider.replies.push({ calls: [{ name: "publish_map", args: { id: mapId } }] });
    const first = await sendAndIdentify(page, "Publish it");
    await expect(pane(page).locator("[data-confirmation]")).toBeVisible();
    await expect(pane(page).locator("[data-phase]")).toHaveAttribute("data-phase", "parked");
    await page.route(`**/api/assistant/runs/${first}`, async (route) => {
      if (route.request().method() !== "DELETE") { await route.continue(); return; }
      const response = await route.fetch(); await response.body(); await route.abort("connectionreset");
    }, { times: 1 });
    await stopControls(page).click();
    // Seeded defect on the tree before the fix: the old card stayed, no door, the composer
    // disabled, a retry answered 409.
    await expect(pane(page).locator("[data-confirmation]")).toHaveCount(0, { timeout: 15_000 });
    await expect(composer(page)).toBeEnabled();
    const stopped = turnView(page, first).locator("[data-record-entry][data-tool='publish_map']");
    await expect(stopped.getByRole("button")).toContainText("You stopped the request, so this was not done.");
    expect((await api(page, "GET", `/api/assistant/runs/${first}`) as { state: string }).state).toBe("interrupted");
    expect((await api(page, "GET", `/api/maps/${mapId}`) as { publishToken: string | null }).publishToken).toBeNull();
    // The response lost and the receipt read failing too: the door stays and leads to the settled
    // turn.
    provider.replies.push({ calls: [{ name: "publish_map", args: { id: mapId } }] });
    const second = await sendAndIdentify(page, "Publish it again");
    await expect(pane(page).locator("[data-confirmation]")).toBeVisible();
    await expect(pane(page).locator("[data-phase]")).toHaveAttribute("data-phase", "parked");
    let reads = 0;
    await page.route(`**/api/assistant/runs/${second}`, async (route) => {
      if (route.request().method() === "DELETE") { const response = await route.fetch(); await response.body(); await route.abort("connectionreset"); return; }
      if (route.request().method() === "GET" && reads === 0) { reads += 1; await route.abort("connectionreset"); return; }
      await route.continue();
    });
    await stopControls(page).click();
    const door = pane(page).getByRole("button", { name: "Check request outcome", exact: true });
    await expect(door).toBeVisible({ timeout: 15_000 });
    await expect(pane(page).locator("[data-confirmation]")).toHaveCount(0);
    await expect(stopControls(page)).toHaveCount(0);
    await expect(composer(page)).toHaveAttribute("placeholder", "Ask the assistant…");
    await door.click();
    await expect(turnView(page, second).locator("[data-record-entry][data-tool='publish_map']").getByRole("button")).toContainText("You stopped the request, so this was not done.");
    await expect(composer(page)).toBeEnabled();
    await page.unroute(`**/api/assistant/runs/${second}`);
    expect(provider.captures, "no provider call after either stop").toHaveLength(2);
    expect((await api(page, "GET", `/api/maps/${mapId}`) as { publishToken: string | null }).publishToken).toBeNull();
  });

  test("Stop while a card waits ends the turn through the abandonment: nothing executed, no provider call, no dispatch after, the target unchanged, the line for a stopped request, the run settled, the input enabled", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Before the stop" } }, { name: "publish_map", args: { id: mapId } }] });
    const runId = await sendAndIdentify(page, "Rename then publish");
    await expect(pane(page).locator("[data-confirmation]")).toBeVisible();
    const dispatchesBefore = harness.dispatches.length;
    const capturesBefore = provider.captures.length;
    const abandonment = page.waitForRequest((r) => r.method() === "DELETE" && r.url().endsWith(`/api/assistant/runs/${runId}`));
    await stopControls(page).click();
    await abandonment;
    await expect(pane(page).locator("[data-confirmation]")).toHaveCount(0);
    await expect(composer(page)).toBeEnabled();
    const view = turnView(page, runId);
    await expect(view.locator("[data-record-entry]")).toHaveCount(2);
    await expect(view.locator("[data-record-entry]").nth(0)).toHaveAttribute("data-status", "succeeded");
    const stopped = view.locator("[data-record-entry]").nth(1);
    await expect(stopped).toHaveAttribute("data-status", "refused");
    await expect(stopped.getByRole("button")).toContainText("Publish");
    await expect(stopped.getByRole("button")).toContainText("You stopped the request, so this was not done.");
    // Its inspection says the same origin.
    await stopped.getByRole("button").click();
    await expect(stopped.locator("[data-decision='superseded']")).toHaveText("Stopped by you.");
    expect(await stopped.innerText()).not.toMatch(/next message/);
    await page.waitForTimeout(400);
    expect(harness.dispatches.length, "no product dispatch after the stop").toBe(dispatchesBefore);
    expect(provider.captures.length, "no provider call after the stop").toBe(capturesBefore);
    const map = await api(page, "GET", `/api/maps/${mapId}`) as { publishToken: string | null };
    expect(map.publishToken, "the target unchanged").toBeNull();
    const receipt = await api(page, "GET", `/api/assistant/runs/${runId}`) as { state: string; confirmations?: { decision: string }[] };
    expect(receipt.state).toBe("interrupted");
    expect(receipt.confirmations?.[0]?.decision).toBe("superseded");
    // A new message goes out afterwards.
    provider.replies.push({ text: "Fresh start." });
    await sendAndIdentify(page, "A new message");
    await expect(pane(page).getByText("Fresh start.", { exact: true })).toBeVisible();
  });
});

test.describe("task 13: error termination", () => {
  test("a provider failure mid-turn ends the turn honestly: the lines kept, the failure worded, the message once, Send back, nothing further dispatched", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    // One scripted reply only: the continuation after the action finds none and the provider fails.
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Then failed" } }] });
    const runId = await sendAndIdentify(page, "Rename, then fail");
    const view = turnView(page, runId);
    await expect(view.locator("[data-record-entry][data-tool='update_layer']")).toHaveAttribute("data-status", "succeeded");
    await expect(pane(page).locator("[role='alert']")).toBeVisible({ timeout: 15_000 });
    expect(await pane(page).locator("[role='alert']").innerText()).toMatch(/provider|model/i);
    await expect(composer(page)).toBeEnabled();
    await expect(pane(page).locator("[data-slot-control]")).toHaveAttribute("data-slot-control", "send");
    await expect(view.locator("[data-record-entry]")).toHaveCount(1);
    await expect(pane(page).locator("[data-turn-message]")).toHaveCount(1);
    await page.waitForTimeout(400);
    expect(harness.dispatches.filter((d) => d.method === "PATCH").length).toBe(1);
    expect(provider.captures).toHaveLength(2);
    const receipt = await api(page, "GET", `/api/assistant/runs/${runId}`) as { state: string; error?: { code: string } };
    expect(receipt.state).toBe("failed");
    expect(receipt.error?.code).toBe("assistant_provider");
  });
});


test.describe("the status region", () => {
  /** Record every change of the region's words, from before the press. */
  async function armStatus(page: Page) {
    await page.evaluate(() => {
      const w = window as unknown as { __status: string[] };
      w.__status = [];
      const region = document.querySelector("[data-assistant-pane] [data-turn-status]")!;
      new MutationObserver(() => { const text = region.textContent ?? ""; if (text && w.__status.at(-1) !== text) w.__status.push(text); }).observe(region, { childList: true, characterData: true, subtree: true });
    });
  }
  const statusLog = (page: Page) => page.evaluate(() => (window as unknown as { __status: string[] }).__status);
  /** Everything the region carried, in order: one render may join the
   * transitions it carries into one text, so the stream is the invariant. */
  const stream = async (page: Page) => (await statusLog(page)).join(" ");
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** A regex for the expected sentences in order, each exactly once, nothing between them but a space. */
  const sequence = (parts: (string | RegExp)[]) => new RegExp("^" + parts.map((p) => (typeof p === "string" ? escape(p) : p.source)).join(" ") + "$");

  test("announces the start, each action's start and outcome, the gate's words once, the continuation and the settled outcome, in order, nothing per token", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    await expect(pane(page).locator("[role='status']")).toHaveCount(1);
    await armStatus(page);
    harness.barrier("rename", (method, path) => method === "PATCH" && path.startsWith("/api/layers/"));
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Announced" } }, { name: "teleport_map", args: { id: mapId } }, { name: "publish_map", args: { id: mapId } }] }, { chunks: ["Left ", "unpublished."], hold: { chunks: true } });
    await sendAndIdentify(page, "Rename, teleport, publish");
    await harness.reached("rename");
    harness.release("rename");
    const card = pane(page).locator("[data-confirmation]");
    await expect(card).toBeVisible();
    const target = await card.locator("p").first().innerText();
    const consequence = await card.locator("p").nth(1).innerText();
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await provider.reached("1:chunk:0");
    // The snapshot before the streamed text: taken once the decline's
    // sentence, the last expected before the reply, is in the region. The
    // fixture's hold is server-side and can precede the browser applying
    // the decline's result, so a sample at the hold alone raced it, once
    // in forty-three independent runs.
    await expect.poll(() => stream(page)).toMatch(/Publish [^:]+: not done\. You cancelled it, so this was not done\.$/);
    const beforeToken = await stream(page);
    provider.release("1:chunk:0");
    await expect(pane(page).getByText("Left unpublished.", { exact: true })).toBeVisible();
    await expect(composer(page)).toBeEnabled();
    const log = await stream(page);
    expect(log).toMatch(sequence([
      "Working on your message.",
      "Updated the layer Announced: in progress.",
      /Updated the layer Announced: done, \d+(\.\d+)? s\./,
      "teleport_map: not done. Unknown tool: teleport_map.",
      `Confirmation required. ${target} ${consequence}`,
      "Continuing.",
      /Publish [^:]+: not done\. You cancelled it, so this was not done\./,
      "Reply complete.",
    ]));
    // The streamed answer added nothing between the continuation's sentences and the outcome.
    expect(log.startsWith(beforeToken)).toBe(true);
    expect(log.slice(beforeToken.length).trim()).toBe("Reply complete.");
    expect(log.split("Confirmation required").length - 1, "the gate's words once").toBe(1);
  });

  test("a parked turn ended by Stop announces the stopped line and the stopped outcome", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    await armStatus(page);
    provider.replies.push({ calls: [{ name: "publish_map", args: { id: mapId } }] });
    await sendAndIdentify(page, "Publish it");
    await expect(pane(page).locator("[data-confirmation]")).toBeVisible();
    await stopButton(page).click();
    await expect(composer(page)).toBeEnabled();
    expect(await stream(page)).toMatch(sequence([
      "Working on your message.",
      /Confirmation required\. Publish [^?]+\? Anyone with the link can view its published data\./,
      /Publish [^:]+: not done\. You stopped the request, so this was not done\./,
      "Request stopped.",
    ]));
  });
});

test.describe("focus and the keyboard", () => {
  const activeIs = (page: Page) => page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    if (el.matches("[data-slot-control]")) return `slot:${el.getAttribute("data-slot-control")}`;
    if (el.matches("textarea")) return "composer";
    if (el.closest("[data-confirmation]")) return "card";
    if (el.closest("[data-record-entry]")) return "entry";
    return "elsewhere";
  });

  test("Stop is reached and activated from the keyboard during execution and while parked; focus follows the table at submission, resolution, parking and settlement", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    // Submission from the keyboard: the composer disabled under focus hands to Stop.
    provider.replies.push({ chunks: ["Held ", "answer."], hold: { first: true } });
    await composer(page).focus();
    await page.keyboard.type("Say something");
    const first = page.waitForRequest((r) => r.url().endsWith("/api/assistant/messages") && r.method() === "POST");
    await page.keyboard.press("Enter");
    const run1 = (await first).postDataJSON().runId as string;
    await provider.reached("0:first");
    expect(await activeIs(page)).toBe("slot:stop");
    // Activated by key: the cancellation observed.
    const cancelled = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/api/assistant/runs/${run1}/cancel`));
    await page.keyboard.press("Enter");
    await cancelled;
    await expect.poll(async () => (await api(page, "GET", `/api/assistant/runs/${run1}`) as { state: string }).state, { timeout: 15_000 }).not.toBe("running");
    // The pane may have read the outcome before the server settled: its
    // door, pressed by key, leaves under focus with the settlement.
    const door = pane(page).getByRole("button", { name: "Check request outcome", exact: true });
    if (await door.count()) { await door.focus(); await page.keyboard.press("Enter"); }
    await expect(composer(page)).toBeEnabled();
    // Settlement with Stop (or the door) focused: the enabled composer.
    await expect.poll(() => activeIs(page)).toBe("composer");
    provider.release("0:first");
    // A parked turn: Stop reached by Tab from the card and activated by key.
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Focused" } }, { name: "publish_map", args: { id: mapId } }] });
    await page.keyboard.type("Rename then publish");
    const second = page.waitForRequest((r) => r.url().endsWith("/api/assistant/messages") && r.method() === "POST");
    await page.keyboard.press("Enter");
    const run2 = (await second).postDataJSON().runId as string;
    await expect(pane(page).locator("[data-confirmation]")).toBeVisible();
    // Parking left the focus where it was: on Stop, which stays in the slot.
    expect(await activeIs(page)).toBe("slot:stop");
    await pane(page).locator("[data-confirmation]").getByRole("button", { name: "Confirm", exact: true }).focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    expect(await activeIs(page)).toBe("slot:stop");
    const abandoned = page.waitForRequest((r) => r.method() === "DELETE" && r.url().endsWith(`/api/assistant/runs/${run2}`));
    await page.keyboard.press("Space");
    await abandoned;
    await expect(composer(page)).toBeEnabled();
    expect(await activeIs(page)).toBe("composer");
    // Resolution from the card: Confirm removes the card's control under focus and a continuation
    // starts, so Stop takes it.
    provider.replies.push({ calls: [{ name: "publish_map", args: { id: mapId } }] }, { text: "Published.", hold: { first: true } });
    await page.keyboard.type("Publish it");
    await page.keyboard.press("Enter");
    const confirm = pane(page).locator("[data-confirmation]").getByRole("button", { name: "Confirm", exact: true });
    await expect(confirm).toBeVisible();
    await confirm.focus();
    await page.keyboard.press("Enter");
    await provider.reached("3:first");
    expect(await activeIs(page)).toBe("slot:stop");
    provider.release("3:first");
    await expect(pane(page).getByText("Published.", { exact: true })).toBeVisible();
    await expect(composer(page)).toBeEnabled();
    expect(await activeIs(page)).toBe("composer");
  });

  test("focus anywhere else stays through a whole turn, an open inspection included", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "First" } }] }, { text: "First done." });
    const earlier = await sendAndIdentify(page, "Rename first");
    await expect(pane(page).getByText("First done.", { exact: true })).toBeVisible();
    // The next turn is sent, then focus moves to the earlier turn's inspection and stays there
    // through the turn.
    harness.barrier("rename", (method, path) => method === "PATCH" && path.startsWith("/api/layers/"));
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Second" } }, { name: "publish_map", args: { id: mapId } }] }, { chunks: ["Done ", "now."], hold: { first: true } });
    await sendAndIdentify(page, "Rename then publish");
    const expander = turnView(page, earlier).locator("[data-record-entry]").getByRole("button");
    await expander.focus();
    await page.keyboard.press("Enter");
    await expect(turnView(page, earlier).locator("[data-inspection]")).toBeVisible();
    expect(await activeIs(page)).toBe("entry");
    await harness.reached("rename");
    expect(await activeIs(page)).toBe("entry");
    harness.release("rename");
    await expect(pane(page).locator("[data-confirmation]")).toBeVisible();
    expect(await activeIs(page), "parking takes no focus").toBe("entry");
    await pane(page).locator("[data-confirmation]").getByRole("button", { name: "Cancel", exact: true }).click({ position: { x: 5, y: 5 } });
    await provider.reached("3:first");
    provider.release("3:first");
    await expect(pane(page).getByText("Done now.", { exact: true })).toBeVisible();
    await expect(composer(page)).toBeEnabled();
    await expander.focus();
    expect(await activeIs(page)).toBe("entry");
    await expect(turnView(page, earlier).locator("[data-inspection]")).toBeVisible();
  });
});

test.describe("reduced motion", () => {
  test("the indicator, the running mark, the check, the refusal and the caret are each visible, stationary and distinguishable", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    const still = async (selector: string) => page.locator(selector).first().evaluate(async (el) => {
      const rect = () => { const r = el.getBoundingClientRect(); return `${r.x},${r.y},${r.width},${r.height}`; };
      const a = rect(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const b = rect();
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { stationary: a === b, visible: cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0 && r.width > 0 && r.height > 0, animation: cs.animationName };
    });
    harness.barrier("rename", (method, path) => method === "PATCH" && path.startsWith("/api/layers/"));
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Still" } }, { name: "teleport_map", args: { id: mapId } }], hold: { first: true } }, { chunks: ["Quiet ", "words."], hold: { chunks: true } });
    const runId = await sendAndIdentify(page, "Rename, teleport, answer");
    await provider.reached("0:first");
    const dots = await still("[data-thinking] i");
    expect(dots).toMatchObject({ stationary: true, visible: true, animation: "none" });
    provider.release("0:first");
    await harness.reached("rename");
    const mark = await still("[data-running-mark] span");
    expect(mark).toMatchObject({ stationary: true, visible: true, animation: "none" });
    harness.release("rename");
    await provider.reached("1:chunk:0");
    const view = turnView(page, runId);
    const check = await still(`[data-turn="${runId}"] [data-record-entry][data-status='succeeded'] [aria-label='done'] svg`);
    const cross = await still(`[data-turn="${runId}"] [data-record-entry][data-status='refused'] [aria-label='not done'] svg`);
    const caret = await still("[data-caret]");
    expect(check).toMatchObject({ stationary: true, visible: true, animation: "none" });
    expect(cross).toMatchObject({ stationary: true, visible: true, animation: "none" });
    expect(caret).toMatchObject({ stationary: true, visible: true, animation: "none" });
    // Distinguishable: five different marks, each present once where it belongs.
    await expect(view.locator("[data-record-entry][data-status='succeeded'] [aria-label='done'] svg path")).toHaveAttribute("d", "M20 6L9 17l-5-5");
    await expect(view.locator("[data-record-entry][data-status='refused'] [aria-label='not done'] svg path")).toHaveAttribute("d", "M18 6L6 18M6 6l12 12");
    await expect(pane(page).locator("[data-caret]")).toHaveCount(1);
    await expect(pane(page).locator("[data-thinking]")).toHaveCount(0);
    await expect(pane(page).locator("[data-running-mark]")).toHaveCount(0);
    provider.release("1:chunk:0");
    await expect(composer(page)).toBeEnabled();
  });
});

test.describe("1f and 3b: what streaming and a long transcript must keep", () => {
  test("completed blocks before the active one keep their content, formatting and scroll-normalised geometry as later chunks arrive", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    // Three chunks: the first completes a heading and a paragraph with bold, the
    // second opens a list, the third finishes it and adds a last paragraph.
    provider.replies.push({ chunks: ["## What changed\n\nThe layer **parks** has five classes.\n\n", "- Breaks: 0.4 and 1.1 ha\n- Ramp", ": kelp\n\nSay which."], hold: { chunks: true } });
    const runId = await sendAndIdentify(page, "Colour the parks by area");
    const answer = turnView(page, runId).locator("[data-turn-answer]");
    /** The completed blocks' content, tags and rectangles relative to the transcript's scroll. */
    const completed = async (count: number) => answer.evaluate((el, n) => {
      const transcript = el.closest("[data-transcript]") as HTMLElement;
      const base = transcript.getBoundingClientRect().top - transcript.scrollTop;
      return Array.from(el.children).slice(0, n).map((child) => {
        const r = child.getBoundingClientRect();
        return { tag: child.tagName, html: child.innerHTML.replace(/<span[^>]*data-caret[^>]*><\/span>/, ""), top: Math.round((r.top - base) * 10) / 10, height: Math.round(r.height * 10) / 10, left: Math.round(r.left * 10) / 10, width: Math.round(r.width * 10) / 10 };
      });
    }, count);
    await provider.reached("0:chunk:0");
    await expect(answer.locator("h4")).toHaveText("What changed");
    await expect(answer.locator("p strong")).toHaveText("parks");
    const two = await completed(2);
    expect(two.map((b) => b.tag)).toEqual(["H4", "P"]);
    provider.release("0:chunk:0");
    await provider.reached("0:chunk:1");
    await expect(answer.locator("ul li")).toHaveCount(2);
    expect(await completed(2), "the heading and the paragraph unchanged while the list is the active block").toEqual(two);
    const three = await completed(3);
    provider.release("0:chunk:1");
    await expect(answer).toContainText("Say which.");
    await expect(composer(page)).toBeEnabled();
    expect((await completed(2)), "still unchanged at settlement").toEqual(two);
    expect((await completed(3))[2], "the list, completed by the last chunk, kept its place and its two items' content").toMatchObject({ tag: "UL", top: three[2].top, left: three[2].left });
    await expect(answer.locator("ul li")).toHaveCount(2);
  });

  test("earlier turns are reachable by scrolling a long transcript", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    const first = "The first of many turns";
    let firstRun = "";
    for (let i = 0; i < 6; i += 1) {
      provider.replies.push({ text: `Reply ${i + 1}.\n\n- one\n- two\n- three\n- four\n- five` });
      const run = await sendAndIdentify(page, i === 0 ? first : `Turn ${i + 1}`);
      if (i === 0) firstRun = run;
      await expect(pane(page).getByText(`Reply ${i + 1}.`, { exact: true })).toBeVisible();
    }
    const transcript = pane(page).locator("[data-transcript]");
    expect(await transcript.evaluate((el) => el.scrollHeight > el.clientHeight), "the transcript overflows").toBe(true);
    const inView = () => turnView(page, firstRun).locator("[data-turn-message]").evaluate((el) => {
      const t = el.closest("[data-transcript]")!.getBoundingClientRect(); const r = el.getBoundingClientRect();
      return r.top >= t.top - 0.5 && r.bottom <= t.bottom + 0.5;
    });
    expect(await inView(), "the first turn starts out of view").toBe(false);
    await transcript.evaluate((el) => { el.scrollTop = 0; });
    expect(await inView(), "scrolled to the top, the first turn is in view").toBe(true);
    await expect(turnView(page, firstRun).locator("[data-turn-message]")).toHaveText(first);
  });
});
