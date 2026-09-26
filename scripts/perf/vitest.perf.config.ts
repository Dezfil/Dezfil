import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

/**
 * Profiling harnesses (measurement only) — deliberately a separate
 * config so they never join the default suite, and deliberately *not* at
 * the repository root: the standalone tracer mirrors root config files
 * into the runtime image, whose top-level contents are an allowlisted
 * contract. Re-run from the repository root with:
 *
 *   npx vitest run --config scripts/perf/vitest.perf.config.ts
 */
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    environment: "node",
    include: ["scripts/perf/**/*.perf.ts"],
    // A measurement pass is not a suite: no parallel workers competing for
    // the same cores, and no per-test time budget.
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    // Numbers are the deliverable — they must reach stdout unbuffered.
    disableConsoleIntercept: true,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
    },
  },
});
