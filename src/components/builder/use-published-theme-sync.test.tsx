import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { usePublishedThemeSync } from "./use-published-theme-sync";

/**
 * The builder's light and dark flip, carried into a live publication's
 * theme, under who may publish. A theme is a change to a publication, so
 * while the instance's rule holds the person back the flip sends nothing
 * and no failure is raised (the publish popover says why); with no rule
 * holding them back, or no rule read, the flip is sent as it always was.
 * The runtime read and the account are fakes; the publication's request
 * is a spy.
 */

let rule: string | null;
let admin: boolean;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
const request = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ token: "t1" }));
const onFailure = vi.fn();
const onSuccess = vi.fn();

function Probe({ theme, publishToken }: { theme: "light" | "dark"; publishToken: string | null }) {
  usePublishedThemeSync({ request: request as unknown as typeof fetch, mapId: "m", publishToken, theme, onFailure, onSuccess });
  return null;
}

beforeEach(() => {
  rule = "everyone";
  admin = false;
  request.mockClear();
  onFailure.mockClear();
  onSuccess.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url === "/api/config") {
      return rule === null ? Response.json({ error: { code: "internal", message: "Unavailable." } }, { status: 500 })
        : Response.json({ rules: { "publishing.publish": rule } });
    }
    if (url === "/api/account") return Response.json({ account: { id: "a1", isAdmin: admin } });
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
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

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
/** Mounts in light, lets the reads answer, then flips to dark. */
async function flip(publishToken: string | null = "t1") {
  await act(async () => root.render(<Probe theme="light" publishToken={publishToken} />));
  await settle();
  await act(async () => root.render(<Probe theme="dark" publishToken={publishToken} />));
  await settle();
}
const sentThemes = () => request.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))]);

describe("a live publication's theme under who may publish", () => {
  it("sends the flip when the rule lets everyone publish", async () => {
    await flip();
    expect(sentThemes()).toEqual([["/api/maps/m/publish", { theme: "dark" }]]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("sends nothing and raises nothing for a member under Admins only", async () => {
    rule = "admins";
    await flip();
    expect(request).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("sends nothing and raises nothing for an admin under No one", async () => {
    rule = "none";
    admin = true;
    await flip();
    expect(request).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("sends the flip for an admin under Admins only", async () => {
    rule = "admins";
    admin = true;
    await flip();
    expect(sentThemes()).toEqual([["/api/maps/m/publish", { theme: "dark" }]]);
  });

  it("sends the flip when the rule could not be read", async () => {
    rule = null;
    await flip();
    expect(sentThemes()).toEqual([["/api/maps/m/publish", { theme: "dark" }]]);
  });

  it("sends a later flip once the rule lets the person through again on a fresh read", async () => {
    rule = "admins";
    await flip();
    expect(request).not.toHaveBeenCalled();
    // A fresh mount reads the rule anew.
    act(() => root.unmount());
    root = createRoot(container as unknown as Element);
    rule = "everyone";
    await flip();
    expect(sentThemes()).toEqual([["/api/maps/m/publish", { theme: "dark" }]]);
  });

  it("never sends for a map that is not published, under any rule", async () => {
    await flip(null);
    expect(request).not.toHaveBeenCalled();
  });
});
