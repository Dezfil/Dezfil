import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { AccountTab } from "./AccountTab";

/**
 * Account follows the sign-in mode the configuration read reports, and draws
 * no field until it knows it. A read that fails says so, with its retry, and offers
 * nothing the mode might refuse.
 */

const ADA: Account = {
  id: "ada", name: "Ada Okafor", email: "ada@example.test", sqlName: "ada_okafor", isAdmin: false, status: "active",
  isOriginal: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastSignInAt: null,
};
let held: ((value: Response | Promise<Response>) => void)[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
beforeEach(async () => {
  held = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/config" ? new Promise<Response>(resolve => held.push(resolve)) : Promise.resolve(Response.json({}))));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(<AccountTab account={ADA} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const answer = async (response: Response) => { await act(async () => { for (const resolve of held.splice(0)) resolve(response); }); await settle(); };

it("draws no field and no password until the mode is known", () => {
  expect(container.querySelectorAll("input")).toEqual([]);
  expect(container.textContent).toBe("Loading…");
});

it("draws the card without a password in the mode", async () => {
  await answer(Response.json({ externalSignIn: { enabled: true } }));
  expect(container.textContent).toContain("Your email comes from the sign-in service.");
  expect(container.querySelector("details")).toBeNull();
});

it("draws the card with its Change password with the mode off", async () => {
  await answer(Response.json({ externalSignIn: { enabled: false } }));
  expect(container.querySelector("details")?.querySelector("summary")?.textContent).toBe("Change password");
  expect(container.textContent).not.toContain("sign-in service");
});

describe("while the mode cannot be read", () => {
  const offersNothing = () => {
    expect(container.querySelectorAll("input")).toEqual([]);
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("Change password");
  };
  const retry = () => act(async () => { container.querySelectorAll("button").find(button => button.textContent === "Try again")!.click(); });

  it("says so in the server's words, with its retry, and offers no field or password", async () => {
    await answer(Response.json({ error: { code: "internal", message: "The configuration could not be read." } }, { status: 500 }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The configuration could not be read.");
    offersNothing();
  });

  it("says so when the server cannot be reached", async () => {
    await act(async () => { for (const settle of held.splice(0)) settle(Promise.reject(new TypeError("Failed to fetch"))); });
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    offersNothing();
  });

  it("treats an answer that does not say the mode as unread", async () => {
    await answer(Response.json({ passwordMin: 8 }));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    offersNothing();
  });

  it("draws the card the mode calls for once the retry reads it", async () => {
    await answer(Response.json({ error: { code: "internal", message: "No." } }, { status: 500 }));
    await retry();
    offersNothing();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await answer(Response.json({ externalSignIn: { enabled: true } }));
    expect(container.textContent).toContain("Your email comes from the sign-in service.");
    expect(container.querySelector("details")).toBeNull();
  });
});
