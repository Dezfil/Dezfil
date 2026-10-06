import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingDefinition } from "@/lib/settings/catalogue";
import { disclosedDefinition } from "@/lib/settings/disclosure";
import { forgotLine } from "../auth/entry-settings";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { INSTANCE_NAME_EVENT } from "../shell/path-model";
import { GeneralTab } from "./GeneralTab";
import { UNDO_MS, FADE_MS } from "./save-unit";

/**
 * General: the Instance card and the Sign-in card on the configuration
 * read and its write for an admin, and the entry read's values, disabled,
 * for a member. The server is a fake that applies a write the way the
 * foundation does (an empty text or a null returns the default) and
 * answers with the whole read.
 */

const KEYS = ["instanceName", "signInMessage", "lostPasswordContact", "landingPage"] as const;
type Stored = Partial<Record<(typeof KEYS)[number], string | null>>;

function readOf(stored: Stored) {
  return {
    settings: Object.fromEntries(KEYS.map(key => {
      const definition = disclosedDefinition(settingDefinition(key));
      const value = stored[key] ?? definition.defaultValue;
      return [key, { ...definition, value, source: stored[key] == null ? "default" : "stored", storedValue: stored[key] ?? null, locked: false, invalidOverride: false }];
    })),
    capacities: { geocodeRows: 1000, isochroneOrigins: 50 }, maxImageDimension: 8192, version: "1.0.0", startedAt: "2026-10-07T00:00:00.000Z", warnings: [],
  };
}

let stored: Stored;
let requests: { url: string; method: string; body: unknown }[];
let failRead: boolean;
let renamed: (string | null)[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  stored = { instanceName: "Atlas", signInMessage: "Use your work email.", lostPasswordContact: "the GIS team.", landingPage: "maps" };
  requests = []; failRead = false; renamed = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url === "/api/instance/settings" && method === "GET") {
      return failRead ? Response.json({ error: { code: "internal", message: "Settings could not be read." } }, { status: 500 }) : Response.json(readOf(stored));
    }
    if (url === "/api/instance/settings" && method === "PATCH") {
      for (const [key, value] of Object.entries(body as Record<string, string | null>)) {
        stored[key as keyof Stored] = typeof value === "string" ? value.trim() || null : value;
      }
      return Response.json(readOf(stored));
    }
    if (url === "/api/auth/entry") {
      return Response.json({ instanceName: "Atlas", signInMessage: "Use your work email.", lostPasswordContact: "the GIS team", landingPage: "projects", setupRequired: false });
    }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  host = installDomHost();
  host.window.addEventListener(INSTANCE_NAME_EVENT, (event: unknown) => { renamed.push((event as CustomEvent<string | null>).detail); });
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
async function open(admin: boolean) {
  await act(async () => root.render(<GeneralTab admin={admin} />));
  await settle();
}
const card = (title: string) => container.querySelectorAll("section").find(section => section.querySelector("h2")?.textContent === title)!;
function field(scope: HostElement, label: string): HostElement {
  const tag = scope.querySelectorAll("label").find(element => element.textContent === label)!;
  return scope.querySelector(`[id="${tag.getAttribute("for")}"]`)!;
}
/** A select's chosen value as rendered: the host keeps no single selection of its own. */
const chosen = (scope: HostElement, label: string) => (props(field(scope, label)) as unknown as { value: string }).value;
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const type = (scope: HostElement, label: string, text: string) => act(async () => props(field(scope, label)).onChange({ target: { value: text } }));
const buttons = (scope: HostElement) => scope.querySelectorAll("button").map(button => button.textContent);
const press = (scope: HostElement, label: string) => act(async () => { scope.querySelectorAll("button").find(button => button.textContent === label)!.click(); });
const submit = (scope: HostElement) => act(async () => { scope.querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
const writes = () => requests.filter(request => request.method === "PATCH").map(request => request.body);
const statuses = (scope: HostElement) => scope.querySelectorAll('[role="status"]').map(element => element.textContent);

describe("the sign-in page's forgot line", () => {
  it("names the contact without its trailing period, or keeps the built-in line", () => {
    expect(forgotLine("the GIS team at gis@example.org.")).toBe("Forgot your password? Ask the GIS team at gis@example.org.");
    expect(forgotLine("  an admin  ")).toBe("Forgot your password? Ask an admin.");
    expect(forgotLine("")).toBe("Forgot your password? An admin can reset it.");
    expect(forgotLine(null)).toBe("Forgot your password? An admin can reset it.");
  });
});

describe("General, for an admin", () => {
  it("draws the four fields from the configuration read, the contact's line following the typing", async () => {
    await open(true);
    expect(requests.map(request => request.url)).toEqual(["/api/instance/settings"]);
    const instance = card("Instance"), signIn = card("Sign-in");
    expect(field(instance, "Instance name").value).toBe("Atlas");
    expect(field(signIn, "Message").value).toBe("Use your work email.");
    expect(field(signIn, "Lost password contact").value).toBe("the GIS team.");
    expect(chosen(signIn, "Landing page")).toBe("maps");
    expect(field(signIn, "Landing page").querySelectorAll("option").map(option => option.textContent))
      .toEqual(["Home", "Projects", "Maps", "Workflows", "Data", "SQL"]);
    expect(signIn.textContent).toContain("Shown as “Forgot your password? Ask the GIS team.”");
    await type(signIn, "Lost password contact", "Ravi in IT");
    expect(signIn.textContent).toContain("Shown as “Forgot your password? Ask Ravi in IT.”");
    await type(signIn, "Lost password contact", "");
    expect(signIn.textContent).toContain("Shown as “Forgot your password? An admin can reset it.”");
    expect(buttons(instance)).not.toContain("Reset to defaults");
  });

  it("saves the instance name on Save, then updates the chip and the title from the response", async () => {
    await open(true);
    const instance = card("Instance");
    expect(buttons(instance)).not.toContain("Save");
    await type(instance, "Instance name", "  Atlas North ");
    expect(buttons(instance)).toEqual(expect.arrayContaining(["Save", "Cancel"]));
    await submit(instance);
    await settle();
    expect(writes()).toEqual([{ instanceName: "  Atlas North " }]);
    expect(renamed).toEqual(["Atlas North"]);
    expect(field(instance, "Instance name").value).toBe("Atlas North");
    expect(statuses(instance)).toEqual(["Saved"]);
    expect(buttons(instance)).not.toContain("Save");
  });

  it("keeps a landing page as it is chosen, with Saved after the response", async () => {
    await open(true);
    const signIn = card("Sign-in");
    await act(async () => props(field(signIn, "Landing page")).onChange({ target: { value: "sql" } }));
    await settle();
    expect(writes()).toEqual([{ landingPage: "sql" }]);
    expect(statuses(signIn)).toEqual(["Saved"]);
    expect(buttons(signIn)).not.toContain("Save");
  });

  it("writes the message and contact together on Save", async () => {
    await open(true);
    const signIn = card("Sign-in");
    await type(signIn, "Message", "Line one\nLine two");
    await type(signIn, "Lost password contact", "Ravi in IT");
    await submit(signIn);
    await settle();
    expect(writes()).toEqual([{ signInMessage: "Line one\nLine two", lostPasswordContact: "Ravi in IT" }]);
  });

  it("resets the Sign-in card to no message, the built-in line and Home in one write, with Undo", async () => {
    await open(true);
    const signIn = card("Sign-in");
    expect(buttons(signIn)).toContain("Reset to defaults");
    await press(signIn, "Reset to defaults");
    await settle();
    expect(writes()).toEqual([{ signInMessage: null, lostPasswordContact: null, landingPage: null }]);
    expect(field(signIn, "Message").value).toBe("");
    expect(field(signIn, "Lost password contact").value).toBe("");
    expect(chosen(signIn, "Landing page")).toBe("home");
    expect(buttons(signIn)).toContain("Undo");
    expect(buttons(signIn)).not.toContain("Reset to defaults");
    await press(signIn, "Undo");
    await settle();
    expect(writes()[1]).toEqual({ signInMessage: "Use your work email.", lostPasswordContact: "the GIS team.", landingPage: "maps" });
    expect(chosen(signIn, "Landing page")).toBe("maps");
    expect(buttons(signIn)).toContain("Reset to defaults");
  });

  it("lets Undo go after six seconds, and shows no Reset once the card is at its defaults", async () => {
    stored = { instanceName: null, signInMessage: null, lostPasswordContact: null, landingPage: "workflows" };
    await open(true);
    const signIn = card("Sign-in");
    vi.useFakeTimers();
    await press(signIn, "Reset to defaults");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(buttons(signIn)).toContain("Undo");
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS + FADE_MS); });
    expect(buttons(signIn)).not.toContain("Undo");
    expect(buttons(signIn)).not.toContain("Reset to defaults");
  });

  it("draws a failed read as the error note with Try again", async () => {
    failRead = true;
    await open(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Settings could not be read.");
    expect(container.querySelectorAll("input")).toEqual([]);
    failRead = false;
    await press(container, "Try again");
    await settle();
    expect(field(card("Instance"), "Instance name").value).toBe("Atlas");
  });
});

describe("General, for a member", () => {
  it("shows the four values disabled from the entry read, with one sentence per card and nothing to save or reset", async () => {
    await open(false);
    expect(requests.map(request => request.url)).toEqual(["/api/auth/entry"]);
    const instance = card("Instance"), signIn = card("Sign-in");
    expect(field(instance, "Instance name").value).toBe("Atlas");
    expect(field(signIn, "Message").value).toBe("Use your work email.");
    expect(field(signIn, "Lost password contact").value).toBe("the GIS team");
    expect(chosen(signIn, "Landing page")).toBe("projects");
    for (const label of ["Message", "Lost password contact", "Landing page"]) expect(field(signIn, label).disabled).toBe(true);
    expect(field(instance, "Instance name").disabled).toBe(true);
    expect(instance.textContent).toContain("Only admins can change the instance name.");
    expect(signIn.textContent).toContain("Only admins can change the sign-in settings.");
    expect([...buttons(instance), ...buttons(signIn)]).toEqual([]);
  });
});
