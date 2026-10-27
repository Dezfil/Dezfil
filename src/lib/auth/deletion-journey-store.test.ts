import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

/** Paths removed for real just before the scan reaches them, as the server
 * removes its own short-lived files while the journey reads the store. */
const vanishing = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const vanish = (target: unknown) => { if (vanishing.has(String(target))) fs.rmSync(String(target), { recursive: true, force: true }); };
  return {
    ...fs,
    openSync: ((target: string, ...rest: unknown[]) => { vanish(target); return (fs.openSync as (...args: unknown[]) => number)(target, ...rest); }) as typeof fs.openSync,
    readdirSync: ((target: string, ...rest: unknown[]) => { vanish(target); return (fs.readdirSync as (...args: unknown[]) => unknown)(target, ...rest); }) as typeof fs.readdirSync,
  };
});

const { scanStore, writeProofFile } = await import("../../../scripts/deletion-journey-store.mjs");

let directory: string;
afterEach(async () => {
  vanishing.clear();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("reads past a file and a folder that go between the listing and the read", async () => {
  directory = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "scan-vanishing-"));
  writeProofFile(directory, ".dezfil-write-probe-gone", "");
  writeProofFile(directory, "cache/gone/held", "erased-sentinel");
  writeProofFile(directory, "tables/kept", "erased-sentinel");
  vanishing.add(path.join(directory, ".dezfil-write-probe-gone"));
  vanishing.add(path.join(directory, "cache/gone"));
  expect(scanStore(directory, ["erased-sentinel"])).toEqual({ "erased-sentinel": ["tables/kept"] });
});

it("still fails when the store itself is missing", async () => {
  directory = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "scan-missing-"));
  vanishing.add(directory);
  expect(() => scanStore(directory, ["erased-sentinel"])).toThrow(/ENOENT/);
});
