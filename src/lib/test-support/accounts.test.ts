import v8 from "node:v8";
import vm from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { testAccountRequest } from "./accounts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
});
afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as (options: { type: "major" }) => void;
async function collect() {
  // Weak references stay alive for the current job, so collect in later jobs.
  await new Promise(resolve => setImmediate(resolve)); gc({ type: "major" });
  await new Promise(resolve => setImmediate(resolve)); gc({ type: "major" });
}

// A request built from another follows its signal only while the one it was
// built from is alive, and the fixture builds the route's request in two
// steps. A collection between building it and the caller leaving must not
// cut the caller's departure off from the route.
it("a route fixture's request still sees its caller leave after a collection", async () => {
  const controller = new AbortController();
  const request = testAccountRequest(new Request("http://test/api/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: controller.signal,
  }));
  await collect();
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  expect(request.signal.aborted).toBe(true);
});
