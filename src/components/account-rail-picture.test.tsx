import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { openPrivateState } from "./auth/private-state";
import { AccountRail } from "./AccountRail";
import { DISPLAY_NAME_EVENT } from "./UserBadge";

/**
 * The side menu's face follows the account without a reload: a picture
 * set or removed on the Account card sends the account event, the rail
 * reads the account again and draws what it says, the new picture's
 * address or the initials alone.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/maps" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const FRIDA = {
  id: "one", name: "Frida Merian", email: "frida@example.test", sqlName: "frida_merian", isAdmin: false, status: "active",
  isOriginal: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastSignInAt: null,
} satisfies Account;

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
let served: Account;
beforeEach(() => {
  openPrivateState("one");
  served = FRIDA;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ account: served })));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const pictures = () => container.querySelectorAll("img").map(img => img.getAttribute("src"));

it("draws a picture set, replaced and removed elsewhere as soon as the account event says so", async () => {
  await act(async () => root.render(<AccountRail />));
  await settle();
  expect(container.querySelector("[data-face]")?.textContent).toBe("FM");
  expect(pictures()).toEqual([]);

  served = { ...FRIDA, pictureVersion: "p1" };
  await act(async () => { window.dispatchEvent(new CustomEvent(DISPLAY_NAME_EVENT, { detail: FRIDA.name })); });
  await settle();
  expect(pictures()).toEqual(["/api/accounts/frida_merian/picture?v=p1"]);

  served = { ...FRIDA, pictureVersion: "p2" };
  await act(async () => { window.dispatchEvent(new CustomEvent(DISPLAY_NAME_EVENT, { detail: FRIDA.name })); });
  await settle();
  expect(pictures()).toEqual(["/api/accounts/frida_merian/picture?v=p2"]);

  served = FRIDA;
  await act(async () => { window.dispatchEvent(new CustomEvent(DISPLAY_NAME_EVENT, { detail: FRIDA.name })); });
  await settle();
  expect(pictures()).toEqual([]);
  expect(container.querySelector("[data-face]")?.textContent).toBe("FM");
});
