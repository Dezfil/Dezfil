import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// The processor's admission and its one deadline, over a stand-in for the
// image library whose header reads and decodes the test holds and lets go:
// one picture at a time, eight waiting, the rest refused; a deadline that
// covers the wait, the header read and the processing; the slot passed on
// only once the native work has settled.

type Hold = { path: string; release: (value?: unknown) => void; fail: (error: Error) => void };
const library = vi.hoisted(() => ({
  calls: [] as string[],
  held: { metadata: [] as Hold[], render: [] as Hold[] },
  holdMetadata: false,
  holdRender: false,
  timeouts: [] as number[],
}));

vi.mock("sharp", () => {
  const hold = (kind: "metadata" | "render", path: string, value: unknown) => new Promise((resolve, reject) => {
    library.held[kind].push({ path, release: (v = value) => resolve(v), fail: reject });
  });
  const sharp = (path: string) => {
    const image = {
      metadata() {
        library.calls.push(`metadata ${path}`);
        const value = { format: "png", width: 64, height: 64 };
        return library.holdMetadata ? hold("metadata", path, value) : Promise.resolve(value);
      },
      resize() { return image; },
      webp() { return image; },
      timeout(options: { seconds: number }) { library.timeouts.push(options.seconds); return image; },
      toBuffer() {
        library.calls.push(`render ${path}`);
        const value = Buffer.from(`stored ${path}`);
        return library.holdRender ? hold("render", path, value) : Promise.resolve(value);
      },
    };
    return image;
  };
  sharp.cache = (options: unknown) => { library.calls.push(`cache ${String(options)}`); };
  return { default: sharp };
});

const { normalizePicture, pictureProcessorCounts } = await import("./normalize");

let folder: string;
beforeAll(() => { folder = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "admission-")); });
afterAll(() => rmSync(folder, { recursive: true, force: true }));
beforeEach(() => {
  library.calls.length = 0; library.timeouts.length = 0;
  library.held.metadata.length = 0; library.held.render.length = 0;
  library.holdMetadata = false; library.holdRender = false;
});

/** A file the content check takes for a still PNG. */
function upload(name: string): string {
  const file = path.join(folder, name);
  const header = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8); header.write("IHDR", 12, "latin1");
  writeFileSync(file, Buffer.concat([header, Buffer.from([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54])]));
  return file;
}
const settles = (promise: Promise<unknown>, ms = 60) =>
  Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5)); expect(check()).toBe(true); };

describe("the processor", () => {
  it("loads the image library on first use with its operation cache off", async () => {
    const work = normalizePicture(upload("first"));
    await work.picture;
    expect(library.calls[0]).toBe("cache false");
    expect(library.calls.slice(1)).toEqual([`metadata ${path.join(folder, "first")}`, `render ${path.join(folder, "first")}`]);
  });

  it("processes one picture at a time, lets eight wait and refuses the next", async () => {
    library.holdMetadata = true;
    const works = Array.from({ length: 9 }, (_, i) => normalizePicture(upload(`queued-${i}`)));
    await until(() => library.held.metadata.length === 1);
    const refused = normalizePicture(upload("refused"));
    await expect(refused.picture).rejects.toMatchObject({
      code: "operation_queue_full", status: 503, message: "8 pictures are already waiting to be processed. Try again in a moment.",
    });
    expect(await settles(refused.settled)).toBe(true);
    // In arrival order, each only once the one before it has settled.
    for (let i = 0; i < 9; i += 1) {
      await until(() => library.held.metadata.length === i + 1);
      expect(library.held.metadata[i].path).toBe(path.join(folder, `queued-${i}`));
      library.held.metadata[i].release();
      await works[i].picture;
    }
    expect(library.calls.filter((call) => call.includes("refused"))).toEqual([]);
  });

  it("counts the wait for a turn against the deadline, and a refused waiter leaves the room", async () => {
    library.holdMetadata = true;
    const first = normalizePicture(upload("holding"));
    await until(() => library.held.metadata.length === 1);
    const started = performance.now();
    const waiter = normalizePicture(upload("waiting"), 150);
    await expect(waiter.picture).rejects.toMatchObject({ code: "data_processing_timeout", status: 408 });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await settles(waiter.settled)).toBe(true);
    expect(library.calls.some((call) => call.includes("waiting"))).toBe(false);
    // The withdrawn place is free again: eight more fit, the ninth does not.
    const more = Array.from({ length: 8 }, (_, i) => normalizePicture(upload(`more-${i}`)));
    await expect(normalizePicture(upload("over")).picture).rejects.toMatchObject({ code: "operation_queue_full" });
    library.holdMetadata = false;
    library.held.metadata[0].release();
    await first.picture;
    await Promise.all(more.map((work) => work.picture));
  });

  it("refuses at the deadline a header read that stalls, and passes the slot on only when it settles", async () => {
    library.holdMetadata = true;
    const before = pictureProcessorCounts();
    const stalled = normalizePicture(upload("stalled"), 150);
    await expect(stalled.picture).rejects.toMatchObject({
      code: "data_processing_timeout", status: 408,
      message: "The picture took longer than the 0.15 s limit for processing one, which is fixed. Try again, or choose a smaller image.",
    });
    // No pixel was processed, and the native work still runs.
    expect(pictureProcessorCounts().decoded).toBe(before.decoded);
    expect(await settles(stalled.settled)).toBe(false);
    library.holdMetadata = false;
    const next = normalizePicture(upload("next"));
    expect(await settles(next.picture)).toBe(false);
    expect(library.calls.some((call) => call.includes("next"))).toBe(false);
    library.held.metadata[0].release();
    expect(await settles(stalled.settled, 1000)).toBe(true);
    // The cancelled work stops before decoding; the next picture runs.
    expect(library.calls.some((call) => call === `render ${path.join(folder, "stalled")}`)).toBe(false);
    await expect(next.picture).resolves.toEqual(Buffer.from(`stored ${path.join(folder, "next")}`));
  });

  it("refuses at the deadline a decode that stalls, bounding the library by what is left", async () => {
    library.holdRender = true;
    const stalled = normalizePicture(upload("slow"), 150);
    await expect(stalled.picture).rejects.toMatchObject({ code: "data_processing_timeout", status: 408 });
    expect(library.timeouts).toEqual([1]);
    expect(await settles(stalled.settled)).toBe(false);
    library.held.render[0].release();
    expect(await settles(stalled.settled, 1000)).toBe(true);
  });
});
