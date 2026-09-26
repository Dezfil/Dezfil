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
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
