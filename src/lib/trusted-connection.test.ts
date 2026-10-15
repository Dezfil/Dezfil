import { expect, it, vi } from "vitest";
import type { DuckDBConnection, DuckDBPreparedStatement } from "@duckdb/node-api";
import { admitTrustedOperation } from "./trusted-operation";
import { runTrustedConnection } from "./trusted-connection";

it("destroys a prepared statement acquired after its reader departs", async () => {
  const caller = new AbortController();
  const owner = admitTrustedOperation({ kind: "interactive-read", name: "Inspection", signal: caller.signal });
  const held = Promise.withResolvers<DuckDBPreparedStatement>(), entered = Promise.withResolvers<void>();
  const prepared = { destroySync: vi.fn() } as unknown as DuckDBPreparedStatement;
  const conn = { prepare: vi.fn(() => { entered.resolve(); return held.promise; }), interrupt: vi.fn(), disconnectSync: vi.fn() } as unknown as DuckDBConnection;
  const work = owner.run(() => runTrustedConnection(conn, c => c.prepare("SELECT 1"), owner)).catch(error => error);
  await entered.promise; caller.abort(); await work; held.resolve(prepared); await owner.drained;
  expect(prepared.destroySync).toHaveBeenCalledOnce(); expect(conn.disconnectSync).toHaveBeenCalledOnce();
});

it("leaves a format refusal available for its owning caller to translate", async () => {
  const { ApiError } = await import("./api/errors");
  const owner = admitTrustedOperation({ kind: "template-install", name: "Template installation" });
  const native = { interrupt: vi.fn(), disconnectSync: vi.fn() } as unknown as DuckDBConnection;
  const translated = new Error("The template member cannot be read.");
  const work = owner.run(async () => {
    try { await runTrustedConnection(native, async () => { throw new ApiError("malformed_file", "Unreadable input", 422); }, owner); }
    catch { throw translated; }
  });
  await expect(work).rejects.toBe(translated); await owner.drained;
  expect(native.disconnectSync).toHaveBeenCalledOnce();
});
