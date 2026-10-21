import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ownInstance, type OwnInstance } from "./page-calls";

let dir: string | undefined;
let instance: OwnInstance | undefined;
afterEach(async () => {
  await instance?.close();
  instance = undefined;
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

// The pipeline names a scratch data folder that no step makes, so the
// first instance a run starts can find it missing.
it("starts an instance of its own under a scratch data folder that does not exist yet", async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  const scratch = path.join(dir, "data");
  vi.stubEnv("DEZFIL_DATA_DIR", scratch);
  instance = await ownInstance("http://localhost:3000", "3452");
  expect(path.dirname(instance.directory)).toBe(scratch);
  expect(existsSync(instance.directory)).toBe(true);
  expect((await fetch("http://localhost:3000/api/health")).status).toBe(200);
});
