// Publish and tile lifecycle: the lifecycle a reader can reach — publish
// through the real UI, unpublish (the link stops resolving, with the
// documented viewer presentation), republish — plus the over-cap tiled
// road end-to-end in the published viewer, and the two tiled-failure
// codes driven SPECIFICALLY:
//
// - `tile_build_failed` — REAL and end-to-end over the published wire:
//   the tiles directory is made unwritable, the layer's SQL changes (a
//   new fingerprint forces a rebuild), and the real tippecanoe build
//   fails; the published envelope must carry exactly the documented
//   catalogue sentence and the viewer must present the failed layer as
//   documented. Gated on DEZFIL_DATA_DIR (the drive needs the
//   server's tiles directory) — skips VISIBLY without it.
// - `tiler_unavailable` — a VIEWER-BOUNDARY drive, and labeled so: the
//   documented envelope shape for that code is served to the viewer,
//   asserting its specific documented prose. (A real spawn-failure needs
//   a differently-launched server; the class's wire substitution is
//   held at the boundary.)
//
// Environment: the documented gate; the real-failure drive additionally
// needs DEZFIL_DATA_DIR pointing at the server's data directory. Run
// via `npm run e2e:lifecycle`.
import { test, expect } from "@playwright/test";
import { readFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import { MVT_WORKER_URL } from "../src/components/map/tiled-layer";
import {
  FIXTURES_DIR,
  addLayer,
  consumeExpected,
  createMap,
  exactly,
  patchLayer,
  patchMap,
  publishMap,
  readPublished,
  routeHouse,
  saveSettled,
  seedCsv,
  trackConsole,
  type ConsoleError,
} from "./support";
import { markStats } from "./png-probes";

/** The two 404s a dead published link casts, each consumed once and only
 * for that link: the document the published root answers with its
 * not-found page, and the step's own probe of the payload. Any other
 * failure, on these routes or another link, stays for the final check. */
async function consumeDeadLink(errors: ConsoleError[], origin: string, token: string): Promise<void> {
  await consumeExpected(errors, exactly(`${origin}/v/${token}`), /status of 404/);
  await consumeExpected(errors, exactly(`${origin}/api/published/${token}`), /status of 404/);
}

const runId = Date.now().toString(36);
const tableName = `plc_${runId}`;
const DATA_DIR = process.env.DEZFIL_DATA_DIR;

const TILE_BUILD_FAILED_SENTENCE =
  "The layer's tile archive could not be built.";
const TILER_UNAVAILABLE_SENTENCE =
  "The result is too large for inline rendering and no tile builder is installed on this instance.";

test("publish, unpublish, republish — the link lifecycle a reader sees", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, tableName, csv);
  const mapId = await createMap(page, "publish lifecycle");
  await addLayer(page, mapId, tableName, `SELECT * FROM ${tableName}`);
  await page.goto(`/maps/${mapId}`);
  await expect(
    page.getByRole("button", { name: new RegExp(`^${tableName}`) }),
  ).toBeVisible({ timeout: 30_000 });
  await saveSettled(page);

  let firstUrl = "";
  await test.step("publish through the real UI yields a working link", async () => {
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByRole("button", { name: "Publish map" }).click();
    await expect(page.getByText("Published · just now")).toBeVisible();
    firstUrl =
      (await page
        .locator("[data-publish-url]")
        .getAttribute("data-publish-url")) ?? "";
    expect(firstUrl).toMatch(/\/v\/.+/);
    await page.goto(firstUrl);
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(page.getByText("made with Dezfil")).toBeVisible();
  });

  await test.step("the embed view yields a snippet framing the same link", async () => {
    await page.goto(`/maps/${mapId}`);
    await page.getByRole("button", { name: "Published", exact: true }).click();
    await page.getByRole("button", { name: "Embed" }).click();
    const snippet = await page
      .getByRole("textbox", { name: "Embed code" })
      .inputValue();
    // The embed frames the same link, marked as embedded so the marked
    // view renders the reduced control set. The marker rides the
    // snippet only — the copy-link hero is still the plain link.
    expect(snippet).toContain(`<iframe src="${firstUrl}?embed=1"`);
    expect(snippet).toContain('height="480"');
    expect(
      await page
        .getByRole("textbox", { name: "Embed code" })
        .inputValue(),
    ).not.toContain(`src="${firstUrl}"`);
    // The way back returns to the main view.
    await page.getByRole("button", { name: "Back" }).click();
    await expect(
      page.getByRole("button", { name: "Copy link" }),
    ).toBeVisible();
  });

  await test.step("unpublish: the link stops resolving with the documented presentation", async () => {
    await page.goto(`/maps/${mapId}`);
    // The opener reads "Published" while a publish stands.
    await page.getByRole("button", { name: "Published", exact: true }).click();
    await page.getByRole("button", { name: "Unpublish" }).click();
    await expect(page.getByRole("button", { name: "Publish map" })).toBeVisible();
    // The reader's view of a dead link: the documented not-found page,
    // not an error dump.
    await page.goto(firstUrl);
    await expect(page.getByText("Map not found")).toBeVisible();
    await expect(
      page.getByText("This link is no longer available."),
    ).toBeVisible();
    // The API answers 404 under the old token.
    const status = await page.evaluate(async (url) => {
      const token = url.split("/v/")[1];
      return (await fetch(`/api/published/${token}`)).status;
    }, firstUrl);
    expect(status).toBe(404);
    // The published root answers the dead link with its not-found page
    // before any client view mounts, so the page makes no read of its own:
    // the document's 404 and the probe's are the step's only shadows.
    await consumeDeadLink(consoleErrors, new URL(page.url()).origin, firstUrl.split("/v/")[1]);
  });

  await test.step("a token that never existed gets the same designed presentation", async () => {
    // A revoked token and a never-issued one are different lookups: this one is well-formed — 22
    // base-62 chars, the
    // documented shape — and was never minted, so only genuinely unknown
    // tokens take this path.
    const neverIssued = "Zq7Kx2Lm9Pb4Rt6Wv8Hn3Y";
    expect(neverIssued).toMatch(/^[0-9A-Za-z]{22}$/);
    await page.goto(`/v/${neverIssued}`);
    await expect(page.getByText("Map not found")).toBeVisible();
    await expect(
      page.getByText("This link is no longer available."),
    ).toBeVisible();
    const status = await page.evaluate(
      async (token) => (await fetch(`/api/published/${token}`)).status,
      neverIssued,
    );
    expect(status).toBe(404);
    // As for the revoked link: the document's 404 and the probe's, no other.
    await consumeDeadLink(consoleErrors, new URL(page.url()).origin, neverIssued);
  });

  await test.step("publishing again yields a working link", async () => {
    await page.goto(`/maps/${mapId}`);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByRole("button", { name: "Publish map" }).click();
    await expect(page.getByText("Published · just now")).toBeVisible();
    const nextUrl =
      (await page
        .locator("[data-publish-url]")
        .getAttribute("data-publish-url")) ?? "";
    await page.goto(nextUrl);
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(page.getByText("made with Dezfil")).toBeVisible();
  });

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("the tiled road reaches the reader, and its failure classes present specifically", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const consoleErrors = trackConsole(page);
  const parserWorkerRequests: string[] = [];
  context.on("request", (request) => {
    const url = request.url();
    if (/mvt-worker/i.test(url)) parserWorkerRequests.push(url);
  });
  await routeHouse(context, { basemapStyleStub: true });

  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  const bigTable = `plcbig_${runId}`;
  await seedCsv(page, bigTable, csv);
  const mapId = await createMap(page, "tiled lifecycle");
  const layerName = `${bigTable} tiled`;
  // 2,401 synthesized points cross the documented 2,000-feature cap.
  const overCapSql = `SELECT
      ST_Point(
        ST_X(p.geometry) + (r.i % 60) * 0.0005,
        ST_Y(p.geometry) + floor(r.i / 60) * 0.0005
      ) AS geometry
    FROM (SELECT geometry FROM ${bigTable} LIMIT 1) AS p
    CROSS JOIN range(0, 2401) AS r(i)`;
  const layerId = await addLayer(page, mapId, layerName, overCapSql);
  await patchLayer(page, layerId, {
    style: {
      fill: {
        type: "constant",
        color: { r: 245, g: 45, b: 105, a: 1 },
      },
      fillOpacity: 1,
      stroke: { r: 245, g: 45, b: 105, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 7,
      opacity: 1,
    },
  });
  await patchMap(page, mapId, {
    viewport: {
      lng: 13.428,
      lat: 52.532,
      zoom: 12.5,
      pitch: 0,
      bearing: 0,
    },
  });

  await test.step("the builder shows the tiled progression for the over-cap layer", async () => {
    await page.goto(`/maps/${mapId}`);
    const row = page.getByRole("button", { name: new RegExp(`^${layerName}`) });
    await expect(row).toContainText(/preparing tiles|tiled/, {
      timeout: 30_000,
    });
    await expect(row).toContainText("tiled", { timeout: 60_000 });
    await saveSettled(page);
    const deck = page.locator("canvas#deckgl-overlay");
    await expect(deck).toBeVisible();
    await expect
      .poll(
        async () =>
          (await markStats(page, await deck.screenshot())).share,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0.0001);
  });

  let token = "";
  await test.step("the published viewer renders from tiles under its own token", async () => {
    token = await publishMap(page, mapId);
    const view = await readPublished<{
      layers: { id: string; render: { ok: boolean; mode?: string } }[];
    }>(page, token);
    const layer = view.layers.find((l) => l.id === layerId)!;
    expect(layer.render.ok).toBe(true);
    expect(layer.render.mode).toBe("tiled");

    await page.goto(`/v/${token}`);
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    const deck = page.locator("canvas#deckgl-overlay");
    await expect(deck).toBeVisible();
    await expect
      .poll(
        async () =>
          (await markStats(page, await deck.screenshot())).share,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0.0001);
    // The published tile endpoint serves real archive bytes under the
    // reader's token (z0 always exists in a tippecanoe archive) — the
    // road truth, independent of when the GL layer schedules fetches.
    const tile = await page.evaluate(
      async ({ token, id }) => {
        const r = await fetch(`/api/published/${token}/tiles/${id}/0/0/0`);
        return { status: r.status, bytes: (await r.arrayBuffer()).byteLength };
      },
      { token, id: layerId },
    );
    expect(tile.status).toBe(200);
    expect(tile.bytes).toBeGreaterThan(0);

    const workerUrls = parserWorkerRequests.map((url) => new URL(url));
    expect(workerUrls.length).toBeGreaterThan(0);
    expect(
      workerUrls.every(
        (url) =>
          url.origin === new URL(page.url()).origin &&
          url.pathname === MVT_WORKER_URL,
      ),
    ).toBe(true);
    expect(workerUrls.some((url) => url.hostname === "unpkg.com")).toBe(false);
  });

  await test.step("the private server image road paints the tiled data without public worker egress", async () => {
    const exported = await page.evaluate(
      async ({ mapId }) => {
        const response = await fetch(`/api/maps/${mapId}/export/image`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            definition: {
              viewport: {
                lng: 13.428,
                lat: 52.532,
                zoom: 12.5,
                pitch: 0,
                bearing: 0,
              },
              size: { width: 640, height: 360 },
              legend: { visible: false, corner: "bottom-left", size: "m" },
              widgets: [],
              title: null,
              appearance: "light",
              overlayScale: 1,
            },
          }),
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return {
          status: response.status,
          body: response.ok ? btoa(binary) : new TextDecoder().decode(bytes),
        };
      },
      { mapId },
    );
    expect(exported.status, exported.body).toBe(200);
    const stats = await markStats(page, Buffer.from(exported.body, "base64"));
    expect(stats.share).toBeGreaterThan(0.0001);
  });

  await test.step("tiler_unavailable: the viewer presents its specific documented prose (viewer-boundary drive)", async () => {
    // The documented envelope shape for the code, served at the viewer
    // boundary — labeled as such: the wire substitution for this class
    // is-held; what this drives is the viewer's SPECIFIC presentation
    // for the code. A FRESH page carries the drive so the live tiled
    // viewer above is never navigated mid-stream (deck's aborted tile
    // fetches would shadow the console).
    const page2 = await context.newPage();
    const page2Errors = trackConsole(page2);
    await page2.route(
      new RegExp(`/api/published/${token}$`),
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as {
          layers: { id: string; render: Record<string, unknown> }[];
        };
        for (const layer of body.layers) {
          if (layer.id === layerId) {
            layer.render = {
              layerId,
              ok: false,
              error: {
                code: "tiler_unavailable",
                message: TILER_UNAVAILABLE_SENTENCE,
              },
            };
          }
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      },
    );
    await page2.goto(`/v/${token}`);
    const failed = page2.locator(`[data-layer-failed="${layerId}"]`);
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await expect(failed).toContainText(TILER_UNAVAILABLE_SENTENCE);
    const unexpected2 = page2Errors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected2).toEqual([]);
    await page2.close();
  });

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("tile_build_failed: a REAL failed build crosses the published wire (gated on the data directory)", async ({
  page,
  context,
}) => {
  // Its own test so the gate skips VISIBLY without dragging the
  // unconditional tiler_unavailable drive down with it. Seeds its own
  // over-cap published map.
  test.skip(
    !DATA_DIR,
    "DEZFIL_DATA_DIR not configured for the run — the real failed-build " +
      "drive stages the server's tiles directory. Skipping VISIBLY.",
  );
  test.setTimeout(300_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  const bigTable = `plcfail_${runId}`;
  await seedCsv(page, bigTable, csv);
  const mapId = await createMap(page, "tiled failure lifecycle");
  const overCapSql = `SELECT
      ST_Point(
        ST_X(p.geometry) + (r.i % 60) * 0.0005,
        ST_Y(p.geometry) + floor(r.i / 60) * 0.0005
      ) AS geometry
    FROM (SELECT geometry FROM ${bigTable} LIMIT 1) AS p
    CROSS JOIN range(0, 2401) AS r(i)`;
  const doomedName = `${bigTable} doomed`;
  let doomedId = "";
  const token = await publishMap(page, mapId);

  await test.step("a first build against an unwritable tiles directory fails onto the wire as documented copy", async () => {
    const tilesDir = path.join(DATA_DIR!, "tiles");
    chmodSync(tilesDir, 0o555);
    try {
      // A layer whose FIRST archive build runs against the unwritable
      // directory: an existing archive would keep serving behind readers
      // (the retire-behind-readers semantics), so the honest way to
      // surface the failure on the wire is a build with no prior archive
      // to fall back on. Publishing is a live reference — the new layer
      // joins the published map immediately.
      doomedId = await page.evaluate(
        async ({ mapId, sql, name }) => {
          const r = await (async function readThenWriteSetup() {
const read = await fetch(`/api/maps/${mapId}`, { cache: "no-store" });
if (!read.ok) throw new Error(await read.text());
const shown = await read.json();
return fetch(`/api/maps/${mapId}/layers`, {
            method: "POST",
            headers: { "X-Edit-Revision": shown.editRevision, "content-type": "application/json" },
            body: JSON.stringify({ name, sql }),
          });
})();
          if (!r.ok) throw new Error(await r.text());
          return ((await r.json()) as { id: string }).id;
        },
        {
          mapId,
          sql: `${overCapSql}\n-- doomed ${runId}`,
          name: doomedName,
        },
      );
      type Envelope = {
        ok: boolean;
        error?: { code: string; message: string };
      };
      const readEnvelope = () =>
        page.evaluate(
          async ({ token, id }) => {
            const r = await fetch(`/api/published/${token}`, {
              cache: "no-store",
            });
            const body = (await r.json()) as {
              layers: { id: string; render: Envelope }[];
            };
            return body.layers.find((l) => l.id === id)!.render;
          },
          { token, id: doomedId },
        ) as Promise<Envelope>;
      await expect
        .poll(async () => (await readEnvelope()).ok, { timeout: 60_000 })
        .toBe(false);
      const envelope = await readEnvelope();
      expect(envelope.error?.code).toBe("tile_build_failed");
      // Exactly the documented sentence — never tippecanoe's own text.
      expect(envelope.error?.message).toBe(TILE_BUILD_FAILED_SENTENCE);

      // The reader's presentation: the failed layer is a visible state
      // with the documented prose, never a silent absence.
      await page.goto(`/v/${token}`);
      const failed = page.locator(`[data-layer-failed="${doomedId}"]`);
      await expect(failed).toBeVisible({ timeout: 30_000 });
      await expect(failed).toContainText(`“${doomedName}” unavailable`);
      await expect(failed).toContainText(TILE_BUILD_FAILED_SENTENCE);
    } finally {
      chmodSync(tilesDir, 0o755);
    }
  });

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});
