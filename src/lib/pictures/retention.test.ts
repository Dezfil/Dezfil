import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { assertOldPictureRead, assertOldPictureCoverage, oldPictureMonitor } from "../../../scripts/pictures-retention.mjs";
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const map = { id: "legacy", group: "old", oldPictureSha256: hash("old") };
const publication = { kind: "published", mapId: map.id };
const old = { mapId: map.id, theme: "light", status: 200, bytes: 3, sha256: hash("old"), startOffset: 0, endOffset: 0 };
const fresh = { ...old, sha256: hash("new"), startOffset: 1, endOffset: 1 };

it("rejects seeded early replacement, missing bytes and stale bytes after publication", () => {
  expect(() => assertOldPictureRead(map, { ...old, sha256: hash("new") }, [])).toThrow("changed before publication");
  expect(() => assertOldPictureRead(map, { ...old, status: 404 }, [])).toThrow("stopped being served");
  expect(() => assertOldPictureRead(map, { ...old, bytes: 0 }, [])).toThrow("empty bytes");
  expect(() => assertOldPictureRead(map, { ...fresh, sha256: hash("old") }, [publication])).toThrow("survived their replacement");
  expect(assertOldPictureRead(map, old, [publication])).toBe("old");
  expect(assertOldPictureRead(map, fresh, [publication])).toBe("new");
});

it("requires both themes on every old map before and after replacement and checks overlapping reads", () => {
  const reads = [old, fresh, { ...old, theme: "dark" }, { ...fresh, theme: "dark" }];
  expect(() => assertOldPictureCoverage([map], reads, [publication])).not.toThrow();
  expect(() => assertOldPictureCoverage([map], reads.slice(1), [publication])).toThrow("Never read the old light");
  expect(() => assertOldPictureCoverage([map], reads.slice(0, 3), [publication])).toThrow("replacement dark");
  expect(() => assertOldPictureCoverage([map, { ...map, id: "unread" }], reads, [publication])).toThrow("unread");
  const overlap = { ...fresh, startOffset: 0 };
  for (const sha256 of [hash("old"), hash("new")]) expect(() => assertOldPictureCoverage([map], [...reads, { ...overlap, sha256 }], [publication])).not.toThrow();
  expect(() => assertOldPictureCoverage([map], [...reads, { ...overlap, sha256: hash("torn") }], [publication])).toThrow("neither complete picture");
});

it("reads bytes repeatedly, drains before downtime and resumes to read replacements", async () => {
  const events: typeof publication[] = [], reads: { phase?: string; mapId: string; theme: string }[] = [];
  let available = true, calls = 0;
  const monitor = oldPictureMonitor({ maps: [map], events: () => [...events], intervalMs: 5,
    read: async () => {
      expect(available).toBe(true); calls++;
      return new Response(events.length ? "new" : "old");
    }, record: (sample: typeof reads[number]) => reads.push(sample),
  });
  try {
    await monitor.start();
    await expect.poll(() => calls).toBeGreaterThan(2);
    await monitor.pause(); available = false;
    const before = calls; await new Promise(resolve => setTimeout(resolve, 20)); expect(calls).toBe(before);
    events.push(publication); available = true; monitor.resume();
    await expect.poll(() => reads.filter(read => read.phase === "new").length).toBe(2);
    await monitor.finish();
    expect(() => assertOldPictureCoverage([map], reads, events)).not.toThrow();
  } finally { await monitor.stop(); }
});

it("records an unsuccessful HTTP read before surfacing its failure", async () => {
  const reads: { status: number; error?: string }[] = [];
  const monitor = oldPictureMonitor({ maps: [map], events: () => [], read: async () => new Response("missing", { status: 404 }),
    record: (sample: typeof reads[number]) => reads.push(sample),
  });
  await expect(monitor.start()).rejects.toThrow("stopped being served");
  expect(reads[0]).toMatchObject({ status: 404, error: expect.stringContaining("stopped being served") });
});
