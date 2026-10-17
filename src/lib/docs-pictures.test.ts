// The picture script's parts that need no browser: the manifest it writes
// (a file replaced only when its bytes changed, a row's version and date
// moving only with its file), its scene list, the WebP header it reads back
// and the catalogue folder it serves the Templates page from.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: plain-JS scripts, no declaration files on purpose.
import { FRAME, webpSize } from "../../scripts/docs-media.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: as above.
import { manifestText, planRun } from "../../scripts/docs-pictures-manifest.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: as above.
import { SCENES, STATES } from "../../scripts/docs-pictures-scenes.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: as above.
import { writeCatalogue } from "../../scripts/docs-pictures-instance.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: as above.
import { placeOf } from "../../scripts/docs-contract.mjs";
import { parseIndex } from "@/lib/templates/catalogue";

type Row = Record<string, unknown> & { file: string; scene: string };
type Scene = { id: string; file: string; kind: string; state: string; pages: string[]; crop?: { selector: string; margin?: number }; poster?: string };
const scenes = SCENES as Scene[];

const scratch = mkdtempSync(join(tmpdir(), "dezfil-docs-pictures-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const bytes = (text: string) => Buffer.from(text);
const item = (scene: string, file: string, content: string, extra: Record<string, unknown> = {}) =>
  ({ scene, kind: "picture", file, bytes: bytes(content), width: 10, height: 20, ...extra });
const listed = [{ id: "one" }, { id: "two" }, { id: "three" }];
const earlier = { version: "0.0.9", date: "2026-01-02" };
const now = { version: "0.1.0", date: "2026-10-17" };

describe("the manifest the picture script writes", () => {
  const before = {
    rows: [
      { file: "guides/one.webp", scene: "one", kind: "picture", ...earlier, width: 10, height: 20, bytes: 3 },
      { file: "guides/two.webp", scene: "two", kind: "picture", ...earlier, width: 10, height: 20, bytes: 3 },
    ],
  };
  const disk: Record<string, Buffer> = { "guides/one.webp": bytes("one"), "guides/two.webp": bytes("two") };
  const current = (file: string) => disk[file] ?? null;

  it("changes no file and no row when every picture came out the same", () => {
    const plan = planRun({ manifest: before, captured: [item("one", "guides/one.webp", "one"), item("two", "guides/two.webp", "two")], current, scenes: listed, ...now });
    expect(plan.writes).toEqual([]);
    expect(plan.removes).toEqual([]);
    expect(manifestText(plan.manifest)).toBe(manifestText(before));
  });

  it("replaces only the file whose bytes changed, and moves only its row's version and date", () => {
    const plan = planRun({ manifest: before, captured: [item("one", "guides/one.webp", "one, relabelled"), item("two", "guides/two.webp", "two")], current, scenes: listed, ...now });
    expect(plan.writes.map((w: { file: string }) => w.file)).toEqual(["guides/one.webp"]);
    expect(plan.manifest.rows).toEqual([
      { file: "guides/one.webp", scene: "one", kind: "picture", ...now, width: 10, height: 20, bytes: 15 },
      before.rows[1],
    ]);
  });

  it("writes a new file with today's version and date, rows in file order, crop and recording fields last", () => {
    const plan = planRun({
      manifest: null,
      captured: [
        item("two", "guides/two.webm", "loop", { kind: "recording", length: 4.2, poster: "guides/two-poster.webp" }),
        item("one", "start/one.webp", "crop", { crop: { x: 1, y: 2, width: 5, height: 10 } }),
      ],
      current: () => null, scenes: listed, ...now,
    });
    expect(plan.writes).toHaveLength(2);
    expect(plan.manifest.rows.map((row: Row) => Object.keys(row))).toEqual([
      ["file", "scene", "kind", "version", "date", "width", "height", "bytes", "length", "poster"],
      ["file", "scene", "kind", "version", "date", "width", "height", "bytes", "crop"],
    ]);
  });

  it("removes the file and row of a scene that left the list, and of a file a scene no longer makes", () => {
    const plan = planRun({ manifest: before, captured: [item("one", "guides/one-renamed.webp", "one")], current, scenes: [{ id: "one" }], ...now });
    expect(plan.removes).toEqual(["guides/one.webp", "guides/two.webp"]);
    expect(plan.manifest.rows.map((row: Row) => row.file)).toEqual(["guides/one-renamed.webp"]);
  });

  it("keeps the rows of the scenes a partial run did not take", () => {
    const plan = planRun({ manifest: before, captured: [item("one", "guides/one.webp", "one")], current, scenes: [{ id: "one" }], partial: true, ...now });
    expect(plan.removes).toEqual([]);
    expect(plan.manifest).toEqual(before);
  });
});

describe("the scene list", () => {
  it("names each scene once, in a known state and kind, with a file the page contract places under docs/images/", () => {
    expect(new Set(scenes.map((s) => s.id)).size).toBe(scenes.length);
    for (const scene of scenes) {
      expect(STATES).toContain(scene.state);
      expect(["still", "recording"]).toContain(scene.kind);
      expect(placeOf(`docs/images/${scene.file}`).kind).toBe(scene.kind === "still" ? "picture" : "recording");
      expect(scene.pages.length).toBeGreaterThan(0);
    }
  });

  it("holds at least one full-frame still and one declared crop", () => {
    expect(scenes.some((s) => s.kind === "still" && !s.crop)).toBe(true);
    expect(scenes.some((s) => s.kind === "still" && s.crop)).toBe(true);
  });

  it("takes the first-run setup card before any account exists", () => {
    expect(scenes.find((s) => s.id === "setup-card")?.state).toBe("fresh");
    expect(STATES.indexOf("fresh")).toBeLessThan(STATES.indexOf("seeded"));
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
