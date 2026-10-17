// Taking a scene: the browser, the frame, settling and the still. Every
// picture is taken in the same frame (1440 by 900 CSS pixels, light theme,
// two pixels per CSS pixel, reduced motion, a fixed clock) so a picture
// changes only when what it shows changes.
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { FRAME, webpSize } from "./docs-media.mjs";

/** The browser clock every scene reads, so no date drifts between runs. */
export const FIXED_TIME = new Date("2026-06-01T09:00:00Z");

/** WebP settings for every picture: one setting for all, so a size is
 * comparable across scenes. */
const WEBP = { quality: 82, effort: 6, smartSubsample: true };

export function openBrowser() {
  return chromium.launch({ args: ["--force-color-profile=srgb"] });
}

/**
 * A browser context in the frame, for one instance state. Every request the
 * page makes off the instance's own origin is refused and written down, so a
 * picture never depends on a host outside the run.
 */
export async function frameContext(browser, base, { cookie } = {}) {
  const context = await browser.newContext({
    baseURL: base,
    viewport: { width: FRAME.width, height: FRAME.height },
    deviceScaleFactor: FRAME.scale,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  const foreign = [];
  const origin = new URL(base).origin;
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (new URL(url).origin === origin) return route.continue();
    foreign.push(url);
    return route.abort();
  });
  if (cookie) {
    const [name, ...value] = cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: origin }]);
  }
  await context.clock.setFixedTime(FIXED_TIME);
  return { context, foreign };
}

/** Wait until nothing on the page is still arriving or drawing: the
 * network idle, the fonts loaded, every picture decoded, two frames drawn. */
export async function settle(page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => (image.complete ? null : image.decode().catch(() => null))));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/** A scene's declared crop as a rectangle of whole CSS pixels inside the
 * frame: the element's box with the declared margin around it. */
export async function cropRectangle(page, crop) {
  const box = await page.locator(crop.selector).first().boundingBox();
  if (!box) throw new Error(`The crop's element ${crop.selector} is not on the page.`);
  const margin = crop.margin ?? 0;
  const x = Math.max(0, Math.floor(box.x - margin));
  const y = Math.max(0, Math.floor(box.y - margin));
  const right = Math.min(FRAME.width, Math.ceil(box.x + box.width + margin));
  const bottom = Math.min(FRAME.height, Math.ceil(box.y + box.height + margin));
  return { x, y, width: right - x, height: bottom - y };
}

/** The frame, or the rectangle, as PNG at two pixels per CSS pixel. */
export function framePng(page, rectangle) {
  return page.screenshot({ type: "png", animations: "disabled", caret: "hide", scale: "device", ...(rectangle ? { clip: rectangle } : {}) });
}

/** A PNG frame as the WebP file the documentation keeps, with its size read
 * back from the file's own header. */
export async function toWebp(png) {
  const bytes = await sharp(png).webp(WEBP).toBuffer();
  return { bytes, ...webpSize(bytes) };
}

/** Take a still scene on an opened, settled page. */
export async function takeStill(page, scene) {
  const crop = scene.crop ? await cropRectangle(page, scene.crop) : null;
  const picture = await toWebp(await framePng(page, crop));
  return [{ scene: scene.id, kind: "picture", file: scene.file, crop, ...picture }];
}
