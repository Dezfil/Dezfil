import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AcceptPage from "@/app/(entry)/accept/page";
import ArrivePage from "@/app/(entry)/arrive/page";
import SignInPage from "@/app/(entry)/sign-in/page";
import { requirePasswordSignIn } from "@/lib/auth/external-sign-in/refusal";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { EntryScreen, LINKS_UNAVAILABLE } from "./EntryScreen";

/**
 * The entry screen on an instance with a sign-in service: the instance's
 * message, one action that leaves by a plain form post, no field and no
 * lost-password line, from the first paint. With the mode off the pages draw
 * today's screens, and the arrival page sends the browser to sign-in.
 */

const mode = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/auth/external-sign-in/config", () => ({ externalSignIn: () => ({ enabled: mode.enabled }) }));
vi.mock("@/components/theme", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ThemeToggle: () => null,
}));

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
let replaced: string[];
beforeEach(() => {
  mode.enabled = true; replaced = [];
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ instanceName: "Atlas", signInMessage: "Use your work account.", lostPasswordContact: "the GIS team", landingPage: "home", setupRequired: false, passwordMin: 8 })));
  host = installDomHost();
  Object.assign(host.window, { location: { origin: "https://dezfil.example", hash: "#secret=once", replace: (href: string) => { replaced.push(href); } } });
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});
async function open(element: React.ReactElement) {
  await act(async () => root.render(element));
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

describe("the entry screen in the mode", () => {
  it("shows the instance's message and one action, with no field and no lost-password line", async () => {
    await open(<EntryScreen mode="external" />);
    expect(container.querySelector("h1")?.textContent).toBe("Sign in");
    expect(container.textContent).toContain("Use your work account.");
    expect(container.textContent).toContain("Atlas");
    expect(container.querySelectorAll("input")).toEqual([]);
    expect(container.textContent).not.toContain("Forgot your password?");
    expect(container.querySelectorAll("button").map(button => button.textContent)).toEqual(["Continue to sign in"]);
    expect(replaced).toEqual([]);
  });

  it("starts by a plain form post to the start operation, which the browser follows to the service", async () => {
    await open(<EntryScreen mode="external" />);
    const form = container.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/auth/external/start");
    expect(container.querySelector("button")!.getAttribute("type")).toBe("submit");
  });

  it("keeps its one action when the entry read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "internal", message: "Unavailable." } }, { status: 500 })));
    await open(<EntryScreen mode="external" />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unavailable.");
    expect(container.querySelector("button")!.disabled).toBeFalsy();
  });
});

describe("the entry pages", () => {
  it("draw no field in the first paint of the sign-in page with the mode on, and the password form with it off", () => {
    const on = renderToStaticMarkup(SignInPage());
    expect(on).not.toContain("<input");
    expect(on).toContain('action="/api/auth/external/start"');
    expect(on).toContain("Continue to sign in");
    mode.enabled = false;
    const off = renderToStaticMarkup(SignInPage());
    expect(off).toContain('type="password"');
    expect(off).not.toContain("/api/auth/external/start");
  });

  it("tell an opened link it is unavailable, in the server's own sentence, before anyone types a password", () => {
    let refused = "";
    try { requirePasswordSignIn(); } catch (error) { refused = (error as Error).message; }
    expect(LINKS_UNAVAILABLE).toBe(refused);
    const on = renderToStaticMarkup(AcceptPage());
    expect(on).toContain(LINKS_UNAVAILABLE);
    expect(on).not.toContain("<input");
    mode.enabled = false;
    const off = renderToStaticMarkup(AcceptPage());
    expect(off).toContain("Choose your password");
    expect(off).not.toContain(LINKS_UNAVAILABLE);
  });

  it("send the arrival address to sign-in when the mode is off, and draw the arrival when it is on", () => {
    expect(renderToStaticMarkup(ArrivePage())).toContain("Signing you in");
    mode.enabled = false;
    expect(() => ArrivePage()).toThrow(/NEXT_REDIRECT/);
  });
});
