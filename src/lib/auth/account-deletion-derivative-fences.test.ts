import { afterEach, beforeEach, expect, it, vi } from "vitest";
const hold = vi.hoisted(() => ({ ready: Promise.withResolvers<void>(), write: Promise.withResolvers<void>(), cleaning: Promise.withResolvers<void>(), cleanup: Promise.withResolvers<void>(), armed: false }));
vi.mock("node:fs/promises", async load => {
  const fs = await load<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    await fs.writeFile(...args);
    if (hold.armed && String(args[0]).includes("thumbnails/") && String(args[0]).endsWith(".tmp")) { hold.ready.resolve(); await hold.write.promise; }
  }, rm: async (...args: Parameters<typeof fs.rm>) => {
    if (hold.armed && String(args[0]).endsWith(".tmp")) { hold.cleaning.resolve(); await hold.cleanup.promise; }
    return fs.rm(...args);
  } };
});
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { ingestFile } from "@/lib/ingest/ingest";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { saveThumbnail, saveThemedThumbnail } from "@/lib/map-thumbnails";
import { discoverFiles } from "../../../test-support/account-erasure-discovery";
import { drainAccountWork } from "./account-deletion-admission";
const root = process.env.DEZFIL_DATA_DIR!; let folder: string;
beforeEach(async () => { folder = await mkdtemp(path.join(root, "derivative-fence-")); process.env.DEZFIL_DATA_DIR = folder; closeMetadataDb(); resetQueryInstance(); hold.ready = Promise.withResolvers<void>(); hold.write = Promise.withResolvers<void>(); hold.cleaning = Promise.withResolvers<void>(); hold.cleanup = Promise.withResolvers<void>(); });
afterEach(async () => { hold.armed = false; hold.write.resolve(); hold.cleanup.resolve(); closeMetadataDb(); resetQueryInstance(); process.env.DEZFIL_DATA_DIR = root; await rm(folder, { recursive: true, force: true }); });
it.each(["single", "light", "dark"])("refuses a foreign %s card candidate and drains its rejected temporary write", async theme => {
  const target = testAccountScope(undefined, "target"), control = testAccountScope(undefined, "control");
  const source = path.join(folder, "source.csv"); await writeFile(source, "value\n42\n"); const dataset = await ingestFile(target, source, "same.csv");
  const map = createMap(control, "Same"), independent = createMap(control, "Independent");
  await saveThumbnail(control, independent.id, Buffer.from("independent"));
  const inputs = { catalogue: false, datasets: [{ id: dataset.id, file: dataset.file }] };
  hold.armed = true;
  const pending = theme === "single" ? saveThumbnail(control, map.id, Buffer.from("late"), inputs) : saveThemedThumbnail(control, map.id, theme as "light" | "dark", "cycle", Buffer.from("late"), inputs);
  const outcome = pending.catch(error => error);
  await hold.ready.promise; metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  let done = false; const drained = drainAccountWork("target").then(() => { done = true; });
  try {
    await new Promise(r => setImmediate(r)); expect(done).toBe(false);
    hold.write.resolve(); await hold.cleaning.promise;
    await new Promise(r => setImmediate(r)); expect(done).toBe(false);
  } finally { hold.write.resolve(); hold.cleanup.resolve(); }
  expect(await outcome).toBeInstanceOf(Error); await drained;
  expect(discoverFiles(folder).some(file => file.includes(map.id))).toBe(false);
  expect(discoverFiles(folder)).toContain(`thumbnails/${independent.id}.png`);
});
