import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingDefinition } from "@/lib/settings/catalogue";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { instanceReadFixture, type Resolution } from "./read-fixture";
import { SystemTab } from "./SystemTab";

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => <a href={href} className={className}>{children}</a>,
}));

/**
 * System: the Status card from the configuration read and the health
 * read the rail's dot uses, the read-only Assistant card from the
 * assistant's status read, and the Server settings table. The reads are
 * faked; nothing here reaches a server.
 */

let resolved: Record<string, Resolution>;
let health: number;
let assistant: unknown;
let failRead: boolean;
let requests: string[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-07T09:30:00.000Z"));
  resolved = { dataDir: { value: "/data", source: "environment", locked: true } };
  health = 200; failRead = false; requests = [];
  assistant = { enabled: true, provider: "anthropic", model: "claude-opus-5", models: [], catalogue: {}, stepBudget: 20, autoCheck: true };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(url);
    if (url === "/api/instance/settings") {
      return failRead ? Response.json({ error: { code: "internal", message: "Settings could not be read." } }, { status: 500 })
        : Response.json(instanceReadFixture(resolved, { version: "0.4.2", startedAt: "2026-10-04T09:00:00.000Z" }));
    }
    if (url === "/api/health") return health === 200 ? Response.json({ status: "ready" }) : Response.json({ status: "unready", reason: "Internal error." }, { status: 503 });
    if (url === "/api/assistant") return Response.json(assistant);
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
  await act(async () => root.render(<SystemTab />));
  await settle();
}
const titles = () => container.querySelectorAll("section").map(section => section.querySelector("h2")!.textContent);
const card = (title: string) => container.querySelectorAll("section").find(section => section.querySelector("h2")?.textContent === title)!;
const byId = (id: string) => container.querySelector(`[id="${id}"]`)!;
const cells = (id: string) => byId(id).querySelectorAll("td").map(cell => cell.textContent);
const press = (scope: HostElement, label: string) => act(async () => { scope.querySelectorAll("button").find(button => button.textContent === label)!.click(); });

describe("System", () => {
  it("draws Status, then the Assistant, then the Server settings, with no Storage card and no Test", async () => {
    await open();
    expect(titles()).toEqual(["Status", "Assistant", "Server settings"]);
    // Nothing to press: no Test, no cleanup, no Reset.
    expect(container.querySelectorAll("button").map(button => button.textContent)).toEqual([]);
  });

  it("shows the version with the running time, and the data folder's path with its state from the health read", async () => {
    await open();
    expect(requests).toContain("/api/health");
    expect(byId("sys-version").textContent).toBe("Version0.4.2Running for 3 days");
    expect(byId("sys-data-folder").textContent).toBe("Data folder/dataWritable");
  });

  it("says the data folder is not writable when the health read says the instance is not ready", async () => {
    health = 503;
    await open();
    expect(byId("sys-data-folder").textContent).toBe("Data folder/dataNot writable");
  });

  it("shows the assistant on with its provider as a chip, and no key, model or access choice", async () => {
    await open();
    const assistantCard = card("Assistant");
    expect(byId("sys-assistant-status").textContent).toBe("StatusOn");
    expect(byId("sys-assistant-provider").textContent).toBe("ProviderAnthropic");
    expect(assistantCard.textContent).not.toMatch(/claude-opus-5|key|Model/i);
    for (const control of ["input", "select", "button"]) expect(assistantCard.querySelectorAll(control)).toEqual([]);
  });

  it("shows the assistant off with the reason the status read gives", async () => {
    assistant = { enabled: false, reason: "No model credential is configured." };
    await open();
    expect(byId("sys-assistant-status").textContent).toBe("StatusOffNo model credential is configured.");
    expect(byId("sys-assistant-provider").textContent).toBe("ProviderNone");
  });

  it("lists the server's settings with the variable, the disclosed value and where it came from, linking a stored limit to its row", async () => {
    resolved = { ...resolved,
      queryTimeoutS: { value: 90, source: "stored", storedValue: 90 },
      operationConcurrency: { value: 2, source: "environment", locked: true },
      geocoderUrl: { value: { set: true, origin: "https://geocoder.example" }, source: "environment", locked: true },
      anthropicApiKey: { value: { set: true }, source: "environment", locked: true },
    };
    await open();
    const settings = card("Server settings");
    expect(settings.textContent).toContain("Values from the environment change when the server restarts.");
    expect(settings.querySelectorAll("th").map(cell => cell.textContent)).toEqual(["Setting", "Variable", "Value", "Source"]);
    expect(cells("env-dezfil-query-timeout-s")).toEqual(["Query time limit", "DEZFIL_QUERY_TIMEOUT_S", "90 seconds", "Limits"]);
    expect(byId("env-dezfil-query-timeout-s").querySelector("a")?.getAttribute("href")).toBe("/settings/limits#set-query-time");
    expect(cells("env-dezfil-operation-concurrency")).toEqual(["Tools running at once", "DEZFIL_OPERATION_CONCURRENCY", "2 runs", "Environment"]);
    expect(cells("env-dezfil-geocoder-url")).toEqual(["Address finder", "DEZFIL_GEOCODER_URL", "https://geocoder.example", "Environment"]);
    // A model credential's variable is named only by the server's code: the definition supplies it here.
    expect(cells("env-anthropic-api-key")).toEqual(["Anthropic credential", settingDefinition("anthropicApiKey").environment, "Set", "Environment"]);
    expect(cells("env-dezfil-remote-max-mb")).toEqual(["Largest link import", "DEZFIL_REMOTE_MAX_MB", "2,048 MB", "Default"]);
  });

  it("draws a failed read as the error note with Try again", async () => {
    failRead = true;
    await open();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Settings could not be read.");
    failRead = false;
    await press(container, "Try again");
    await settle();
    expect(titles()).toEqual(["Status", "Assistant", "Server settings"]);
  });
});
