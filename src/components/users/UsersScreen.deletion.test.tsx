import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import type { PendingDeletion } from "@/lib/auth/account-deletion-status";
import { installDomHost } from "../testing/dom-host";
import { UsersScreen } from "./UsersScreen";
import { UserRow } from "./UserRow";
const account: Account = { id: "target", name: "Cy Marsh", email: "cy@example.test", sqlName: "cy_marsh", isAdmin: true, status: "deactivated", isOriginal: false, createdAt: "2026-01-01", updatedAt: "2026-01-01", lastSignInAt: "2026-01-01" };
it.each(["active", "invited", "deactivated"] as const)("offers quiet Delete only on eligible other %s rows, including deactivated admins", status => {
  for (const own of [false, true]) {
    const html = renderToStaticMarkup(<UserRow account={{ ...account, status }} own={own} open busy={false} handOver={null}
      onToggle={() => {}} onAccess={async () => true} onReset={async () => true} onDone={() => {}} onDelete={() => {}} />);
    expect(html.includes("Delete account")).toBe(!own && status !== "active");
    if (!own && status === "deactivated") expect(html).toContain("Reactivate");
    if (own) expect(html).toContain("Change password");
  }
});
let host: ReturnType<typeof installDomHost>, root: ReturnType<typeof createRoot>, entries: PendingDeletion[];
let result: "pending" | "needs-retry" | "completed", calls: string[], listed: Account[];
beforeEach(() => {
  host = installDomHost(); const container = host.document.createElement("div"); host.document.body.appendChild(container); root = createRoot(container as unknown as Element);
  entries = []; listed = [{ ...account, status: "invited", lastSignInAt: null }]; result = "completed"; calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"; calls.push(`${method} ${url}`);
    if (url === "/api/account") return Response.json({ account: { ...account, id: "me" } });
    if (url === "/api/users") return Response.json({ users: listed, deletions: entries });
    if (url.endsWith("/deletion-preview")) return Response.json({ account, invited: true, totals: {}, people: 0, confirmation: "a".repeat(64) });
    if (method === "DELETE" || url.endsWith("/finish")) {
      listed = []; entries = result === "completed" ? [] : [{ id: "deletion", state: result, account }];
      return Response.json({ id: "deletion", state: result }, { status: result === "completed" ? 200 : 202 });
    }
    throw new Error(`Unexpected ${method} ${url}`);
  }));
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.unstubAllGlobals(); });
const q = (selector: string) => host.document.querySelector(selector);
const button = (text: string) => (q('[role="dialog"]') ?? host.document).querySelectorAll("button").find(b => b.textContent === text)!;
const click = (text: string) => act(async () => { button(text).click(); });
const mount = () => act(async () => root.render(<UsersScreen />));
async function openDelete() {
  await mount(); await act(async () => q('button[aria-expanded="false"]')!.click());
  button("Delete account").focus(); await click("Delete account");
}
it("focuses search after the closing dialog releases the page and removes its opener", async () => {
  await openDelete(); const search = q('input[aria-label="Search users"]')!, observations: boolean[] = [], connected: boolean[] = [];
  const focus = search.focus.bind(search); search.focus = () => { observations.push(search.closest("[inert]") !== null); connected.push(search.isConnected); focus(); };
  expect(search.closest("[inert]")).not.toBeNull();
  await act(async () => { button("Delete account").click(); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); });
  expect(q('[role="dialog"]') === null).toBe(true);
  expect(observations).toEqual([false]); expect(connected).toEqual([true]); expect(host.document.activeElement === search).toBe(true); expect(q('[role="status"]')!.textContent).toBe("Cy Marsh: deleted");
});
it.each(["pending", "needs-retry"] as const)("never claims completion for %s and recovers Finish deleting after remount", async state => {
  result = state; await openDelete(); await click("Delete account");
  expect(host.document.body.textContent).not.toContain("Cy Marsh: deleted");
  expect(host.document.body.textContent).not.toContain("Reactivate");
  await act(async () => root.render(<div />)); await mount();
  expect(host.document.body.textContent).toContain(state === "pending" ? "Deleting" : "Deletion unfinished");
  result = "completed";
  if (state === "pending") await act(async () => q('button[aria-expanded="false"]')!.click());
  await click("Finish deleting");
  expect(calls).toContain("POST /api/users/deletions/deletion/finish");
  expect(host.document.body.textContent).toContain("Cy Marsh: deleted");
  expect(host.document.body.textContent).not.toContain("Deletion unfinished");
});
it("shows only the pending row when the profile and reservation coexist", async () => {
  listed = [{ ...account, status: "deactivated" }]; entries = [{ id: "deletion", state: "pending", account }];
  await mount(); expect(host.document.querySelectorAll('button[aria-expanded="false"]')).toHaveLength(1);
  await act(async () => q('button[aria-expanded="false"]')!.click());
  expect(host.document.body.textContent).toContain("Finish deleting"); expect(host.document.body.textContent).not.toContain("Reactivate");
});
it("never turns a failed continuation into a completion notice", async () => {
  listed = []; entries = [{ id: "deletion", state: "needs-retry", account }];
  const ordinary = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/finish")
    ? Promise.resolve(Response.json({ error: { code: "internal", message: "Could not finish." } }, { status: 500 })) : ordinary(url, init)));
  await mount(); await click("Finish deleting");
  expect(host.document.body.textContent).not.toContain("Cy Marsh: deleted");
  expect(host.document.body.textContent).toContain("Deletion unfinished");
  expect(host.document.body.textContent).toContain("Could not finish.");
});

it("shows an unreadable deletion by identifier without hiding unrelated users", async () => {
  entries = [{ id: "stuck-deletion", state: "unreadable" }];
  await mount();
  expect(host.document.body.textContent).toContain("Deletion stuck-deletion cannot be read.");
  expect(host.document.body.textContent).toContain("Cy Marsh");
  const invite = host.document.querySelectorAll("button").find(value => value.textContent.trim() === "Invite")!;
  expect(invite.disabled).toBe(false);
  expect(host.document.body.textContent).not.toContain("Finish deleting");
});

describe("a pending deletion on the page", () => {
  let answers: Response[];
  const statusReads = () => calls.filter(call => call === "GET /api/users/deletions/deletion").length;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    listed = []; entries = [{ id: "deletion", state: "pending", account }]; answers = [];
    const ordinary = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/users/deletions/deletion" && (init?.method ?? "GET") === "GET") {
        calls.push(`GET ${url}`);
        return Promise.resolve(answers.shift() ?? Response.json({ id: "deletion", state: "pending" }));
      }
      return ordinary(url, init);
    }));
  });
  afterEach(() => { vi.useRealTimers(); });
  const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it("reads its status every few seconds and drops the row once the deletion has left", async () => {
    await mount();
    expect(host.document.body.textContent).toContain("Deleting");
    expect(statusReads()).toBe(0);
    await wait(3000);
    expect(statusReads()).toBe(1);
    expect(host.document.body.textContent).toContain("Deleting");
    // Finished on the server: its status is gone, and the list read again no longer holds it.
    entries = [];
    answers.push(Response.json({ error: { code: "not_found", message: "Deletion not found." } }, { status: 404 }));
    await wait(3000);
    expect(statusReads()).toBe(2);
    expect(calls.filter(call => call === "GET /api/users")).toHaveLength(2);
    expect(host.document.body.textContent).not.toContain("Deleting");
    expect(host.document.body.textContent).toContain("No one matches this search.");
    // Nothing pending: nothing more is read.
    await wait(9000);
    expect(statusReads()).toBe(2);
  });

  it("takes a deletion that now needs a retry into its unfinished state, and stops reading it", async () => {
    await mount();
    answers.push(Response.json({ id: "deletion", state: "needs-retry" }));
    await wait(3000);
    expect(host.document.body.textContent).toContain("Deletion unfinished");
    expect(host.document.body.textContent).toContain("Cy Marsh’s account could not be deleted completely.");
    await wait(9000);
    expect(statusReads()).toBe(1);
  });

  it("says on the row how many admitted reads a pending deletion still waits on, while there are any", async () => {
    await mount();
    const status = () => host.document.querySelector('[data-deletion="pending"]')?.textContent ?? "";
    answers.push(Response.json({ id: "deletion", state: "pending", admittedReads: 2 }));
    await wait(3000);
    expect(status()).toContain("Deleting · waiting on 2 reads");
    answers.push(Response.json({ id: "deletion", state: "pending", admittedReads: 1 }));
    await wait(3000);
    expect(status()).toContain("Deleting · waiting on 1 read");
    answers.push(Response.json({ id: "deletion", state: "pending", admittedReads: 0 }));
    await wait(3000);
    expect(status()).toContain("Deleting");
    expect(status()).not.toContain("waiting");
  });

  it("stops reading when the page goes away", async () => {
    await mount();
    await wait(3000);
    expect(statusReads()).toBe(1);
    await act(async () => root.render(<div />));
    await wait(9000);
    expect(statusReads()).toBe(1);
  });
});
