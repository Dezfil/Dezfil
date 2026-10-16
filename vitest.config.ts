import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // The per-test and per-hook bounds are hang guards, not measurements.
    // At vitest's 5 s default they fired on a shared two-core pipeline
    // runner, where two DuckDB-seeding assistant cases dominated a 915 s
    // suite, and once each before that under whole-set load on a
    // workstation. A hang still fails, later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // `npm run test:coverage` measures the product code the suite reaches.
    // The report is a map of what is untested, read at a phase's close; it
    // is not a gate, and no threshold fails the run.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx,mjs}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts", "src/**/fixtures/**"],
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "coverage",
      // The map is wanted even when a case fails; the suite's own result
      // is read from its summary, not from the report's presence.
      reportOnFailure: true,
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
