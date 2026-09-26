// Profiling configuration (measurement only) — deliberately separate
// from playwright.config.ts so the perf harness never joins the journey
// suite, deliberately not at the repository root (the standalone tracer
// mirrors root config files into the runtime image, whose top-level
// contents are an allowlisted contract), and deliberately
// HEADED: headless Chromium falls back to a software GL implementation,
// which would measure SwiftShader instead of this machine's GPU.
//
//   DEZFIL_BASE_URL=http://127.0.0.1:3142 \
//     npx playwright test --config scripts/perf/playwright.perf.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  workers: 1,
  retries: 0,
  timeout: 900_000,
  expect: { timeout: 120_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.DEZFIL_BASE_URL ?? "http://127.0.0.1:3141",
    headless: false,
    actionTimeout: 120_000,
    trace: "off",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
