import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { instanceReadFixture, storageReadFixture } from "./read-fixture";
import type { InstanceRead } from "./instance-read";
import { shownValue } from "./system-table";
import { SystemTab } from "./SystemTab";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

/**
 * System's External sign-in card: on or off from the configuration read and,
 * while on, the service's address, how many keys and both generations. The
 * read carries no key, and the Server settings table's row says the count
 * rather than reading as unset. The reads are faked.
 */

const ON = { enabled: true, keyCount: 2, signOutGeneration: 3, doorGeneration: 7 };
let read: InstanceRead;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  read = instanceReadFixture({
    externalSignInUrl: { value: "https://sign-in.example.test/dezfil", source: "environment", locked: true },
    externalSignInKeys: { value: { count: 2 }, source: "environment", locked: true },
  }, { externalSignIn: ON });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/instance/settings") return Response.json(read);
    if (url === "/api/instance/storage") return Response.json(storageReadFixture());
    if (url === "/api/assistant") return Response.json({ enabled: false, reason: "No model key is set." });
    return Response.json({ status: "ready" });
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

async function open() {
  await act(async () => root.render(<SystemTab />));
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
const titles = () => container.querySelectorAll("section").map(section => section.querySelector("h2")!.childNodes[0]?.textContent);
const card = () => container.querySelectorAll("section").find(section => section.querySelector("h2")?.textContent === "External sign-in")!;
const rows = () => card().descendants().filter(element => element.getAttribute("id")?.startsWith("sys-external-") && !element.getAttribute("id")!.endsWith("-label")).map(row => row.textContent);

it("stands between the Assistant and Server settings, with the mode's whole state while it is on", async () => {
  await open();
  expect(titles()).toEqual(["Status", "Storage", "Assistant", "External sign-in", "Server settings"]);
  expect(rows()).toEqual(["StatusOn", "Sign-in servicehttps://sign-in.example.test/dezfil", "Public keys2 keys", "Sign-out generation3", "Door generation7"]);
  expect(card().querySelectorAll("button")).toEqual([]);
});

it("says one key in the singular", async () => {
  read = { ...read, externalSignIn: { ...ON, keyCount: 1 } };
  await open();
  expect(rows()).toContain("Public keys1 key");
});

it("says Off and nothing more while the mode is off", async () => {
  read = instanceReadFixture({}, { externalSignIn: { enabled: false, keyCount: 0, signOutGeneration: 2, doorGeneration: 0 } });
  await open();
  expect(rows()).toEqual(["StatusOff"]);
});

it("draws no card from a read without the mode", async () => {
  read = instanceReadFixture();
  await open();
  expect(titles()).toEqual(["Status", "Storage", "Assistant", "Server settings"]);
});

it("names the keys by count in Server settings, set or not", () => {
  expect(shownValue(read.settings.externalSignInKeys)).toEqual({ text: "2 keys" });
  expect(shownValue(instanceReadFixture().settings.externalSignInKeys)).toEqual({ text: "Not set", muted: true });
});
