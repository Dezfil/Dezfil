// The picture script's parts that need no browser: the manifest it writes
// (a file replaced only when its bytes changed, a row's version and date
// moving only with its file), its scene list and the names of a scene's two
// takes, the theme a take's browser starts in, the WebP header it reads back
// and the catalogue folder it serves the Templates page from.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: plain-JS scripts, no declaration files on purpose.
import { FRAME, RECORDING_MAX_SECONDS, THEMES, darkTake, isDarkTake, lightTake, takeFile, takeTheme, webmInfo, webpSize } from "../../scripts/docs-media.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: as above.
import { CADENCE, THEME_STORAGE_KEY, bundledFfmpeg, encodeWebm, themeStorage } from "../../scripts/docs-pictures-capture.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: as above.
import { manifestText, planRun } from "../../scripts/docs-pictures-manifest.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: as above.
import { SCENES, STATES } from "../../scripts/docs-pictures-scenes.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: as above.
import { freePort, makeScratch, startServer, writeCatalogue } from "../../scripts/docs-pictures-instance.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: as above.
import { placeOf } from "../../scripts/docs-contract.mjs";
import { parseIndex } from "@/lib/templates/catalogue";
import { webm } from "../../test-support/media-fixtures";

type Row = Record<string, unknown> & { file: string; scene: string };
type Scene = { id: string; file: string; kind: string; state: string; pages: string[]; map?: boolean; crop?: { selector: string; margin?: number }; poster?: string; steps?: { hold: number }[] };
const scenes = SCENES as Scene[];

const scratch = mkdtempSync(join(tmpdir(), "dezfil-docs-pictures-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const bytes = (text: string) => Buffer.from(text);
const item = (scene: string, file: string, content: string, extra: Record<string, unknown> = {}) =>
  ({ scene, kind: "picture", theme: file.includes(".dark.") ? "dark" : "light", file, bytes: bytes(content), width: 10, height: 20, ...extra });
const listed = [{ id: "one" }, { id: "two" }, { id: "three" }];
const earlier = { version: "0.0.9", date: "2026-01-02" };
const now = { version: "0.1.0", date: "2026-10-17" };

describe("the manifest the picture script writes", () => {
  const before = {
    rows: [
      { file: "use/one.webp", scene: "one", kind: "picture", theme: "light", ...earlier, width: 10, height: 20, bytes: 3 },
      { file: "use/two.webp", scene: "two", kind: "picture", theme: "light", ...earlier, width: 10, height: 20, bytes: 3 },
    ],
  };
  const disk: Record<string, Buffer> = { "use/one.webp": bytes("one"), "use/two.webp": bytes("two") };
  const current = (file: string) => disk[file] ?? null;

  it("changes no file and no row when every picture came out the same", () => {
    const plan = planRun({ manifest: before, captured: [item("one", "use/one.webp", "one"), item("two", "use/two.webp", "two")], current, scenes: listed, ...now });
    expect(plan.writes).toEqual([]);
    expect(plan.removes).toEqual([]);
    expect(manifestText(plan.manifest)).toBe(manifestText(before));
  });

  it("replaces only the file whose bytes changed, and moves only its row's version and date", () => {
    const plan = planRun({ manifest: before, captured: [item("one", "use/one.webp", "one, relabelled"), item("two", "use/two.webp", "two")], current, scenes: listed, ...now });
    expect(plan.writes.map((w: { file: string }) => w.file)).toEqual(["use/one.webp"]);
    expect(plan.manifest.rows).toEqual([
      { file: "use/one.webp", scene: "one", kind: "picture", theme: "light", ...now, width: 10, height: 20, bytes: 15 },
      before.rows[1],
    ]);
  });

  it("writes a scene's dark take as a row of its own with its theme, beside the light take's", () => {
    const plan = planRun({
      manifest: before,
      captured: [item("one", "use/one.webp", "one"), item("one", "use/one.dark.webp", "one, dark"), item("two", "use/two.webp", "two")],
      current, scenes: listed, ...now,
    });
    expect(plan.writes.map((w: { file: string }) => w.file)).toEqual(["use/one.dark.webp"]);
    expect(plan.manifest.rows.map((row: Row) => [row.file, row.theme, row.version])).toEqual([
      ["use/one.dark.webp", "dark", now.version],
      ["use/one.webp", "light", earlier.version],
      ["use/two.webp", "light", earlier.version],
    ]);
  });

  it("writes a new file with today's version and date, rows in file order, crop and recording fields last", () => {
    const plan = planRun({
      manifest: null,
      captured: [
        item("two", "start/two.webm", "loop", { kind: "recording", length: 4.2, poster: "start/two-poster.webp" }),
        item("one", "use/one.webp", "crop", { crop: { x: 1, y: 2, width: 5, height: 10 } }),
      ],
      current: () => null, scenes: listed, ...now,
    });
    expect(plan.writes).toHaveLength(2);
    expect(plan.manifest.rows.map((row: Row) => Object.keys(row))).toEqual([
      ["file", "scene", "kind", "theme", "version", "date", "width", "height", "bytes", "length", "poster"],
      ["file", "scene", "kind", "theme", "version", "date", "width", "height", "bytes", "crop"],
    ]);
  });

  it("removes the file and row of a scene that left the list, and of a file a scene no longer makes", () => {
    const plan = planRun({ manifest: before, captured: [item("one", "use/one-renamed.webp", "one")], current, scenes: [{ id: "one" }], ...now });
    expect(plan.removes).toEqual(["use/one.webp", "use/two.webp"]);
    expect(plan.manifest.rows.map((row: Row) => row.file)).toEqual(["use/one-renamed.webp"]);
  });

  it("keeps a file a renamed scene still makes, under the new scene, with its version and date", () => {
    const renamed = { rows: [{ ...before.rows[0], scene: "one-before" }, before.rows[1]] };
    const plan = planRun({ manifest: renamed, captured: [item("one", "use/one.webp", "one"), item("two", "use/two.webp", "two")], current, scenes: [{ id: "one" }, { id: "two" }], ...now });
    expect(plan.removes).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.manifest).toEqual(before);
  });

  it("keeps the rows of the scenes a partial run did not take", () => {
    const plan = planRun({ manifest: before, captured: [item("one", "use/one.webp", "one")], current, scenes: [{ id: "one" }], partial: true, ...now });
    expect(plan.removes).toEqual([]);
    expect(plan.manifest).toEqual(before);
  });
});

describe("the scene list", () => {
  it("names each scene once, in a known state and kind, with a light take and a dark take the page contract places under docs/images/", () => {
    expect(new Set(scenes.map((s) => s.id)).size).toBe(scenes.length);
    for (const scene of scenes) {
      expect(STATES).toContain(scene.state);
      expect(["still", "recording"]).toContain(scene.kind);
      expect(isDarkTake(scene.file)).toBe(false);
      for (const theme of THEMES) expect(placeOf(`docs/images/${takeFile(scene.file, theme)}`).kind).toBe(scene.kind === "still" ? "picture" : "recording");
      expect(scene.pages.length).toBeGreaterThan(0);
    }
  });

  it("holds at least one full-frame still and one declared crop", () => {
    expect(scenes.some((s) => s.kind === "still" && !s.crop)).toBe(true);
    expect(scenes.some((s) => s.kind === "still" && s.crop)).toBe(true);
  });

  it("holds at least one recording with a poster, each within eight seconds by its frame count", () => {
    const recordings = scenes.filter((s) => s.kind === "recording");
    expect(recordings.length).toBeGreaterThan(0);
    for (const scene of recordings) {
      expect(isDarkTake(scene.poster!)).toBe(false);
      for (const theme of THEMES) expect(placeOf(`docs/images/${takeFile(scene.poster, theme)}`).kind).toBe("picture");
      const frames = scene.steps!.reduce((sum, step) => sum + step.hold, 0);
      expect(frames / CADENCE).toBeLessThanOrEqual(RECORDING_MAX_SECONDS);
    }
  });

  it("takes the first-run setup card before any account exists", () => {
    expect(scenes.find((s) => s.id === "setup-card")?.state).toBe("fresh");
    expect(STATES.indexOf("fresh")).toBeLessThan(STATES.indexOf("seeded"));
  });

  it("takes the first map's scenes after every seeded scene, so no seeded picture shows the first map", () => {
    expect(STATES).toEqual(["fresh", "seeded", "first-map"]);
    const firstMap = scenes.filter((s) => s.state === "first-map");
    expect(firstMap.length).toBeGreaterThan(0);
    for (const scene of firstMap) {
      expect(scene.pages).toContain("docs/start/first-map.md");
      expect(scene.map).toBe(true);
    }
  });
});

describe("a scene's two takes", () => {
  it("are the light theme then the dark theme, the dark take beside the light one with .dark before the extension", () => {
    expect(THEMES).toEqual(["light", "dark"]);
    expect(darkTake("use/templates.webp")).toBe("use/templates.dark.webp");
    expect(darkTake("use/templates-search.webm")).toBe("use/templates-search.dark.webm");
    expect(lightTake("use/templates.dark.webp")).toBe("use/templates.webp");
    expect(takeFile("start/setup-card.webp", "light")).toBe("start/setup-card.webp");
    expect(takeFile("start/setup-card.webp", "dark")).toBe("start/setup-card.dark.webp");
    expect([takeTheme("use/a.webp"), takeTheme("use/a.dark.webm"), takeTheme("use/dark.webp")]).toEqual(["light", "dark", "light"]);
  });

  it("start their browser with the choice the app's theme switch stores, which its boot script reads before first paint", () => {
    // The key and value the app writes and reads; if the app moves them, the
    // dark take would come out light, and this fails first.
    expect(readFileSync("src/components/theme.tsx", "utf8")).toContain(`const STORAGE_KEY = "${THEME_STORAGE_KEY}";`);
    expect(readFileSync("src/app/document.tsx", "utf8")).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")==="dark"`);
    const origin = "http://127.0.0.1:3250";
    expect(themeStorage(origin, "light")).toEqual({ cookies: [], origins: [] });
    expect(themeStorage(origin, "dark")).toEqual({ cookies: [], origins: [{ origin, localStorage: [{ name: THEME_STORAGE_KEY, value: "dark" }] }] });
    expect(() => themeStorage(origin, "dusk")).toThrow(/no theme dusk/);
  });
});

describe("the WebP header", () => {
  it.each([
    ["lossy", { quality: 80 }, 3],
    ["lossless", { lossless: true }, 3],
    ["extended", { quality: 80, alphaQuality: 100 }, 4],
  ] as const)("reads the canvas of a %s file", async (_, options, channels) => {
    const file = await sharp({ create: { width: FRAME.width + 3, height: 7, channels, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).webp(options).toBuffer();
    expect(webpSize(file)).toEqual({ width: FRAME.width + 3, height: 7 });
  });

  it("reads nothing from a file that is not WebP", () => {
    expect(webpSize(Buffer.from("RIFF0000WAVEfmt ................"))).toBeNull();
  });
});

describe("the WebM header", () => {
  it("reads the video's size and the segment's length", () => {
    expect(webmInfo(webm())).toEqual({ width: 2880, height: 1800, length: 5, codec: "V_VP8" });
    expect(webmInfo(webm({ duration: 4300, width: 874, height: 912 }))).toMatchObject({ width: 874, height: 912, length: 4.3 });
  });

  it("reads a segment whose size is left unknown, as a stream writes it", () => {
    expect(webmInfo(webm({ unknownSegment: true }))).toMatchObject({ width: 2880, length: 5 });
  });

  it("reads nothing from a file that is not WebM or has no length", () => {
    expect(webmInfo(webm({ docType: "matroska" }))).toBeNull();
    expect(webmInfo(webm({ duration: null }))).toBeNull();
    expect(webmInfo(Buffer.from("not a recording"))).toBeNull();
  });
});

const ffmpeg = (() => { try { return bundledFfmpeg() as string; } catch { return null; } })();

describe("the recording encoder", () => {
  it.skipIf(!ffmpeg)("writes the same bytes for the same frames, as long as the frames say (needs npx playwright install ffmpeg)", async () => {
    const frame = (r: number) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g: 120, b: 90 } } }).png().toBuffer();
    const [a, b] = await Promise.all([frame(20), frame(220)]);
    const frames = [...Array(7).fill(a), ...Array(6).fill(b)];
    const one = await encodeWebm(frames, join(scratch, "one.webm"));
    const two = await encodeWebm(frames, join(scratch, "two.webm"));
    expect(Buffer.compare(one, two)).toBe(0);
    expect(webmInfo(one)).toEqual({ width: 64, height: 48, length: 13 / CADENCE, codec: "V_VP8" });
    expect(one.toString("latin1")).not.toMatch(/Lavf\d|Lavc\d|libvpx v/);
  });
});

describe("the catalogue folder", () => {
  it("lists the shipped templates, read by the server's own index parser, with nothing to download", async () => {
    const folder = mkdtempSync(join(scratch, "catalogue-"));
    const ids = await writeCatalogue(process.cwd(), folder);
    const shipped = JSON.parse(readFileSync("templates/index.json", "utf8")).templates.map((t: { id: string }) => t.id);
    expect(ids).toEqual(shipped);
    const entries = parseIndex(readFileSync(join(folder, "index.json"), "utf8"), { kind: "folder", folder, source: "environment" });
    expect(entries.map((e) => e.facts.id)).toEqual(shipped);
    for (const entry of entries) {
      expect(readFileSync(entry.pictureAddresses.light).subarray(1, 4).toString()).toBe("PNG");
      expect(entry.archive.startsWith(folder)).toBe(true);
    }
  });
});

describe("the picture script's server", () => {
  // A stand-in checkout whose server starts, records its process id in the
  // data directory and then never answers: the script must stop it before
  // giving up, or it outlives the scratch folder it was started over.
  const root = mkdtempSync(join(scratch, "checkout-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "node_modules/next/dist/bin"), { recursive: true });
  writeFileSync(join(root, "scripts/ingress-preload.mjs"), "");
  writeFileSync(join(root, "scripts/docs-pictures-observer.mjs"), "");
  // With a file named "answer" in the data directory it does answer the
  // health check, but the empty observer never writes the request file.
  writeFileSync(join(root, "node_modules/next/dist/bin/next"), [
    'const { existsSync, writeFileSync } = require("node:fs");',
    'const { join } = require("node:path");',
    'const data = process.env.DEZFIL_DATA_DIR;',
    'writeFileSync(join(data, "pid"), String(process.pid));',
    'if (existsSync(join(data, "answer"))) require("node:http").createServer((_, res) => res.end("ok")).listen(Number(process.argv.at(-1)), "127.0.0.1");',
    "else setInterval(() => {}, 1000);",
  ].join("\n"));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it.each([
    ["never becomes ready", false, /did not answer/],
    ["answers without the request observer", true, /request observer did not load/],
  ])("stops a server that %s before reporting the failure", async (_, answer, message) => {
    const folder = await makeScratch();
    if (answer) writeFileSync(join(folder.data, "answer"), "");
    let pid = 0;
    try {
      await expect(startServer({ root, port: await freePort(), scratch: folder, readyWithin: 1000 })).rejects.toThrow(message);
      pid = Number(readFileSync(join(folder.data, "pid"), "utf8"));
      expect(pid).toBeGreaterThan(0);
      expect(alive(pid)).toBe(false);
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(folder.folder, { recursive: true, force: true });
    }
  });
});
