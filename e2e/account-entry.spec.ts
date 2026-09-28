import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";

// Run on a new, isolated instance. The shared authenticated journey fixture
// will replace this opt-in once the existing surfaces adopt the request gate.
const firstRun = process.env.DEZFIL_E2E_FIRST_RUN === "1";
const email = "entry-browser@example.test";
const password = "field notebooks at dawn";

test.describe("account entry", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!firstRun, "Requires an isolated instance with no accounts and DEZFIL_E2E_FIRST_RUN=1.");

  test("first account, password refusal, still artwork and session reload", async ({ page, baseURL }) => {
    expect((await (await page.request.get("/api/auth/entry")).json()).setupRequired).toBe(true);
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Create the first account" })).toBeVisible();
    await expect(page.getByText("It becomes this instance's admin.")).toBeVisible();
    await expect(page.getByText("At least 8 characters.")).toBeVisible();
    await expect(page.getByText("32°23′N · 48°24′E")).toBeVisible();
    const art = page.locator('aside[aria-label="Dezfil"] svg');
    expect(await art.evaluate(element => getComputedStyle(element).animationName)).toBe("none");
    await page.getByLabel("Name", { exact: true }).fill("Browser fixture");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("password");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("alert")).toContainText("too common");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(new URL("/", baseURL).href);
    await page.reload();
    const session = await page.request.get("/api/auth/session");
    expect(session.status()).toBe(200);
    expect((await session.json()).account).toMatchObject({ name: "Browser fixture", email, isAdmin: true, isOriginal: true });
    const stored = (await page.context().cookies()).find(cookie => cookie.name === "dezfil_session");
    expect(stored).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: baseURL!.startsWith("https:") });
  });

  test("sign-in failures, show/hide password, sign-out and cookie replay", async ({ page, baseURL, playwright }) => {
    await page.goto("/sign-in");
    await expect(page.getByText("Forgot your password? An admin can reset it.")).toBeVisible();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("incorrect");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Email or password is incorrect");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(new URL("/", baseURL).href);
    const cookie = (await page.context().cookies()).find(value => value.name === "dezfil_session")!;
    const origin = new URL(baseURL!).origin;
    expect((await page.request.post("/api/auth/sign-out", { headers: { origin } })).status()).toBe(200);
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    const replay = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: `${cookie.name}=${cookie.value}` } });
    try {
      const response = await replay.get("/api/auth/session");
      expect(response.status()).toBe(401); expect(response.headers()["cache-control"]).toBe("private, no-store");
    } finally { await replay.dispose(); }
  });

  test("an unused hand-over link replaces a different account's signed-in browser", async ({ page, baseURL, playwright }) => {
    const data = process.env.DEZFIL_E2E_DATA_DIR;
    test.skip(!data, "Supply the isolated server's scratch data directory for the invitation fixture.");
    expect(path.resolve(data!).startsWith(path.resolve(".claude") + path.sep)).toBe(true);
    await page.goto("/sign-in");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(new URL("/", baseURL).href);
    await page.goto("/maps");
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/api/settings") && response.request().method() === "PATCH"),
      page.getByRole("button", { name: "List view", exact: true }).click(),
    ]);
    await expect(page.getByRole("button", { name: "List view", exact: true })).toHaveAttribute("data-on", "true");
    const original = (await (await page.request.get("/api/auth/session")).json()).account.id;
    const cookie = (await page.context().cookies()).find(value => value.name === "dezfil_session")!;
    const { open } = await import("../src/lib/metadata/db");
    const { authenticateSession } = await import("../src/lib/auth/credentials");
    const { inviteAccount } = await import("../src/lib/auth/admin");
    const db = open(path.join(data!, "metadata.sqlite"));
    const link = new URL("/accept", baseURL);
    try {
      const invitation = inviteAccount(authenticateSession(cookie.value, db)!, { name: "Link recipient", email: `recipient-${randomUUID()}@example.test` }, db);
      link.hash = new URLSearchParams({ secret: invitation.secret }).toString();
    } finally { db.close(); }
    await page.goto(link.href);
    await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("paper cranes at sunrise");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page).toHaveURL(new URL("/", baseURL).href);
    const recipient = (await (await page.request.get("/api/auth/session")).json()).account.id;
    expect(recipient).not.toBe(original);
    await page.goto("/maps");
    await expect(page.getByRole("button", { name: "Grid view", exact: true })).toHaveAttribute("data-on", "true");
    await page.goto("/settings");
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Link recipient");
    await expect(page.getByLabel("Instance name", { exact: true })).toBeDisabled();
    await page.getByLabel("Display name", { exact: true }).fill("Recipient renamed");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    await page.reload();
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Recipient renamed");
    const adminClient = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: `${cookie.name}=${cookie.value}` } });
    try {
      const settings = await (await adminClient.get("/api/settings")).json();
      expect(settings.displayName).toBe("Browser fixture");
      expect(settings.viewPrefs.maps.view).toBe("list");
    } finally { await adminClient.dispose(); }
    await page.goto(link.href);
    await page.getByLabel("Password", { exact: true }).fill("another set of notebooks");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("alert")).toContainText("unavailable");
    expect((await (await page.request.get("/api/auth/session")).json()).account.id).toBe(recipient);
  });
  test("Account and token cards keep profile edits, password invalidation and one-time secrets consistent", async ({ page, baseURL, playwright }) => {
    const origin = new URL(baseURL!).origin;
    const other = await playwright.request.newContext({ baseURL });
    const anonymous = await playwright.request.newContext({ baseURL });
    try {
      expect((await other.post("/api/auth/sign-in", { headers: { origin }, data: { email, password } })).status()).toBe(200);
      await page.goto("/sign-in");
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page).toHaveURL(new URL("/", baseURL).href);
      await page.goto("/settings#account");
      const account = page.getByRole("region", { name: "Account", exact: true });
      const tokens = page.getByRole("region", { name: "API / MCP tokens", exact: true });
      await account.getByLabel("Display name").fill("Account journey");
      await account.getByRole("button", { name: "Save", exact: true }).click();
      await expect(account.getByRole("status")).toHaveText("Saved");
      await page.reload();
      await expect(account.getByLabel("Display name")).toHaveValue("Account journey");
      const changedEmail = "renamed-entry@example.test";
      await account.getByLabel("Email", { exact: true }).fill(changedEmail);
      await expect(account.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await account.getByLabel("Current password to change email").fill("wrong");
      await account.getByRole("button", { name: "Save", exact: true }).click();
      await expect(account.getByRole("alert")).toContainText("current password");
      expect((await (await page.request.get("/api/account")).json()).account.email).toBe(email);
      await account.getByLabel("Current password to change email").fill(password);
      await account.getByRole("button", { name: "Save", exact: true }).click();
      await expect(account.getByRole("status")).toHaveText("Saved");
      expect((await anonymous.post("/api/auth/sign-in", { headers: { origin }, data: { email, password } })).status()).toBe(401);
      await tokens.getByLabel("Token name").fill("Browser CLI");
      await tokens.getByRole("button", { name: "Create token" }).click();
      const secret = await tokens.getByLabel("New token").inputValue();
      expect(secret).toMatch(/^dz_token_/);
      const bearer = { authorization: `Bearer ${secret}` };
      expect((await anonymous.get("/api/account", { headers: bearer })).status()).toBe(200);
      expect(JSON.stringify(await (await page.request.get("/api/account/tokens")).json())).not.toContain(secret);
      await tokens.getByRole("button", { name: "Done", exact: true }).click();
      await expect(tokens.getByLabel("New token")).toHaveCount(0);
      await page.reload();
      await expect(tokens.getByLabel("New token")).toHaveCount(0);
      await account.locator("summary").click();
      await account.getByLabel("Current password", { exact: true }).fill(password);
      await account.getByLabel("New password", { exact: true }).fill("12345678");
      await account.getByRole("button", { name: "Change password", exact: true }).click();
      await expect(account.getByRole("alert")).toContainText("too common");
      const newPassword = "a different field notebook";
      await account.getByLabel("New password", { exact: true }).fill(newPassword);
      await account.getByRole("button", { name: "Change password", exact: true }).click();
      await expect(account.getByRole("status")).toHaveText("Password changed");
      expect((await page.request.get("/api/account")).status()).toBe(200);
      expect((await other.get("/api/account")).status()).toBe(401);
      expect((await anonymous.get("/api/account", { headers: bearer })).status()).toBe(200);
      await tokens.getByRole("button", { name: "Revoke Browser CLI" }).click();
      const confirmation = page.getByRole("dialog", { name: "Revoke Browser CLI" });
      await confirmation.getByRole("button", { name: "Revoke token", exact: true }).click();
      await expect(confirmation).toHaveCount(0);
      await expect(tokens.getByText("Revoked", { exact: true })).toBeVisible();
      expect((await anonymous.get("/api/account", { headers: bearer })).status()).toBe(401);
      // Restore the entry fixture for subsequent delegated journeys.
      expect((await page.request.patch("/api/account", { headers: { origin }, data: { name: "Browser fixture", email, currentPassword: newPassword } })).status()).toBe(200);
      expect((await page.request.post("/api/account/password", { headers: { origin }, data: { currentPassword: newPassword, password } })).status()).toBe(200);
    } finally { await other.dispose(); await anonymous.dispose(); }
  });

});
