import { testAccountScope } from "@/lib/test-support/accounts";
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance, connectQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { registerTableViews, dropTableView } from "./views";
import type { AccountScope } from "@/lib/auth/scope";

const initialDir = process.env.DEZFIL_DATA_DIR!;
let dir: string, alice: AccountScope, bob: AccountScope;
beforeEach(async () => {
  dir = await mkdtemp(path.join(initialDir, "local-views-"));
  process.env.DEZFIL_DATA_DIR = dir;
  closeMetadataDb(); resetQueryInstance();
  alice = testAccountScope(undefined, "alice");
  bob = testAccountScope(undefined, "bob");
  for (const scope of [alice, bob]) {
    const src = path.join(dir, `${scope.accountId}.csv`);
    await writeFile(src, `sentinel,lon,lat\n${scope.accountId},1,2\n`);
    await ingestFile(scope, src, "roads.csv");
  }
});
afterEach(async () => {
  vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance();
  process.env.DEZFIL_DATA_DIR = initialDir;
  await rm(dir, { recursive: true, force: true });
});

it("mounts another account while the first connection's create is held", async () => {
  const first = await connectQueryInstance(), second = await connectQueryInstance();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const run = first.run.bind(first);
  vi.spyOn(first, "run").mockImplementation(async (...args) => {
    if (String(args[0]).startsWith("CREATE")) { entered.resolve(); await release.promise; }
    return run(...args);
  });
  const pending = registerTableViews(alice, first);
  try {
    await entered.promise;
    await registerTableViews(bob, second);
    expect((await second.runAndReadAll("SELECT sentinel FROM roads")).getRowObjects()).toEqual([{ sentinel: "bob" }]);
    release.resolve(); await pending;
    expect((await first.runAndReadAll("SELECT sentinel FROM roads")).getRowObjects()).toEqual([{ sentinel: "alice" }]);
  } finally {
    release.resolve(); await pending;
    first.disconnectSync(); second.disconnectSync();
  }
});

it("invalidating one name never drops another connection's existing view", async () => {
  const first = await connectQueryInstance(), second = await connectQueryInstance();
  try {
    await Promise.all([registerTableViews(alice, first), registerTableViews(bob, second)]);
    await dropTableView(alice, "roads");
    expect((await second.runAndReadAll("SELECT sentinel FROM roads")).getRowObjects()).toEqual([{ sentinel: "bob" }]);
    expect((await first.runAndReadAll("SELECT sentinel FROM roads")).getRowObjects()).toEqual([{ sentinel: "alice" }]);
  } finally { first.disconnectSync(); second.disconnectSync(); }
});
