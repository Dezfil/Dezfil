// An image keeps Dezfil's default look whatever the person picked. The
// export journey's fixture (its twelve stations in kelp and amber, its
// histogram widget, the legend) is downloaded from the builder's export
// card by one invited account, so the suite's fixture account keeps the
// default look for every other journey. The house route policy keeps the
// basemap off the network, so no download waits on a public tile host.
//
// - The map state is the builder's framing: it frames the data on every
//   open and sends the camera to be kept once it rests, and every image
//   is made after that send, with the camera at rest.
// - Repeatability first: two downloads under the default look, each from
//   a fresh load of the builder and a fresh card, are compared by bytes;
//   if the browser does not repeat byte for byte, the pixel difference
//   they show is the tolerance every later comparison is held to, and it
//   must itself stay within a small fixed ceiling.
// - Each pick off the default, set alone through the documented
//   own-settings write, and then all of them together: the download
//   equals the default one, and the nodes the download rasterizes keep
//   the computed styles they have under the default look, while the
//   card's options take the person's.
// - The red: the person's Color leaked into the composition's scope by an
//   injected style fails the same comparison that holds for that Color.
//   So does a shadow typed by hand on the composition's legend under the
//   default look: the legend draws its overlay panel role's shadow, and a
//   value of its own in its place is caught by the comparison with the
//   clean download.
// - The server's own image: rendered through the API under the person's
//   look, it is the image rendered under the default look, by bytes or
//   within the same ceiling; a render whose definition differs fails the
//   same comparison. The render route's document carries no look. The
//   server renders with its own browser (DEZFIL_CHROMIUM_PATH) over a
//   loopback basemap, so no image waits on a public tile host.
//
// The Side menu's Always open is not among the picks compared: the
// builder frames the data for its stage on every open, and the rail
// standing open narrows the stage, so the map's camera is a different
// one. Icons only keeps the stage, so it stands for the Side menu here.
//
// Every comparison is a soft assertion, so one pick that reaches the
// image does not hide what the others do.
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { readFileSync } from "node:fs";
import { test, expect, type Page, type Request } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { openBuilder, openCard, seed } from "./export-fixture";
import { rootLook, servedLookProblems, setLook } from "./look-evidence";
import { pngDifference, type PixelDifference } from "./png-probes";
import { closeAll, invitePerson, runTag, type Person } from "./sharing-support";
import { patchMap, routeHouse, trackConsole } from "./support";
import { startLoopbackBasemap } from "../scripts/loopback-basemap.mjs";

type Look = Record<string, string>;
const DEFAULTS: Look = { color: "kelp", contrast: "standard", font: "inter", background: "atlantic", corners: "rounded", rail: "hover" };
/** Each pick off the default; together, the look compared last. */
const PICKS: [string, string][] = [["color", "heather"], ["contrast", "more"], ["font", "system"], ["background", "graticule"], ["corners", "soft"], ["rail", "icons"]];
const LOOK: Look = Object.fromEntries(PICKS);
/** Heather's accent, light, as a token and as paint; Kelp's as the default scope restates it. */
const HEATHER_ACCENT = "#6b4cad";
const HEATHER_PAINT = "rgb(107, 76, 173)";
const KELP_ACCENT = "#0d7d5c";
/** A shadow a member could type for itself in place of its role's, darker
 * than the overlay panel's step so the image cannot miss it; the second
 * form is how the browser computes it. */
const TYPED_LEGEND_SHADOW = "0 4px 14px rgba(0, 0, 0, 0.5)";
const TYPED_LEGEND_SHADOW_COMPUTED = "rgba(0, 0, 0, 0.5) 0px 4px 14px 0px";

const attrs = (look: Look) => Object.fromEntries(Object.entries(look)
  .filter(([key, value]) => DEFAULTS[key] !== value)
  .map(([key, value]) => [`data-look-${key}`, value])
  .sort(([a], [b]) => a.localeCompare(b)));

/** The builder frames the data on every open and, once the camera comes
 * to rest, sends the framed camera to be kept: an open is settled once
 * that write has been sent and no other has followed for a second. Every
 * image here is made from a settled open, so its camera is the framing
 * and never a moment of it. */
async function openSettled(page: Page, mapId: string): Promise<void> {
  const writes: number[] = [];
  const onWrite = (r: Request) => {
    if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/maps/${mapId}` && (r.postData() ?? "").includes('"viewport"')) writes.push(Date.now());
  };
  page.on("request", onWrite);
  try {
    await openBuilder(page, mapId);
    await expect.poll(() => writes.length, { timeout: 15_000, message: "the builder's framing sent its camera" }).toBeGreaterThan(0);
    await expect.poll(() => Date.now() - writes[writes.length - 1], { timeout: 15_000, message: "the camera stayed at rest" }).toBeGreaterThan(1_000);
  } finally {
    page.off("request", onWrite);
  }
}

/** One download from a settled open of the builder and a fresh card, with
 * the fonts ready: the procedure every image here is made by. `inCard`
 * runs with the card open, before the download. */
async function download(page: Page, mapId: string, inCard?: () => Promise<void>): Promise<Buffer> {
  await openSettled(page, mapId);
  await openCard(page);
  await page.evaluate(async () => { await document.fonts.ready; });
  await inCard?.();
  const [file] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.locator("[data-export-download]").click(),
  ]);
  expect(file.suggestedFilename()).toBe("Export flow.png");
  return readFileSync(await file.path());
}

/** One element of the nodes the download rasterizes, as the browser
 * computed it. */
interface Styled { element: string; styles: Record<string, string> }

/** The computed styles of every element in the nodes the download
 * rasterizes (the chrome layer and the standalone legend), inherited ones
 * included: what a pick would have to change to reach the image through
 * the DOM, now or through the next element that inherits it. */
function rasterizedStyles(page: Page): Promise<Styled[]> {
  return page.evaluate(() => {
    const frame = document.querySelector("[data-export-card] [data-export-composition]")!;
    // The two rasterized nodes each carry the default scope inside the
    // composition's own: the chrome layer and the standalone legend's scale.
    const roots = Array.from(frame.querySelectorAll<HTMLElement>("[data-look-default] [data-look-default]"));
    const props = ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "background-color",
      "border-top-color", "border-top-width", "border-top-left-radius", "box-shadow", "fill", "stroke", "opacity"];
    return roots.flatMap((root) => [root, ...Array.from(root.querySelectorAll<Element>("*"))]).map((el) => {
      const cs = getComputedStyle(el);
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent!.trim()).join(" ").slice(0, 24);
      return { element: `${el.tagName.toLowerCase()}${own ? ` "${own}"` : ""}`, styles: Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])) };
    });
  });
}

/** Every computed style that differs from the default look's, one line
 * per element and property. */
function differences(base: Styled[], other: Styled[]): string[] {
  if (base.length !== other.length) return [`${base.length} elements under the default look, ${other.length} now`];
  return other.flatMap((el, i) => Object.entries(el.styles)
    .filter(([prop, value]) => base[i].styles[prop] !== value)
    .map(([prop, value]) => `${el.element} ${prop}: ${base[i].styles[prop]} -> ${value}`));
}

interface Comparison extends PixelDifference { bytesEqual: boolean }

async function compare(page: Page, a: Buffer, b: Buffer): Promise<Comparison> {
  return { bytesEqual: a.equals(b), ...(await pngDifference(page, a, b)) };
}

const line = (c: Comparison) => `bytes equal: ${c.bytesEqual}, pixels differing: ${c.differing}, largest channel difference: ${c.maxDelta}`;

/** The most one image may differ from itself and still count as the same:
 * a few anti-aliased pixels by a few levels, never a change an eye sees.
 * Fixed, so a browser that stops repeating fails rather than widening it. */
const REPEAT_CEILING = { differing: 100, maxDelta: 4 };
const withinCeiling = (c: Comparison) =>
  c.bytesEqual || (c.sameSize && c.differing <= REPEAT_CEILING.differing && c.maxDelta <= REPEAT_CEILING.maxDelta);

/** The server's image of the fixture: the export journey's framing at 960 x 540. */
const SERVER_DEFINITION = {
  viewport: { lng: 13.37, lat: 52.5, zoom: 10.5, pitch: 0, bearing: 0 },
  size: { width: 960, height: 540 },
  legend: { visible: true, corner: "bottom-left", size: "m" },
  widgets: ["w-hist"],
  title: { text: "Server render", size: "m" },
  appearance: "light",
  overlayScale: 2,
};

test.describe("an image keeps Dezfil's default look", () => {
  test("a download under the person's look is the default download; a leaked pick is caught", async ({ browser, request, baseURL }) => {
    const people: Person[] = [];
    try {
      const person = await invitePerson(browser, request, baseURL!, "Exporter", runTag());
      people.push(person);
      await routeHouse(person.context);
      const page = await person.context.newPage();
      const errors = trackConsole(page);
      const { mapId } = await seed(page);

      let reference: Buffer = Buffer.alloc(0);
      let defaultStyles: Styled[] = [];
      /** Held to bytes when the browser repeats byte for byte, else to the
       * pixel difference the repeat showed. */
      let within: (c: Comparison) => boolean = () => false;

      await test.step("two downloads under the default look establish what repeats", async () => {
        expect(await rootLook(page)).toEqual({});
        reference = await download(page, mapId, async () => { defaultStyles = await rasterizedStyles(page); });
        const again = await download(page, mapId);
        const repeat = await compare(page, reference, again);
        console.log(`[repeatability] ${reference.length} and ${again.length} bytes, ${repeat.width} x ${repeat.height}, ${line(repeat)}`);
        await test.info().attach("repeatability", { body: JSON.stringify(repeat, null, 2), contentType: "application/json" });
        expect(repeat.sameSize).toBe(true);
        expect(reference.readUInt32BE(16)).toBe(1920);
        expect(defaultStyles.length).toBeGreaterThan(10);
        // What the browser repeats is held to the fixed ceiling, never to itself.
        expect(withinCeiling(repeat), `two downloads of one image (${line(repeat)})`).toBe(true);
        within = repeat.bytesEqual
          ? (c) => c.bytesEqual
          : (c) => c.sameSize && c.differing <= repeat.differing && c.maxDelta <= repeat.maxDelta;
      });

      const underLook = async (label: string, look: Look) => {
        await setLook(person.api, { ...DEFAULTS, ...look });
        let styles: Styled[] = [];
        let options = { accent: "", paint: "", font: "", radius: "" };
        const image = await download(page, mapId, async () => {
          expect(await rootLook(page), label).toEqual(attrs(look));
          styles = await rasterizedStyles(page);
          options = await page.locator("[data-export-card] [data-export-download]").evaluate((el) => {
            const cs = getComputedStyle(el);
            return { accent: cs.getPropertyValue("--accent").trim(), paint: cs.backgroundColor, font: cs.fontFamily, radius: cs.getPropertyValue("--radius-card").trim() };
          });
          expect(await page.locator("[data-export-card] [data-export-composition] [data-look-default]").first()
            .evaluate((el) => getComputedStyle(el).getPropertyValue("--accent").trim()), `${label}: the preview's accent`).toBe(KELP_ACCENT);
        });
        const result = await compare(page, reference, image);
        console.log(`[look] ${label}: ${line(result)}`);
        await test.info().attach(`download under ${label}`, { body: JSON.stringify(result, null, 2), contentType: "application/json" });
        const changed = differences(defaultStyles, styles);
        if (changed.length > 0) console.log(`[look] ${label}: ${changed.length} rasterized styles follow the look:\n  ${[...new Set(changed)].join("\n  ")}`);
        expect.soft(changed, `${label}: the rasterized nodes keep the default look's computed styles`).toEqual([]);
        expect.soft(within(result), `${label}: the download equals the default download (${line(result)})`).toBe(true);
        return options;
      };

      await test.step("each pick alone: the download and the rasterized nodes stay at the default", async () => {
        for (const [key, value] of PICKS) await underLook(`${key} ${value}`, { [key]: value });
      });

      await test.step("every pick together: the download stays at the default while the card's options take the look", async () => {
        const options = await underLook("every pick", LOOK);
        console.log(`[options] ${JSON.stringify(options)}`);
        expect(options.accent).toBe(HEATHER_ACCENT);
        expect(options.paint).toBe(HEATHER_PAINT);
        expect(options.radius).toBe("14px");
        expect(options.font).toContain("system-ui");
      });

      await test.step("the red: the person's Color leaked into the composition's scope fails the comparison that holds for it", async () => {
        await setLook(person.api, { ...DEFAULTS, color: "heather" });
        const leaked = await download(page, mapId, async () => {
          await page.addStyleTag({ content: "[data-look-default] { --accent: inherit !important; }" });
          await expect.poll(() => page.locator("[data-export-card] [data-export-composition] [data-look-default]").first()
            .evaluate((el) => getComputedStyle(el).getPropertyValue("--accent").trim())).toBe(HEATHER_ACCENT);
        });
        const result = await compare(page, reference, leaked);
        console.log(`[leak] color heather, accent leaked into the scope: ${line(result)}`);
        await test.info().attach("leaked Color", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
        expect(within(result)).toBe(false);
        expect(withinCeiling(result), "the ceiling does not cover a leaked pick").toBe(false);
      });

      await test.step("the red: a shadow typed by hand on the composition's legend fails the comparison that holds for the default look", async () => {
        await setLook(person.api, DEFAULTS);
        const typed = await download(page, mapId, async () => {
          expect(await rootLook(page)).toEqual({});
          await page.addStyleTag({ content: `[data-export-composition] [data-map-legend] { box-shadow: ${TYPED_LEGEND_SHADOW} !important; }` });
          await expect.poll(() => page.locator("[data-export-card] [data-export-composition] [data-map-legend]").filter({ visible: true }).first()
            .evaluate((el) => getComputedStyle(el).boxShadow)).toBe(TYPED_LEGEND_SHADOW_COMPUTED);
        });
        const result = await compare(page, reference, typed);
        console.log(`[typed] the composition's legend on a hand-typed shadow (${TYPED_LEGEND_SHADOW}): ${line(result)}`);
        await test.info().attach("typed legend shadow", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
        expect(within(result)).toBe(false);
        expect(withinCeiling(result), "the ceiling does not cover a typed shadow").toBe(false);
      });

      for (const err of errors) expect(isAllowedConsoleError(err.text, err.url), `${err.text} (${err.url ?? "no url"})`).toBe(true);

      await test.step("the server's own image under the person's look is its image under the default look", async () => {
        const basemap = await startLoopbackBasemap();
        try {
          await patchMap(page, mapId, { customBasemap: { url: basemap.styleUrl, name: "Export fixture", force: true } });
          const serverImage = async (label: string, definition: Record<string, unknown>) => {
            const response = await person.api.post(`/api/maps/${mapId}/export/image`, { data: { definition }, timeout: 120_000 });
            expect(response.status(), `${label}: ${response.status() === 200 ? "" : await response.text()}`).toBe(200);
            expect(response.headers()["content-type"], label).toBe("image/png");
            return response.body();
          };
          await setLook(person.api, DEFAULTS);
          const plain = await serverImage("the default look", SERVER_DEFINITION);
          await setLook(person.api, LOOK);
          const picked = await serverImage("every pick", SERVER_DEFINITION);
          expect([plain.readUInt32BE(16), plain.readUInt32BE(20)]).toEqual([960, 540]);
          const result = await compare(page, plain, picked);
          console.log(`[server] every pick against the default look: ${line(result)}`);
          await test.info().attach("server image under every pick", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
          expect(withinCeiling(result), `the server's image under every pick (${line(result)})`).toBe(true);
          // The same comparison fails over an image that is not the same one.
          const retitled = await serverImage("another title", { ...SERVER_DEFINITION, title: { text: "Another render", size: "m" } });
          const other = await compare(page, plain, retitled);
          console.log(`[server] another title against the default look: ${line(other)}`);
          expect(withinCeiling(other), "a different image fails the comparison").toBe(false);
        } finally {
          await basemap.close();
        }
      });

      await test.step("the render route's document carries no look", async () => {
        const served = await person.api.get(`/render/${mapId}`);
        expect(served.status()).toBe(200);
        expect(servedLookProblems(await served.text(), {})).toEqual([]);
        const bare = await person.context.newPage();
        await bare.goto(`/render/${mapId}`);
        expect(await rootLook(bare)).toEqual({});
        await bare.close();
      });
      await setLook(person.api, DEFAULTS);
    } finally {
      await closeAll(people);
    }
  });
});
