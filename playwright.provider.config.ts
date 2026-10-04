import { defineConfig, devices } from "@playwright/test";

// Own authentication in the journey; reuse the API probe's isolated account.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "provider-cancellation.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.DEZFIL_BASE_URL ?? "http://127.0.0.1:3217",
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
});
