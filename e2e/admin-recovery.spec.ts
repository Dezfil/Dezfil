import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";

// The dedicated probe owns setup, port and store. Credential-bearing pages
// must not be recorded into traces, screenshots or videos.
test.use({ storageState: { cookies: [], origins: [] }, trace: "off", screenshot: "off", video: "off" });

test("a terminal recovery link chooses a password, signs into the same admin and cannot be reused", async ({ page, request, browser, baseURL }) => {
  const directory = process.env.DEZFIL_DATA_DIR;
  if (process.env.DEZFIL_E2E_FIRST_RUN !== "1" || !directory ||
      !path.basename(directory).startsWith("dezfil-admin-recovery-probe-") ||
      !baseURL || new URL(baseURL).hostname !== "127.0.0.1" || new URL(baseURL).port === "3000") {
    throw new Error("Run this isolated browser proof with node scripts/admin-recovery-probe.mjs browser.");
  }
  const password = "field notebooks before sunrise", replacement = "paper cranes after midnight";
  expect((await (await request.get("/api/auth/entry")).json()).setupRequired).toBe(true);
  const setup = await request.post("/api/auth/setup", { data: { name: "Recovery admin", email: "recovery@example.test", password } });
  expect(setup.status()).toBe(200); const account = (await setup.json()).account;
  const map = await request.post("/api/maps", { data: { name: "Retained recovery content" } });
  expect(map.status()).toBe(201); const owned = await map.json();
  const tokenResponse = await request.post("/api/account/tokens", { data: { name: "Recovery browser proof" } });
  expect(tokenResponse.status()).toBe(201); const token = (await tokenResponse.json()).secret;
  const invitation = await request.post("/api/users", { data: { name: "Other account", email: "other@example.test" } });
  expect(invitation.status()).toBe(201);
  const invited = new URL((await invitation.json()).signInUrl);
  const other = await browser.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  try {
    expect((await other.request.post("/api/auth/redeem", { data: {
      secret: new URLSearchParams(invited.hash.slice(1)).get("secret"), password,
    } })).status()).toBe(200);
    const otherBefore = await (await other.request.get("/api/auth/session")).json();
    const args = ["npm", "run", "--silent", "admin:recover", "--", "--data-dir", directory, "--origin", baseURL];
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    let terminal: string;
    try {
      terminal = execFileSync("script", process.platform === "darwin" ? ["-q", "/dev/null", ...args]
        : ["-q", "-e", "-c", args.map(quote).join(" "), "/dev/null"],
      { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch { throw new Error("The terminal recovery command failed; credential output was suppressed."); }
    const links = terminal.match(/https?:\/\/[^\s]+\/accept#secret=dz_link_[\w-]+/g) ?? [];
    expect(links.length).toBe(1);
    const link = links[0]; if (!link) throw new Error("The command did not disclose a recovery link.");
    expect(terminal.includes('Account: "recovery@example.test"')).toBe(true);
    expect(/Expires: \d{4}-/.test(terminal)).toBe(true);
    expect((await request.get("/api/maps")).status()).toBe(401);
    expect((await request.get("/api/maps", { headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);
    expect((await request.post("/api/auth/sign-in", { data: { email: account.email, password } })).status()).toBe(401);
    expect(await (await other.request.get("/api/auth/session")).json()).toEqual(otherBefore);

    const requestedURLs: string[] = [];
    page.on("request", outgoing => requestedURLs.push(outgoing.url()));
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("password");
    await page.getByRole("button", { name: "Set password", exact: true }).click();
    await expect(page.getByText("This password is too common. Choose a different one.", { exact: true })).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill(replacement);
    await page.getByRole("button", { name: "Set password", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/`);
    const signed = await (await page.request.get("/api/auth/session")).json();
    expect(signed.account).toMatchObject({ id: account.id, isAdmin: true, sqlName: account.sqlName });
    expect((await (await page.request.get(`/api/maps/${owned.id}`)).json()).name).toBe(owned.name);
    expect(requestedURLs.some(url => url.includes("dz_link_") || url.includes("#secret="))).toBe(false);
    expect(JSON.stringify(await (await page.request.get("/api/users")).json()).includes("dz_link_")).toBe(false);
    await page.goto(link);
    await page.getByLabel("Password", { exact: true }).fill(replacement);
    await page.getByRole("button", { name: "Set password", exact: true }).click();
    await expect(page.getByText("This sign-in link is unavailable.", { exact: true })).toBeVisible();
  } finally { await other.close(); }
});
