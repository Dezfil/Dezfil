import { type MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { AccountRailView } from "./AccountRail";
import { UserBadge } from "./UserBadge";
import { sectionFor } from "./NavLinks";

const controls = vi.hoisted(() => ({ signOut: undefined as ((event: MouseEvent<HTMLButtonElement>) => void) | undefined }));
vi.mock("./ui/IconButton", async original => {
  const { IconButton } = await original<typeof import("./ui/IconButton")>();
  return { IconButton: (props: Parameters<typeof IconButton>[0]) => {
    if (props.action === "Sign out") controls.signOut = props.onClick;
    return <IconButton {...props} />;
  } };
});
afterEach(() => vi.unstubAllGlobals());
vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));
const account = { id: "one", name: "Frida Merian", email: "frida@example.test", isAdmin: true } as Account;

describe("the account rail", () => {
  it("takes the avatar to the Account card and names the signed-in person", () => {
    const html = renderToStaticMarkup(<UserBadge account={account} />);
    expect(html).toContain('href="/settings#account"');
    expect(html).toContain('aria-label="Frida Merian, account"');
    expect(html).toContain("frida@example.test");
    expect(html).toContain(">FM<");
  });
  it("offers an independently named sign-out action without an account menu", () => {
    const html = renderToStaticMarkup(<UserBadge account={account} />);
    expect(html).toContain('aria-label="Sign out"');
    expect(html).not.toContain('role="menu"');
  });
  it("recognizes the Users destination for the breadcrumb and browser title", () => {
    expect(sectionFor("/users")).toMatchObject({ href: "/users", label: "Users" });
  });
  it("reveals Users only for a loaded admin beside Settings", () => {
    const admin = renderToStaticMarkup(<AccountRailView account={account} />);
    expect(admin).toContain('href="/users"');
    expect(admin.indexOf('href="/users"')).toBeLessThan(admin.indexOf('href="/settings"'));
    for (const value of [null, { ...account, isAdmin: false }]) {
      const html = renderToStaticMarkup(<AccountRailView account={value} />);
      expect(html).not.toContain('href="/users"');
      expect(html).toContain('href="/settings#account"');
      expect(html).toContain('aria-label="Sign out"');
    }
  });
  it("ends the session before a full navigation discards account state", async () => {
    const assign = vi.fn(), request = vi.fn(async () => Response.json({ signedOut: true }));
    vi.stubGlobal("fetch", request); vi.stubGlobal("window", { location: { assign } });
    renderToStaticMarkup(<UserBadge account={account} />);
    await controls.signOut?.({} as MouseEvent<HTMLButtonElement>);
    expect(request).toHaveBeenCalledWith("/api/auth/sign-out", { method: "POST", cache: "no-store" });
    expect(assign).toHaveBeenCalledWith("/sign-in");
  });
  it("keeps the current screen when the server refuses sign-out", async () => {
    const assign = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "unavailable", message: "Please try again." } }, { status: 503 })));
    vi.stubGlobal("window", { location: { assign } });
    renderToStaticMarkup(<UserBadge account={account} />);
    await controls.signOut?.({} as MouseEvent<HTMLButtonElement>);
    expect(assign).not.toHaveBeenCalled();
  });
});
