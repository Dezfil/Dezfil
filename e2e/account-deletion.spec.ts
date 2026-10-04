import { test, expect } from "@playwright/test";
import { closeAll, createProject, invitePerson, runTag, share, type Person } from "./sharing-support";
import { deletionControl } from "./deletion-support";

test("Users requires separate deactivation, exact email and a fresh private-count preview", async ({ page, browser, request, baseURL }, info) => {
  const people: Person[] = [], tag = runTag();
  try {
    const target = await invitePerson(browser, request, baseURL!, "Departing", tag), member = await invitePerson(browser, request, baseURL!, "Hidden", tag);
    people.push(target, member);
    expect((await request.patch(`/api/users/${target.id}`, { data: { isAdmin: true } })).status()).toBe(200);
    const privateName = `Private project ${tag}`, project = await createProject(target, privateName);
    await share(target, project, member, "viewer");
    expect((await target.api.post("/api/maps", { data: { name: `Private map ${tag}`, projectId: project } })).status()).toBe(201);
    await page.goto("/users");
    const me = (await (await request.get("/api/account")).json()).account;
    const own = page.getByRole("button", { name: new RegExp(`${me.name}.*you`) });
    await own.click(); await expect(page.getByRole("link", { name: "Change password", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete account", exact: true })).toHaveCount(0);
    const row = page.getByRole("button", { name: new RegExp(target.email) });
    await row.click(); await expect(page.getByRole("button", { name: "Delete account", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Deactivate", exact: true }).click();
    await page.getByRole("button", { name: "Deactivate", exact: true }).click();
    const opener = page.getByRole("button", { name: "Delete account", exact: true });
    await expect(page.getByRole("button", { name: "Reactivate", exact: true })).toBeVisible();
    await expect(opener).toHaveAttribute("data-variant", "quiet");
    await opener.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Delete account", exact: true });
    const input = dialog.getByRole("textbox", { name: "The account's email", exact: true });
    const submit = dialog.getByRole("button", { name: "Delete account", exact: true });
    await expect(dialog).toBeFocused(); await expect(input).toBeVisible();
    await expect(dialog).toContainText("1 map"); await expect(dialog).toContainText("1 project"); await expect(dialog).toContainText("1 other person");
    await expect(dialog).not.toContainText(privateName); await expect(dialog).not.toContainText(member.name);
    await expect(dialog).not.toContainText(`Private map ${tag}`);
    await expect(dialog).toContainText("Shared work and published links become unavailable.");
    await expect(dialog).toContainText("To keep this person's work for the team, leave the account deactivated.");
    await expect(submit).toBeDisabled();
    for (const wrong of [target.email.toUpperCase(), `${target.email} `]) { await input.fill(wrong); await expect(submit).toBeDisabled(); }
    await input.fill(target.email); await expect(submit).toBeEnabled();
    await submit.focus(); await page.keyboard.press("Tab"); await expect(input).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(submit).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); await expect(opener).toBeFocused();
    await opener.click(); await page.keyboard.press("Escape"); await expect(opener).toBeFocused();
    expect((await request.get("/api/users")).status()).toBe(200);
    await opener.click(); await input.fill(target.email);
    expect((await request.patch(`/api/users/${target.id}`, { data: { status: "active" } })).status()).toBe(200);
    expect((await request.patch(`/api/users/${target.id}`, { data: { status: "deactivated" } })).status()).toBe(200);
    await submit.click(); await expect(dialog.getByRole("alert")).toBeVisible(); await expect(submit).toBeDisabled();
    expect((await (await request.get("/api/users")).json()).deletions).toHaveLength(0);
    await dialog.getByRole("button", { name: "Review again", exact: true }).click();
    await expect(input).toHaveValue(""); await expect(submit).toBeDisabled(); await input.fill(target.email);
    await page.screenshot({ path: info.outputPath("counts-and-email.png") });
    const accepted = page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname === `/api/users/${target.id}`).then(response => response.json());
    await submit.click(); const status = await accepted; await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Search users", exact: true })).toBeFocused();
    if (status.state === "completed") await expect(page.getByRole("status").filter({ hasText: `${target.name}: deleted` })).toBeVisible();
    else {
      expect(status.state).toBe("pending"); await expect(page.getByText(`${target.name}: deleted`, { exact: true })).toHaveCount(0);
      await expect.poll(async () => (await (await request.get("/api/users")).json()).deletions.some((d: { id: string }) => d.id === status.id)).toBe(false);
      await page.reload();
    }
    await expect(row).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("completed.png") });
  } finally { await closeAll(people); }
});

test("Users deletes invitations without typing and empty accounts without work copy", async ({ page, browser, request, baseURL }, info) => {
  const tag = runTag(), people: Person[] = [];
  try {
    const empty = await invitePerson(browser, request, baseURL!, "Empty", tag); people.push(empty);
    expect((await request.patch(`/api/users/${empty.id}`, { data: { status: "deactivated" } })).status()).toBe(200);
    const name = `Invitation ${tag}`, email = `invitation-${tag}@example.test`;
    const invitation = await request.post("/api/users", { data: { name, email } }); expect(invitation.status()).toBe(201);
    await page.goto("/users"); await page.getByRole("button", { name: new RegExp(email) }).click();
    await page.getByRole("button", { name: "Delete account", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete account", exact: true });
    await expect(dialog).toContainText(`${name} never signed in, so only the invitation is removed.`);
    await expect(dialog.getByRole("textbox")).toHaveCount(0); await expect(dialog.locator("[data-deletion-totals]")).toHaveCount(0);
    await expect(dialog).not.toContainText("cannot be undone"); await page.screenshot({ path: info.outputPath("invitation.png") });
    await dialog.getByRole("button", { name: "Delete account", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: `${name}: deleted` })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(empty.email) }).click(); await page.getByRole("button", { name: "Delete account", exact: true }).click();
    await expect(dialog).toContainText("The account owns nothing"); await expect(dialog).toContainText("This cannot be undone.");
    await expect(dialog.locator("[data-deletion-totals]")).toHaveCount(0); await expect(dialog).not.toContainText("other people");
    await expect(dialog).not.toContainText("leave the account deactivated");
    await expect(dialog.getByRole("button", { name: "Delete account", exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath("empty.png") });
    const accepted = page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname === `/api/users/${empty.id}`).then(response => {
      expect([200, 202]).toContain(response.status()); return response.json();
    });
    await dialog.getByRole("textbox").fill(empty.email); await dialog.getByRole("button", { name: "Delete account", exact: true }).click();
    const status = await accepted; await expect(dialog).toHaveCount(0);
    const emptyRow = page.getByRole("button", { name: new RegExp(empty.email) });
    if (status.state === "completed") await expect(page.getByRole("status").filter({ hasText: `${empty.name}: deleted` })).toBeVisible();
    else {
      expect(status.state).toBe("pending"); await expect(emptyRow).toContainText("Deleting");
      await expect.poll(async () => {
        const read = await request.get(`/api/users/deletions/${status.id}`);
        if (read.status() === 404) return "completed";
        expect(read.status()).toBe(200); const pending = await read.json();
        expect(pending.state).toBe("pending"); return pending.state;
      }).toBe("completed");
      // Users holds the accepted state until a fresh list read on reload.
      const refreshed = page.waitForResponse(value => value.request().method() === "GET" && new URL(value.url()).pathname === "/api/users");
      await page.reload(); expect((await refreshed).status()).toBe(200);
      await expect(page.getByText("Loading users…", { exact: true })).toHaveCount(0);
    }
    await expect(emptyRow).toHaveCount(0);
  } finally { await closeAll(people); }
});

test("Users preserves unfinished deletion across reload and offers Finish deleting on note and row", async ({ page, browser, request, baseURL }, info) => {
  const target = await invitePerson(browser, request, baseURL!, "Retry", runTag()); let held = false;
  // Keep evidence of a transient false success even after its notice expires.
  const observeCompletion = () => page.evaluateHandle(text => {
    const seen = { completed: false };
    const check = () => { if (Array.from(document.querySelectorAll('[role="status"]')).some(node => node.textContent === text)) seen.completed = true; };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
    check(); return seen;
  }, `${target.name}: deleted`);
  try {
    expect((await request.patch(`/api/users/${target.id}`, { data: { status: "deactivated" } })).status()).toBe(200);
    await deletionControl({ command: "hold", accountId: target.id }); held = true;
    await deletionControl({ command: "compaction", fail: true });
    await page.goto("/users"); const row = page.getByRole("button", { name: new RegExp(target.email) }); await row.click();
    await page.getByRole("button", { name: "Delete account", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete account", exact: true });
    const accepting = await observeCompletion();
    const accepted = page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname === `/api/users/${target.id}`).then(response => response.json());
    await dialog.getByRole("textbox").fill(target.email); await dialog.getByRole("button", { name: "Delete account", exact: true }).click();
    const status = await accepted; expect(status.state).toBe("pending");
    await expect(dialog).toHaveCount(0); await expect(row).toContainText("Deleting");
    expect((await accepting.jsonValue()).completed, "pending acceptance must never show a completion notice").toBe(false);
    await accepting.dispose();
    await page.reload(); await row.click(); await expect(page.getByRole("button", { name: "Reactivate", exact: true })).toHaveCount(0);
    const pending = await observeCompletion();
    const finishing = () => page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/users/deletions/${status.id}/finish`).then(response => response.json());
    const continued = finishing();
    await page.getByRole("button", { name: "Finish deleting", exact: true }).click();
    expect((await continued).state).toBe("pending");
    await expect(row).toHaveAttribute("aria-expanded", "false"); await expect(row).toContainText("Deleting");
    expect((await pending.jsonValue()).completed, "held continuation must never show a completion notice").toBe(false);
    await deletionControl({ command: "release", accountId: target.id }); held = false;
    await expect.poll(async () => (await (await request.get("/api/users")).json()).deletions.find((d: { account: { id: string } }) => d.account.id === target.id)?.state).toBe("needs-retry");
    expect((await pending.jsonValue()).completed, "failed cleanup must never show a completion notice").toBe(false);
    await pending.dispose();
    await page.reload(); await expect(row).toContainText("Deletion unfinished");
    const unfinished = await observeCompletion();
    const note = page.getByRole("alert").filter({ hasText: `${target.name}’s account could not be deleted completely.` });
    await expect(note).toBeVisible(); await expect(note.getByRole("button", { name: "Finish deleting", exact: true })).toBeVisible();
    const retried = finishing();
    await note.getByRole("button", { name: "Finish deleting", exact: true }).click();
    expect((await retried).state).toBe("needs-retry");
    await expect(note.getByRole("button", { name: "Finish deleting", exact: true })).toBeEnabled(); await expect(note).toBeVisible();
    await row.click(); await expect(page.getByRole("button", { name: "Finish deleting", exact: true })).toHaveCount(2);
    await page.screenshot({ path: info.outputPath("unfinished.png") });
    expect((await unfinished.jsonValue()).completed, "unfinished retry must never show a completion notice").toBe(false);
    await unfinished.dispose();
    await deletionControl({ command: "compaction", fail: false });
    await page.getByRole("button", { name: "Finish deleting", exact: true }).last().click();
    await expect(page.getByRole("status").filter({ hasText: `${target.name}: deleted` })).toBeVisible();
    await expect(row).toHaveCount(0); await expect(note).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Search users", exact: true })).toBeFocused();
  } finally {
    if (held) await deletionControl({ command: "release", accountId: target.id });
    await deletionControl({ command: "compaction", fail: false }); await target.context.close();
  }
});
