// The residual's browser smoke: the assistant confirmation flow driven through
// the real panel against a REAL model. CREDENTIAL-GATED by design — ONE
// configuration away from running, no rewrite needed: launch the standalone
// server with a real model key (ANTHROPIC_API_KEY or OPENAI_API_KEY) and run `npm
// run e2e:smoke`, which sets the opt-in itself.
//
// Two gates, each skipping VISIBLY with its own reason, never silently: the
// opt-in (so a real model call never rides the full double pass), and the
// SERVER's own report that a credential exists — `GET /api/assistant`. Opted in
// without a key therefore skips with the server's documented enablement reason
// rather than failing, and the residual stays open at its recorded class. The
// mechanical arc it proves when run: the panel sends a message, the confirmation
// prompt appears with the documented copy, one Confirm executes the parked action
// exactly once (exactly one `publish_map` execution crosses the assistant's
// NDJSON stream), and the turn completes with nothing left spinning.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  FIXTURES_DIR,
  addLayer,
  createMap,
  routeHouse,
  saveSettled,
  seedCsv,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `smk_${runId}`;

test("assistant confirmation: prompt, approve, exactly-once execution", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.DEZFIL_E2E_ASSISTANT !== "1",
    "Not opted in: this smoke spends a real model call, so it runs only " +
      "under `npm run e2e:smoke` (which sets DEZFIL_E2E_ASSISTANT=1) " +
      "— never inside the full double pass. Skipping VISIBLY, never silently.",
  );
  test.setTimeout(300_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  // EXECUTIONS, counted where they are observable:
  // publish is idempotent while a map is published, so a stable token
  // cannot prove exactly-once. The assistant's NDJSON stream emits one
  // `tool_result` per EXECUTED tool call, so a duplicate execution shows
  // up as a second `publish_map` result and fails the count. Counted
  // in-page by teeing the fetch stream (on a first credentialed run
  // CDP body retrieval loses streamed NDJSON bodies, so a
  // `page.on("response")` counter read 0 while the publish demonstrably
  // executed — a defect in the measurement, not the product). Armed
  // before any turn starts; the init script re-arms on navigation, and
  // the whole assistant exchange happens on one document.
  await page.addInitScript(() => {
    const executions: string[] = [];
    (window as unknown as { __publishExecutions: string[] }).__publishExecutions =
      executions;
    const origFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await origFetch(input, init);
      try {
        const raw =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : String(input);
        const url = new URL(raw, location.origin);
        if (/^\/api\/assistant(\/|$)/.test(url.pathname) && res.body) {
          const [toCaller, toCounter] = res.body.tee();
          void (async () => {
            const reader = toCounter.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            const consume = (chunk: string) => {
              buffer += chunk;
              let newline = buffer.indexOf("\n");
              while (newline >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf("\n");
                if (!line.trim()) continue;
                try {
                  const event = JSON.parse(line) as {
                    type?: string;
                    tool?: string;
                  };
                  if (
                    event?.type === "tool_result" &&
                    event.tool === "publish_map"
                  )
                    executions.push(line);
                } catch {
                  // the stream's own framing owns partial lines
                }
              }
            };
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              consume(decoder.decode(value, { stream: true }));
            }
            consume(decoder.decode());
          })();
          return new Response(toCaller, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        }
      } catch {
        // never let the counter break the page's own fetch
      }
      return res;
    };
  });
  const publishExecutionCount = () =>
    page.evaluate(
      () =>
        (window as unknown as { __publishExecutions?: string[] })
          .__publishExecutions?.length ?? 0,
    );

  await page.goto("/maps");
  // The SERVER's own answer on whether a credential exists: opted in but
  // with no key configured, this skips with the
  // server's documented enablement reason instead of failing on an absent
  // panel — so the documented command really is one configured key from
  // running, and never reddens the gate when the key is missing.
  const assistant = await page.evaluate(
    async () =>
      (await (
        await fetch("/api/assistant", { cache: "no-store" })
      ).json()) as { enabled: boolean; reason?: string },
  );
  test.skip(
    !assistant.enabled,
    "The server reports the assistant absent (residual, stop rule 6) —" +
      `${assistant.reason ?? "no reason given"} Skipping VISIBLY.`,
  );
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, tableName, csv);
  // Unique per run: on a reused instance a constant name can match several
  // maps, and a real model then reasonably asks which one to publish
  // instead of calling the tool (observed on a first credentialed run).
  const mapName = `assistant smoke ${runId}`;
  const mapId = await createMap(page, mapName);
  await addLayer(page, mapId, tableName, `SELECT * FROM ${tableName}`);
  await page.goto(`/maps/${mapId}`);
  await expect(
    page.getByRole("button", { name: new RegExp(`^${tableName}`) }),
  ).toBeVisible({ timeout: 30_000 });
  await saveSettled(page);

  await test.step("a gated request parks at the documented confirmation prompt", async () => {
    // The mounted Tools-slot assistant pane keeps the builder context.
    await page.getByRole("button", { name: "Open assistant" }).click();
    const input = page.getByPlaceholder("Ask the assistant…");
    await expect(input).toBeVisible();
    await input.fill(
      `Publish the map named "${mapName}" (id ${mapId}) now, using your publish tool.`,
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // A real model is thinking — patient window, settled anchor: the
    // prompt is a named non-modal group, not an
    // alertdialog. This locator edit is plausible until the next
    // credentialed run — the exact hazard the note above records.
    const prompt = page.getByRole("group", {
      name: `Publish ${mapName} (${mapId})?`,
      exact: true,
    });
    await expect(prompt).toBeVisible({ timeout: 120_000 });
    await expect(prompt).toContainText("Anyone with the link can view its published data.");
  });

  await test.step("Confirm executes the parked action exactly once", async () => {
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    // The action lands: the map publishes, exactly once.
    await expect
      .poll(
        async () =>
          page.evaluate(async (id) => {
            const map = (await (
              await fetch(`/api/maps/${id}`, { cache: "no-store" })
            ).json()) as { publishToken: string | null };
            return map.publishToken;
          }, mapId),
        { timeout: 120_000 },
      )
      .not.toBeNull();
    // The turn completes: the composer returns to ready, nothing spins.
    await expect(page.getByPlaceholder("Ask the assistant…")).toBeVisible({
      timeout: 120_000,
    });
    // Exactly ONE publish EXECUTION crossed the stream — not merely one
    // stable token. A second execution (a re-run parked call, a
    // double-confirm) appends another `publish_map` result and reddens
    // this count.
    await expect
      .poll(publishExecutionCount, { timeout: 120_000 })
      .toBe(1);
    await page.waitForTimeout(1_000);
    expect(await publishExecutionCount()).toBe(1);
  });

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});
