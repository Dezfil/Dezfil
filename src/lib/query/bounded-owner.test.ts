import { afterEach, expect, it, vi } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { testAccountScope } from "@/lib/test-support/accounts";
import { withTrustedMutation } from "@/lib/trusted-mutation";
import { connectQueryInstance } from "@/lib/duckdb";
import { registerTableViews } from "./views";
import { boundedEvaluation, EvaluationCancelled } from "./bounded";
vi.mock("@/lib/duckdb", () => ({ connectQueryInstance: vi.fn() }));
vi.mock("./views", () => ({ registerTableViews: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it.each(["acquisition", "registration"])("an inherited %s retains its native owner until drainage", async stage => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const disconnect = vi.fn(), interrupt = vi.fn();
  const conn = { disconnectSync: disconnect, interrupt } as unknown as DuckDBConnection;
  vi.mocked(connectQueryInstance).mockImplementation(async () => { if (stage === "acquisition") { entered.resolve(); await release.promise; } return conn; });
  vi.mocked(registerTableViews).mockImplementation(async () => { if (stage === "registration") { entered.resolve(); await release.promise; } });
  const caller = new AbortController(); let cleanup = false, settled = false;
  const work = withTrustedMutation({ kind: "export", name: "owned preparation", signal: caller.signal }, async () => {
    try { await boundedEvaluation(async () => undefined, { scope: testAccountScope() }); }
    finally { cleanup = true; }
  }).catch(error => error).finally(() => { settled = true; });
  await entered.promise; caller.abort();
  await new Promise(resolve => setImmediate(resolve));
  const prematureCleanup = cleanup, prematureSettlement = settled;
  release.resolve(); const outcome = await work;
  expect(prematureCleanup).toBe(false); expect(prematureSettlement).toBe(false);
  expect(outcome).toBeInstanceOf(EvaluationCancelled); expect(disconnect).toHaveBeenCalledOnce();
  if (stage === "registration") expect(interrupt).toHaveBeenCalled();
});
