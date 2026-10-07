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
//   they show is the tolerance every later comparison is held to.
// - Each pick off the default, set alone through the documented
//   own-settings write, and then all of them together: the download
//   equals the default one, and the nodes the download rasterizes keep
//   the computed styles they have under the default look, while the
//   card's options take the person's.
// - The red: the person's Color leaked into the composition's scope by an
//   injected style fails the same comparison that holds for that Color.
// - The render route's document carries no look.
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
import { routeHouse, trackConsole } from "./support";

type Look = Record<string, string>;
const DEFAULTS: Look = { color: "kelp", contrast: "standard", font: "inter", background: "atlantic", corners: "rounded", rail: "hover" };
/** Each pick off the default; together, the look compared last. */
const PICKS: [string, string][] = [["color", "heather"], ["contrast", "more"], ["font", "system"], ["background", "graticule"], ["corners", "soft"], ["rail", "icons"]];
const LOOK: Look = Object.fromEntries(PICKS);
/** Heather's accent, light, as a token and as paint; Kelp's as the default scope restates it. */
const HEATHER_ACCENT = "#6b4cad";
const HEATHER_PAINT = "rgb(107, 76, 173)";
const KELP_ACCENT = "#0d7d5c";

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
    const roots = Array.from(frame.querySelectorAll<HTMLElement>("[data-look-default]"));
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
        within = repeat.bytesEqual
          ? (c) => c.bytesEqual
          : (c) => c.sameSize && c.differing <= repeat.differing && c.maxDelta <= repeat.maxDelta;
        expect(within(repeat)).toBe(true);
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
      });

      for (const err of errors) expect(isAllowedConsoleError(err.text, err.url), `${err.text} (${err.url ?? "no url"})`).toBe(true);

      await test.step("the render route's document carries no look", async () => {
        await setLook(person.api, LOOK);
        const served = await person.api.get(`/render/${mapId}`);
        expect(served.status()).toBe(200);
        expect(servedLookProblems(await served.text(), {})).toEqual([]);
        // Opened bare, with no image definition: only its document's root
        // is read here; the route's own rendering is the server journey's.
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
