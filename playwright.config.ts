// Browser journey configuration. One journey, one browser, no retries:
// flakiness must surface as failure with a trace, not be averaged away.
// Target instance via DEZFIL_BASE_URL (default localhost).
import { existsSync } from "node:fs";
import { defineConfig, devices, webkit } from "@playwright/test";

const baseURL = process.env.DEZFIL_BASE_URL ?? "http://localhost:3000";
// The browsers that draw no bend under the Liquid panels run that journey's
// fallback case and nothing else: Firefox, and WebKit where its build is
// installed on this machine (where it is not, the case is unverified there).
const fallback = { testMatch: /panel-looks\.spec\.ts$/, grep: /@fallback/ };
const webkitInstalled = existsSync(webkit.executablePath());
export default defineConfig({
  globalSetup: "./e2e/auth.setup.ts",
  testDir: "./e2e",
  // This journey owns a provider and a separately configured app instance.
  testIgnore: "provider-cancellation.spec.ts",
  workers: 1,
  retries: 0,
  // The whole journey must fit the pipeline's budget; individual expect
  // polls stay short so a stuck step fails fast with context.
  timeout: 240_000,
  expect: {
    timeout: 15_000,
    // NO global screenshot tolerance. An absolute pixel budget applied to
    // every shot is wrong at both ends: on a 38x258 stage-stack crop, 80
    // pixels is most of a small icon, so a real regression could pass.
    // Tolerance is therefore granted per assertion, at the shot that
    // measured the need: see e2e/state-unification-pixels.spec.ts, where
    // the glyph-edge noise was attributed. Everything else compares at
    // Playwright's default, which is what a baseline is for.
  },
  reporter: [["list"]],
  use: {
    baseURL,
    storageState: process.env.DEZFIL_E2E_FIRST_RUN === "1" ? { cookies: [], origins: [] } : ".claude/browser-auth.json",
    extraHTTPHeaders: { origin: new URL(baseURL).origin },
    // A stuck click should fail in seconds with a trace, not consume the
    // whole test budget (a broken step otherwise burns minutes in CI).
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, grepInvert: /@fallback/ },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, ...fallback },
    ...(webkitInstalled ? [{ name: "webkit", use: { ...devices["Desktop Safari"] }, ...fallback }] : []),
  ],
});
