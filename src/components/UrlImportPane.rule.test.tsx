import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostEvent, installDomHost, type HostElement } from "./testing/dom-host";
import { UrlImportPane } from "./UrlImportPane";

/**
 * Add data's link entry under who may import from links. While the rule
 * holds the person back, the address, the table name and Import as table
 * are drawn disabled with the rule's one sentence, and Enter sends no
 * import. With no rule holding them back, or no rule read, the entry
 * draws as it always has. Every read is a fake.
 */
const SENTENCE = "Only admins can import from links on this instance.";

let rule: string | null;
let admin: boolean;
let imports: number;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  rule = "everyone";
  admin = false;
  imports = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url === "/api/config") {
      return rule === null ? Response.json({ error: { code: "internal", message: "Unavailable." } }, { status: 500 })
        : Response.json({ rules: { "imports.links": rule } });
    }
    if (url === "/api/account") return Response.json({ account: { id: "a1", isAdmin: admin } });
    if (url === "/api/imports/url") { imports += 1; return Response.json({ id: "t1", name: "stations" }, { status: 201 }); }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  host = installDomHost();
  container = host.document.body.appendChild(host.document.createElement("div"));
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
async function open() {
  await act(async () => root.render(<UrlImportPane onTableCreated={() => {}} />));
  await settle();
}
const input = (label: string) => container.querySelectorAll("label").find(element => element.querySelector("span")?.textContent === label)!.querySelector("input")!;
const importButton = () => container.querySelectorAll("button").find(element => element.textContent === "Import as table")!;
const props = (element: HostElement) =>
  (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[Object.keys(element).find(name => name.startsWith("__reactProps$"))!];
async function typeAddress(value: string) {
  await act(async () => props(input("File URL")).onChange({ target: { value } }));
}
async function pressEnter() {
  await act(async () => props(input("File URL")).onKeyDown({ key: "Enter" }));
  await settle();
}

describe("who may import from links, in Add data's link entry", () => {
  it("draws the address, the name and Import as table disabled for a member under Admins only, with the sentence", async () => {
    rule = "admins";
    await open();
    await typeAddress("https://data.example.test/stations.parquet");
    expect(input("File URL").disabled).toBe(true);
    expect(input("Table name").disabled).toBe(true);
    expect(importButton().disabled).toBe(true);
    expect(container.textContent.split(SENTENCE).length - 1).toBe(1);
    await pressEnter();
    expect(imports).toBe(0);
  });

  for (const [value, who] of [["everyone", "a member"], ["admins", "an admin"], [null, "a member, the rule unread,"]] as const) {
    it(`draws as it always has for ${who} under ${value ?? "no rule"}`, async () => {
      rule = value;
      admin = who === "an admin";
      await open();
      await typeAddress("https://data.example.test/stations.parquet");
      expect(input("File URL").disabled).toBe(false);
      expect(input("Table name").disabled).toBe(false);
      expect(importButton().disabled).toBe(false);
      expect(container.textContent).not.toContain(SENTENCE);
      await act(async () => importButton().dispatchEvent(new HostEvent("click", { bubbles: true, cancelable: true })));
      await settle();
      expect(imports).toBe(1);
    });
  }
});
