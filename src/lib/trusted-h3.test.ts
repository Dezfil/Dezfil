import { expect, it, vi } from "vitest";
import type { DuckDBInstance } from "@duckdb/node-api";
import { loadTrustedH3 } from "./trusted-h3";

it("failed trusted H3 installation is attempted once across concurrent and later ingests", async () => {
  const run = vi.fn().mockRejectedValue(new Error("offline"));
  const disconnectSync = vi.fn();
  const connect = vi.fn().mockResolvedValue({ run, disconnectSync });
  const instance = { connect } as unknown as DuckDBInstance;
  expect(await Promise.all([loadTrustedH3(instance), loadTrustedH3(instance)])).toEqual([false, false]);
  expect(await loadTrustedH3(instance)).toBe(false);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(run.mock.calls.map(c => c[0])).toEqual(["LOAD h3", "INSTALL h3 FROM community"]);
  expect(disconnectSync).toHaveBeenCalledTimes(1);
});

it("preinstalled trusted H3 never installs and does not reuse another instance's outcome", async () => {
  const run = vi.fn().mockResolvedValue(undefined);
  const disconnectSync = vi.fn();
  const instance = { connect: vi.fn().mockResolvedValue({ run, disconnectSync }) } as unknown as DuckDBInstance;
  expect(await loadTrustedH3(instance)).toBe(true);
  expect(await loadTrustedH3(instance)).toBe(true);
  expect(run.mock.calls.map(c => c[0])).toEqual(["LOAD h3"]);
  expect(disconnectSync).toHaveBeenCalledTimes(1);
});
