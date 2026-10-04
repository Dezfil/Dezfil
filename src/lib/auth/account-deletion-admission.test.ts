import { afterEach, expect, it, vi } from "vitest";
import { open } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { admitAccountWork, drainAccountWork, registerRetainedStore } from "./account-deletion-admission";
const db = open(":memory:");
afterEach(() => vi.restoreAllMocks());
it("shares held leases and populated retained stores across two loaded module graphs", async () => {
  testAccountScope(db, "target"); testAccountScope(db, "control");
  const lease = admitAccountWork(["target"], db), independent = admitAccountWork(["control"], db);
  let retained: string | undefined = "private buffer", cleared = 0;
  registerRetainedStore({ drain: () => drainAccountWork("target", db), busy: () => false, clear: () => { retained = undefined; cleared++; } });
  vi.resetModules();
  const other = await import("./account-deletion-admission");
  db.prepare("UPDATE accounts SET status = 'deleting' WHERE id = ?").run("target");
  expect(() => other.admitAccountWork(["target"], db)).toThrow();
  let done = false;
  const purge = other.purgeRetainedStores().then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(done).toBe(false); expect(retained).toBe("private buffer");
  expect(() => lease.assertCommit()).toThrow(); expect(() => independent.assertCommit()).not.toThrow();
  lease.release(); await purge;
  expect(retained).toBeUndefined(); expect(cleared).toBe(1);
  independent.release(); db.close();
});
it("retains failed cleanup across module copies until a successful retry while independent work continues", async () => {
  const store = open(":memory:"); testAccountScope(store, "cleanup-target"); testAccountScope(store, "cleanup-control");
  const failed = admitAccountWork(["cleanup-target"], store), control = admitAccountWork(["cleanup-control"], store);
  let blocked = true, candidate = "private candidate";
  failed.retainCleanup(async () => { if (blocked) throw new Error("unlink refused"); candidate = ""; });
  failed.release(); store.exec("UPDATE accounts SET status='deleting' WHERE id='cleanup-target'");
  vi.resetModules(); const other = await import("./account-deletion-admission");
  try {
    await expect(other.drainAccountWork("cleanup-target", store)).rejects.toThrow("unlink refused");
    expect(candidate).toBe("private candidate"); expect(() => control.assertCommit()).not.toThrow();
    blocked = false; await other.drainAccountWork("cleanup-target", store); expect(candidate).toBe("");
  } finally { blocked = false; await other.drainAccountWork("cleanup-target", store); control.release(); store.close(); }
});
