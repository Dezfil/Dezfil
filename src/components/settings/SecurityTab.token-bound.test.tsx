import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { changeInstanceSettings } from "@/lib/settings/change";
import { readInstanceSettings } from "@/lib/settings/read";
import { writeStoredSettings } from "@/lib/settings/store";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { SecurityTab } from "./SecurityTab";

/**
 * New tokens expire after, under the longest token lifetime: the select draws
 * what the configuration read offers, at the value it reports. The read and
 * the write here are the server's own over a scratch store, reached through
 * the wire's JSON, so the offer is not this file's opinion of it.
 */

const LABEL = "New tokens expire after";

let fixture: ReturnType<typeof instanceSettingsFixture>;
let writes: unknown[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  fixture = instanceSettingsFixture();
  writes = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url !== "/api/instance/settings") throw new Error(`Unexpected ${url}`);
    if ((init.method ?? "GET") === "GET") return Response.json(readInstanceSettings(fixture.context, fixture.db));
    const body = JSON.parse(String(init.body));
    writes.push(body);
    try { return Response.json(changeInstanceSettings(fixture.context, body, fixture.db)); }
    catch (refusal) {
      if (!(refusal instanceof ApiError)) throw refusal;
      return Response.json({ error: { code: refusal.code, message: refusal.message } }, { status: refusal.status });
    }
  }));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  fixture.close();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function open(stored: Record<string, string>) {
  writeStoredSettings(stored, fixture.db);
  await act(async () => root.render(<SecurityTab />));
  await settle();
}
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const select = () => container.querySelectorAll("select").find(element => element.getAttribute("aria-label") === LABEL)!;
const options = () => select().querySelectorAll("option").map(option => option.getAttribute("value"));
const chosen = () => (props(select()) as unknown as { value: string }).value;
const resets = () => container.querySelectorAll("[data-unit-slot]").map(button => button.textContent);
const press = (label: string) => act(async () => { container.querySelectorAll("button").find(button => button.textContent === label)!.click(); });

describe("the token lifetime select under its bound", () => {
  it("offers every choice with no bound", async () => {
    await open({});
    expect(options()).toEqual(["never", "30d", "90d", "1y"]);
    expect(chosen()).toBe("never");
  });

  it.each([
    ["30d", ["30d"]],
    ["90d", ["30d", "90d"]],
    ["1y", ["30d", "90d", "1y"]],
  ])("offers only what the read offers under %s, and never Never", async (bound, offered) => {
    await open({ tokenLifetimeMax: bound });
    expect(options()).toEqual(offered);
    expect(chosen()).toBe(bound);
  });

  it.each(["1y", "never"])("reads a stored %s as the bound", async stored => {
    await open({ tokenLifetimeMax: "90d", "tokens.expiry": stored });
    expect(options()).toEqual(["30d", "90d"]);
    expect(chosen()).toBe("90d");
  });

  it("keeps a stored choice inside the bound", async () => {
    await open({ tokenLifetimeMax: "90d", "tokens.expiry": "30d" });
    expect(chosen()).toBe("30d");
  });

  it("keeps a choice inside the offer through the server's own write", async () => {
    await open({ tokenLifetimeMax: "90d" });
    await act(async () => props(select()).onChange({ target: { value: "30d" } }));
    await settle();
    expect(writes).toEqual([{ "tokens.expiry": "30d" }]);
    expect(chosen()).toBe("30d");
  });

  it("offers no Reset when the read reports nothing but the bound", async () => {
    await open({ tokenLifetimeMax: "30d" });
    expect(resets()).toEqual([]);
  });

  it("resets the card's other rule without writing the bound back as a choice on Undo", async () => {
    await open({ tokenLifetimeMax: "30d", "tokens.create": "admins" });
    expect(resets()).toEqual(["Reset to defaults"]);
    await press("Reset to defaults");
    await settle();
    expect(writes).toEqual([{ "tokens.create": null, "tokens.expiry": null }]);
    expect(chosen()).toBe("30d");
    await press("Undo");
    await settle();
    expect(writes[1]).toEqual({ "tokens.create": "admins" });
    expect(chosen()).toBe("30d");
  });
});
