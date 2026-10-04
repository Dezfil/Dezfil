import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeRequest } from "../../../scripts/result-budget-observation.mjs";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "budget-observation-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it("pauses before the labelled request and marks only its execution interval", async () => {
  const run = vi.fn().mockResolvedValue({ status: 200, bytes: 33554432 });
  const result = observeRequest(directory, "admitted-at-ceiling-0", { sql: "SELECT 1" }, run);
  const markers = join(directory, "admitted-at-ceiling-0");
  await vi.waitFor(() => expect(existsSync(join(markers, "ready.json"))).toBe(true));
  expect(run).not.toHaveBeenCalled();
  expect(existsSync(join(markers, "started.json"))).toBe(false);
  await writeFile(join(markers, "release"), "");
  expect(await result).toEqual({ status: 200, bytes: 33554432 });
  expect(JSON.parse(await readFile(join(markers, "ready.json"), "utf8"))).toMatchObject({ request: { sql: "SELECT 1" } });
  const start = JSON.parse(await readFile(join(markers, "started.json"), "utf8"));
  const end = JSON.parse(await readFile(join(markers, "done.json"), "utf8"));
  expect(start.at).toBeLessThanOrEqual(end.at);
  expect(end).toMatchObject({ status: 200, bytes: 33554432 });
  expect(run).toHaveBeenCalledOnce();
});
it("keeps an unmarked request immediate", async () => {
  const run = vi.fn().mockResolvedValue({ status: 422, bytes: 205 });
  expect(await observeRequest(undefined, "refused", {}, run)).toEqual({ status: 422, bytes: 205 });
  expect(run).toHaveBeenCalledOnce();
});
