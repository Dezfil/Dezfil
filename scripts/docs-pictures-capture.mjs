// Taking a scene: the browser, the frame, settling and the still. Every
// picture is taken in the same frame (1440 by 900 CSS pixels, light theme,
// two pixels per CSS pixel, reduced motion, a fixed clock) so a picture
// changes only when what it shows changes.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { FRAME, RECORDING_MAX_SECONDS, webmInfo, webpSize } from "./docs-media.mjs";

/** The browser clock every scene reads, so no date drifts between runs. */
export const FIXED_TIME = new Date("2026-06-01T09:00:00Z");

/** WebP settings for every picture: one setting for all, so a size is
 * comparable across scenes. */
const WEBP = { quality: 82, effort: 6, smartSubsample: true };

/** A recording's cadence: frames per second of scene time. A step is held
 * for a whole number of frames, so a recording's length is its frame count
 * over the cadence, never the time the run took. */
export const CADENCE = 10;
export const MAX_FRAMES = RECORDING_MAX_SECONDS * CADENCE;

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

// ---------------------------------------------------------------------------
// Recordings

/** The ffmpeg Playwright bundles for its own recorder, installed with its
 * browsers (`npx playwright install chromium ffmpeg`). No other encoder is
 * used, so the bytes do not depend on what the machine has installed. */
export function bundledFfmpeg() {
  const { registry } = createRequire(import.meta.url)("playwright-core/lib/coreBundle").registry;
  const file = registry.findExecutable("ffmpeg")?.executablePath();
  if (!file || !existsSync(file)) throw new Error("Playwright's ffmpeg is not installed: run npx playwright install ffmpeg.");
  return file;
}

/**
 * Encode frames (PNG, all one size) as a muted WebM loop, VP8 through the
 * bundled ffmpeg, which reads JPEG frames alone. The settings are fixed and
 * single-threaded, and no clock, version or random identifier is written,
 * so the bytes are a function of the frames: the same frames give the same
 * file.
 */
export async function encodeWebm(frames, output) {
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(CADENCE), "-i", "pipe:0",
    "-an", "-c:v", "libvpx", "-threads", "1", "-deadline", "good", "-cpu-used", "0",
    "-crf", "10", "-b:v", "2M", "-auto-alt-ref", "0", "-g", String(MAX_FRAMES), "-pix_fmt", "yuv420p",
    "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
    "-f", "webm", output,
  ];
  const child = spawn(bundledFfmpeg(), args, { stdio: ["pipe", "ignore", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const jpegs = new Map();
  for (const frame of frames) {
    if (!jpegs.has(frame)) jpegs.set(frame, await sharp(frame).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer());
    if (!child.stdin.write(jpegs.get(frame))) await once(child.stdin, "drain");
  }
  child.stdin.end();
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`ffmpeg failed: ${errors.trim()}`);
  return readFile(output);
}

/**
 * Take a recording scene on an opened, settled page: the first frame, then
 * each step done, the page settled and the frame held for the step's
 * number of frames. The poster is the first frame as a picture. The file's
 * size and length are read back from its header and must be the frame's
 * (or the crop's) at two pixels per CSS pixel and the frame count over the
 * cadence.
 */
export async function takeRecording(page, scene, output) {
  const crop = scene.crop ? await cropRectangle(page, scene.crop) : null;
  const frames = [];
  for (const step of scene.steps) {
    if (step.act) {
      await step.act(page);
      await settle(page);
    }
    const frame = await framePng(page, crop);
    for (let i = 0; i < step.hold; i += 1) frames.push(frame);
  }
  if (frames.length > MAX_FRAMES) throw new Error(`${scene.id}: ${frames.length} frames is over ${RECORDING_MAX_SECONDS} seconds at ${CADENCE} a second; hold its steps for fewer frames.`);
  const bytes = await encodeWebm(frames, output);
  const info = webmInfo(bytes);
  const width = (crop?.width ?? FRAME.width) * FRAME.scale, height = (crop?.height ?? FRAME.height) * FRAME.scale;
  const length = frames.length / CADENCE;
  if (!info || info.width !== width || info.height !== height || info.length !== length) {
    throw new Error(`${scene.id}: the recording reads as ${JSON.stringify(info)}, not ${width} × ${height} for ${length} s.`);
  }
  const poster = await toWebp(frames[0]);
  return [
    { scene: scene.id, kind: "recording", file: scene.file, crop, bytes, width, height, length, poster: scene.poster },
    { scene: scene.id, kind: "picture", file: scene.poster, crop, ...poster },
  ];
}
