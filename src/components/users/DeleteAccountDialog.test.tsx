import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import type { DeletionPreview } from "@/lib/auth/account-deletion-preview";
import { DeleteAccountDialog } from "./DeleteAccountDialog";
let host: ReturnType<typeof installDomHost>, root: ReturnType<typeof createRoot>;
let value: DeletionPreview, calls: string[], refusal: string | null;
const done = vi.fn();
beforeEach(() => {
  host = installDomHost(); const container = host.document.createElement("div"); host.document.body.appendChild(container); root = createRoot(container as unknown as Element);
  calls = []; refusal = null; done.mockClear();
  value = { account: { id: "target", name: "Cy Marsh", email: "cy@example.test" }, invited: false,
    totals: { maps: 2, datasets: 3, workflows: 1, projects: 1, connections: 0, publishedLinks: 1 }, people: 2, confirmation: "a".repeat(64) };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "DELETE") {
      expect(JSON.parse(init.body as string)).toEqual({ confirm: true, confirmation: value.confirmation, ...(value.invited ? {} : { email: value.account.email }) });
      return refusal ? Response.json({ error: { code: refusal, message: "Review a fresh deletion preview." } }, { status: 409 }) : Response.json({ id: "deletion", state: "pending" }, { status: 202 });
    }
    return Response.json(value);
  }));
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.unstubAllGlobals(); });
function Harness() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Opener</button>{open && <DeleteAccountDialog account={value.account}
    onClose={() => setOpen(false)} onDone={done} />}</>;
}
const q = (selector: string) => host.document.querySelector(selector);
const button = (label: string) => host.document.querySelectorAll("button").find(b => b.textContent === label)!;
const click = (label: string) => act(async () => { button(label).click(); });
async function open() { await act(async () => root.render(<Harness />)); button("Opener").focus(); await click("Opener"); }
async function type(text: string) {
  const input = q('input[aria-label="The account\'s email"]')!;
  const key = Object.keys(input).find(key => key.startsWith("__reactProps$"))!;
  await act(async () => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key].onChange({ target: { value: text } }));
}
function key(key: string, shiftKey = false) {
  return act(async () => host.document.dispatchEvent(Object.assign(new HostEvent("keydown", { bubbles: true, cancelable: true }), { key, shiftKey })));
}
it("uses counts and consequence copy only and arms on the exact email", async () => {
  await open(); const text = q('[role="dialog"]')!.textContent;
  for (const copy of ["2 maps", "3 datasets", "1 workflow", "1 project", "1 published link", "2 other people", "This cannot be undone.", "To keep this person's work for the team, leave the account deactivated."]) expect(text).toContain(copy);
  expect(text).not.toContain("0 connections"); expect(text).not.toMatch(/private project|roster|receiver|—/i);
  expect(button("Delete account").disabled).toBe(true);
  for (const email of ["CY@example.test", "cy@example.test ", ""]) { await type(email); expect(button("Delete account").disabled).toBe(true); }
  await type(value.account.email); expect(button("Delete account").disabled).toBe(false);
  expect(button("Delete account").getAttribute("data-variant")).toBe("danger");
  await click("Delete account"); expect(done).toHaveBeenCalledExactlyOnceWith({ id: "deletion", state: "pending" });
});
it("omits totals, people and the keep-work line for an empty ever-active account", async () => {
  value.totals = { maps: 0, datasets: 0, workflows: 0, projects: 0, connections: 0, publishedLinks: 0 }; value.people = 0;
  await open(); const text = q('[role="dialog"]')!.textContent;
  expect(text).toContain("The account owns nothing"); expect(text).toContain("This cannot be undone.");
  expect(q('[data-deletion-totals]')).toBeNull(); expect(text).not.toContain("other people"); expect(text).not.toContain("leave the account deactivated");
  expect(button("Delete account").disabled).toBe(true);
});
it("removes a never-used invitation with one sentence and no typed email", async () => {
  value.invited = true; await open();
  expect(q('[role="dialog"]')!.textContent).toContain("Cy Marsh never signed in, so only the invitation is removed.");
  expect(q("input")).toBeNull(); expect(q('[data-deletion-totals]')).toBeNull();
  expect(q('[role="dialog"]')!.textContent).not.toContain("cannot be undone");
  expect(button("Delete account").disabled).toBe(false); await click("Delete account"); expect(done).toHaveBeenCalledOnce();
});
it("requires a fresh preview and new typing after a stale refusal", async () => {
  refusal = "deletion_changed"; await open(); await type(value.account.email); await click("Delete account");
  expect(done).not.toHaveBeenCalled(); expect(button("Delete account").disabled).toBe(true);
  expect(q('[role="alert"]')!.textContent).toContain("Review a fresh deletion preview");
  value.confirmation = "b".repeat(64); value.totals.maps = 4; refusal = null;
  await click("Review again"); expect(q('[role="dialog"]')!.textContent).toContain("4 maps");
  expect(button("Delete account").disabled).toBe(true); await type(value.account.email); await click("Delete account");
  expect(calls.filter(call => call.startsWith("GET"))).toHaveLength(2); expect(done).toHaveBeenCalledOnce();
});
it.each(["Cancel", "Escape"])("%s restores a live connected opener without mutation", async how => {
  await open(); const opener = button("Opener"), inertWhenAsked: boolean[] = [], connectedWhenAsked: boolean[] = [];
  const focus = opener.focus.bind(opener); opener.focus = () => { inertWhenAsked.push(opener.closest("[inert]") !== null); connectedWhenAsked.push(opener.isConnected); focus(); };
  expect(host.document.activeElement).toBe(q('[role="dialog"]')); expect(opener.closest("[inert]")).not.toBeNull();
  if (how === "Cancel") await click(how); else await key("Escape");
  expect(q('[role="dialog"]')).toBeNull(); expect(host.document.activeElement).toBe(opener);
  expect(inertWhenAsked).toEqual([false]); expect(connectedWhenAsked).toEqual([true]); expect(calls.some(c => c.startsWith("DELETE"))).toBe(false);
});
it("contains Tab and Shift+Tab among the armed controls", async () => {
  await open(); await type(value.account.email);
  const first = q("input") as HostElement, last = button("Delete account");
  // The small DOM host has no layout or pseudo-selector engine. Supply the
  // real dialog's enabled stops; the browser journey proves actual tab order.
  const card = q('[role="dialog"]')!;
  card.querySelectorAll = () => [first, button("Cancel"), last];
  last.focus(); await key("Tab"); expect(host.document.activeElement).toBe(first);
  first.focus(); await key("Tab", true); expect(host.document.activeElement).toBe(last);
});
it("routes an already accepted preview to the pending surface without another DELETE", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "already", state: "needs-retry" })));
  await open(); expect(done).toHaveBeenCalledExactlyOnceWith({ id: "already", state: "needs-retry" });
});
it("keeps a failed preview unarmed until a successful review", async () => {
  const ordinary = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "internal", message: "Preview unavailable." } }, { status: 500 })));
  await open(); expect(button("Delete account").disabled).toBe(true); expect(q('[role="alert"]')!.textContent).toContain("Preview unavailable.");
  vi.stubGlobal("fetch", ordinary); await click("Review again");
  expect(button("Delete account").disabled).toBe(true); await type(value.account.email);
  expect(button("Delete account").disabled).toBe(false);
});
it("does not dismiss or duplicate an in-flight deletion", async () => {
  let settle!: (response: Response) => void;
  const ordinary = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => init?.method === "DELETE"
    ? new Promise<Response>(resolve => { settle = resolve; }) : ordinary(url, init)));
  await open(); await type(value.account.email); await click("Delete account");
  await key("Escape"); expect(q('[role="dialog"]') !== null).toBe(true);
  expect(button("Cancel").disabled).toBe(true); expect(button("Delete account").disabled).toBe(true);
  expect(done).not.toHaveBeenCalled();
  await act(async () => settle(Response.json({ id: "deletion", state: "pending" }, { status: 202 })));
  expect(done).toHaveBeenCalledExactlyOnceWith({ id: "deletion", state: "pending" });
});
