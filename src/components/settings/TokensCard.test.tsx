import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiToken } from "@/lib/metadata/auth-credentials";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { TokensCard } from "./TokensCard";

/**
 * The Tokens card with expiries: each token's meta line says when it
 * expires and Expired once it has, beside Last used, Never used and
 * Revoked; beside Create, one quiet line says how long a new token lasts,
 * and nothing under Never. The token routes and the runtime read are
 * fakes; the clock is fixed.
 */

const now = Date.parse("2026-10-08T12:00:00Z");
const day = (iso: string) => new Date(iso).toLocaleDateString();
const token = (id: string, fields: Partial<ApiToken>): ApiToken =>
  ({ id, name: id, createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: null, revokedAt: null, expiresAt: null, ...fields });

let tokens: ApiToken[];
let config: { status: number; body: unknown };
let created: ApiToken & { secret: string };
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  tokens = [];
  config = { status: 200, body: { rules: { "tokens.expiry": "never" } } };
  created = { ...token("t-new", { name: "Agent", expiresAt: "2026-11-07T12:00:00.000Z" }), secret: "dz_token_fixture-once" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/config") return Response.json(config.body, { status: config.status });
    if (url === "/api/account/tokens" && init.method === "POST") return Response.json(created, { status: 201 });
    if (url === "/api/account/tokens") return Response.json({ tokens });
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
  vi.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function open() {
  await act(async () => root.render(<TokensCard />));
  await settle();
}
/** Each listed token's name, meta line and whether it offers Revoke. */
const rows = () => container.querySelectorAll("li").map(item => [
  item.querySelector("strong")?.textContent, item.querySelector("span")?.textContent,
  item.querySelectorAll("button").some(button => button.textContent === "Revoke")]);
const notes = () => container.querySelectorAll("p").map(p => p.textContent);

describe("each token's expiry", () => {
  it("is in its meta line beside its use, Expired once passed and still revocable, and Revoked first", async () => {
    tokens = [
      token("live", { lastUsedAt: "2026-10-01T09:00:00.000Z", expiresAt: "2026-11-07T12:00:00.000Z" }),
      token("unused", { expiresAt: "2026-10-08T12:00:01.000Z" }),
      token("forever", { lastUsedAt: "2026-10-02T09:00:00.000Z" }),
      token("expired", { lastUsedAt: "2026-09-02T09:00:00.000Z", expiresAt: "2026-10-08T12:00:00.000Z" }),
      token("revoked", { expiresAt: "2026-09-30T00:00:00.000Z", revokedAt: "2026-09-15T00:00:00.000Z" }),
    ];
    await open();
    expect(rows()).toEqual([
      ["live", `Last used ${day("2026-10-01T09:00:00.000Z")} · Expires ${day("2026-11-07T12:00:00.000Z")}`, true],
      ["unused", `Never used · Expires ${day("2026-10-08T12:00:01.000Z")}`, true],
      ["forever", `Last used ${day("2026-10-02T09:00:00.000Z")}`, true],
      ["expired", `Expired ${day("2026-10-08T12:00:00.000Z")}`, true],
      ["revoked", "Revoked", false],
    ]);
  });

  it("shows on a token just created", async () => {
    await open();
    const label = container.querySelectorAll("label").find(element => element.textContent === "Token name")!;
    const input = container.querySelector(`[id="${label.getAttribute("for")}"]`)!;
    const key = Object.keys(input).find(name => name.startsWith("__reactProps$"))!;
    await act(async () => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key].onChange({ target: { value: "Agent" } }));
    await act(async () => { container.querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
    await settle();
    expect(rows()).toEqual([["Agent", `Never used · Expires ${day("2026-11-07T12:00:00.000Z")}`, true]]);
  });
});

describe("the line beside Create", () => {
  it.each([["30d", "30 days"], ["90d", "90 days"], ["1y", "1 year"]])("says how long a new token lasts under %s", async (expiry, words) => {
    config = { status: 200, body: { rules: { "tokens.expiry": expiry } } };
    await open();
    expect(notes()).toContain(`New tokens expire after ${words}.`);
  });

  it("says nothing under Never, and nothing while the runtime read is refused", async () => {
    await open();
    expect(container.textContent).not.toContain("New tokens expire");
    act(() => root.unmount());
    root = createRoot(container as unknown as Element);
    config = { status: 500, body: { error: { code: "internal", message: "Unavailable." } } };
    await open();
    expect(container.textContent).not.toContain("New tokens expire");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(notes()).toContain("No tokens yet.");
  });
});
