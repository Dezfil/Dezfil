import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingDefinition } from "@/lib/settings/catalogue";
import type { Part, PartTestAnswer } from "@/lib/system/part-test-answer";
import type { PartStates } from "@/lib/system/part-states";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { instanceReadFixture, type Resolution } from "./read-fixture";
import { SystemTab } from "./SystemTab";

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => <a href={href} className={className}>{children}</a>,
}));

/**
 * System: the Status card from the configuration read and the health
 * read the rail's dot uses, each part with its state and its Test, the
 * read-only Assistant card from the assistant's status read, and the
 * Server settings table. The reads and the Tests are faked; nothing here
 * reaches a server.
 */

let resolved: Record<string, Resolution>;
let health: number;
let assistant: unknown;
let failRead: boolean;
let requests: string[];
/** The parts block each configuration read answers with, the first read first; the last one repeats. */
let partReads: Partial<PartStates>[];
/** What each part's Test answers. */
let answers: Partial<Record<Part, PartTestAnswer>>;
let tested: string[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-07T09:30:00.000Z"));
  resolved = { dataDir: { value: "/data", source: "environment", locked: true } };
  health = 200; failRead = false; requests = []; partReads = [{}]; answers = {}; tested = [];
  assistant = { enabled: true, provider: "anthropic", model: "claude-opus-5", models: [], catalogue: {}, stepBudget: 20, autoCheck: true };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (url === "/api/instance/settings") {
      const fixture = instanceReadFixture(resolved, { version: "0.4.2", startedAt: "2026-10-04T09:00:00.000Z" });
      const parts = partReads.length > 1 ? partReads.shift()! : partReads[0];
      return failRead ? Response.json({ error: { code: "internal", message: "Settings could not be read." } }, { status: 500 })
        : Response.json({ ...fixture, parts: { ...fixture.parts, ...parts } });
    }
    const part = /^\/api\/instance\/parts\/([a-z_]+)\/test$/.exec(url)?.[1] as Part | undefined;
    if (part && init?.method === "POST") {
      tested.push(part);
      return Response.json(answers[part] ?? { part, result: "passed", milliseconds: 4 });
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
  it("draws Status, then the Assistant, then the Server settings, with a Test on each part and nothing else to press", async () => {
    await open();
    expect(titles()).toEqual(["Status", "Assistant", "Server settings"]);
    // A Test per part; no cleanup, no Reset.
    expect(container.querySelectorAll("button").map(button => button.textContent)).toEqual(["Test", "Test", "Test", "Test", "Test"]);
    expect(card("Status").querySelectorAll("button")).toHaveLength(5);
  });

  it("shows the version with the running time, and the data folder's path with its state from the health read", async () => {
    await open();
    expect(requests).toContain("/api/health");
    expect(byId("sys-version").textContent).toBe("Version0.4.2Running for 3 days");
    expect(byId("sys-data-folder").textContent).toBe("Data folder/dataWritableTest");
  });

  it("says the data folder is not writable when the health read says the instance is not ready", async () => {
    health = 503;
    await open();
    expect(byId("sys-data-folder").textContent).toBe("Data folder/dataNot writableTest");
  });

  it("shows each part under the version with what the read knows of it and its state, a path and a file name in the code face", async () => {
    await open();
    const rows = card("Status").querySelectorAll("[id]").map(row => row.getAttribute("id")!).filter(id => id.startsWith("sys-") && !id.endsWith("-label"));
    expect(rows).toEqual(["sys-version", "sys-data-folder", "sys-engine", "sys-tiler", "sys-renderer", "sys-metadata"]);
    expect(byId("sys-engine").textContent).toBe("Query engineDuckDB 1.5.4Not started yetTest");
    expect(byId("sys-tiler").textContent).toBe("Tile buildertippecanoeFoundTest");
    expect(byId("sys-renderer").textContent).toBe("Image rendererChromium · 2 at onceFoundTest");
    expect(byId("sys-metadata").textContent).toBe("Metadata databasemetadata.sqliteReadyTest");
    expect(byId("sys-metadata").querySelector("[data-mono]")?.textContent).toBe("metadata.sqlite");
    expect(byId("sys-data-folder").querySelector("[data-mono]")?.textContent).toBe("/data");
    expect(byId("sys-engine").querySelector("[data-mono]")).toBeNull();
    for (const id of ["sys-engine", "sys-tiler", "sys-renderer", "sys-metadata"]) {
      expect(byId(id).querySelector("[data-state]")?.getAttribute("data-state"), id).toBe(id === "sys-engine" ? "off" : "on");
    }
  });

  it("shows a started engine with its extensions, the tile builder's version once known and a program not found", async () => {
    partReads = [{ query_engine: { version: "1.5.4", started: true, extensions: ["spatial", "h3", "json"] },
      tile_builder: { found: true, version: "2.79.0" }, image_renderer: { found: false, imagesAtOnce: 3 } }];
    await open();
    expect(byId("sys-engine").textContent).toBe("Query engineDuckDB 1.5.4 · spatial, h3, jsonReadyTest");
    expect(byId("sys-tiler").textContent).toBe("Tile buildertippecanoe 2.79.0FoundTest");
    expect(byId("sys-renderer").textContent).toBe("Image rendererChromium · 3 at onceNot foundTest");
    expect(byId("sys-renderer").querySelector("[data-state]")?.getAttribute("data-state")).toBe("danger");
  });

  it("runs a part's Test through its route and gives the answer in that part's words, the row's state following it", async () => {
    answers = {
      tile_builder: { part: "tile_builder", result: "failed", reason: "not_found" },
      data_folder: { part: "data_folder", result: "failed", reason: "failed" },
      metadata_database: { part: "metadata_database", result: "failed", reason: "busy" },
      image_renderer: { part: "image_renderer", result: "failed", reason: "timed_out" },
    };
    await open();
    for (const id of ["sys-tiler", "sys-data-folder", "sys-metadata", "sys-renderer"]) {
      await press(byId(id) as HostElement, "Test");
      await settle();
    }
    expect(tested).toEqual(["tile_builder", "data_folder", "metadata_database", "image_renderer"]);
    expect(byId("sys-tiler").textContent).toBe("Tile buildertippecanoeNot foundTestThe tile builder is not where its setting points.");
    expect(byId("sys-data-folder").textContent).toBe("Data folder/dataNot writableTestCould not write a file in the data folder.");
    expect(byId("sys-metadata").textContent).toBe("Metadata databasemetadata.sqliteReadyTestBusy: another write holds the database.");
    expect(byId("sys-renderer").textContent).toBe("Image rendererChromium · 2 at onceFoundTestDid not finish within 10 seconds.");
    for (const id of ["sys-tiler", "sys-data-folder", "sys-metadata", "sys-renderer"]) {
      expect(byId(id).querySelector('[role="status"]')?.getAttribute("data-answer"), id).toBe("failed");
    }
  });

  it("reads the parts again after a Test, so a passing engine shows Ready with the extensions it loaded", async () => {
    answers = { query_engine: { part: "query_engine", result: "passed", milliseconds: 31 } };
    partReads = [{}, { query_engine: { version: "1.5.4", started: true, extensions: ["spatial", "json"] } }];
    await open();
    expect(byId("sys-engine").textContent).toBe("Query engineDuckDB 1.5.4Not started yetTest");
    const reads = requests.filter(url => url === "/api/instance/settings").length;
    await press(byId("sys-engine") as HostElement, "Test");
    await settle();
    expect(requests.filter(url => url === "/api/instance/settings")).toHaveLength(reads + 1);
    expect(byId("sys-engine").textContent).toBe("Query engineDuckDB 1.5.4 · spatial, jsonReadyTestAnswered in 31 ms");
    expect(byId("sys-engine").querySelector('[role="status"]')?.getAttribute("data-answer")).toBe("passed");
  });

  it("keeps what it shows when the read after a Test fails", async () => {
    answers = { tile_builder: { part: "tile_builder", result: "passed", milliseconds: 900 } };
    await open();
    failRead = true;
    await press(byId("sys-tiler") as HostElement, "Test");
    await settle();
    expect(byId("sys-tiler").textContent).toBe("Tile buildertippecanoeFoundTestBuilt a test archive in 900 ms");
    expect(titles()).toEqual(["Status", "Assistant", "Server settings"]);
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

  it("lists the server's settings with the variable, the disclosed value and where it came from, linking a stored limit or service value to its row", async () => {
    resolved = { ...resolved,
      queryTimeoutS: { value: 90, source: "stored", storedValue: 90 },
      geocodePaceMs: { value: 1500, source: "stored", storedValue: 1500 },
      overpassUrl: { value: { set: true, origin: "https://osm.example" }, source: "stored" },
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
    // A number or an address stored on Data & services links to its row there.
    expect(cells("env-dezfil-geocode-pace-ms")).toEqual(["Address finder pace", "DEZFIL_GEOCODE_PACE_MS", "1,500 milliseconds", "Data & services"]);
    expect(byId("env-dezfil-geocode-pace-ms").querySelector("a")?.getAttribute("href")).toBe("/settings/data#set-geocoder-gap");
    expect(cells("env-dezfil-overpass-url")).toEqual(["Overpass endpoint", "DEZFIL_OVERPASS_URL", "https://osm.example", "Data & services"]);
    expect(byId("env-dezfil-overpass-url").querySelector("a")?.getAttribute("href")).toBe("/settings/data#set-osm-address");
    // A row Limits draws reads as its Limits row does: a count bare, a rate window every 10 seconds.
    expect(cells("env-dezfil-operation-concurrency")).toEqual(["Tools running at once", "DEZFIL_OPERATION_CONCURRENCY", "2", "Environment"]);
    expect(cells("env-dezfil-public-rate-limit")).toEqual(["Requests per visitor", "DEZFIL_PUBLIC_RATE_LIMIT", "60 every 10 seconds", "Default"]);
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

/**
 * How the Server settings table wraps, as the browser's cascade decides
 * it from the stylesheet: the table's cells may break anywhere (a long
 * address in Value), a variable's name and a source never break, and a
 * setting's name breaks only between its words. The host computes no
 * layout, so the rules are resolved here: each declaration whose selector
 * matches the cell, the most specific winning, the later on a tie.
 */
describe("the Server settings table's wrapping", () => {
  const css = readFileSync(fileURLToPath(new URL("./SystemTab.module.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  interface Cell { tag: string; classes: string[]; last: boolean }
  /** Split at commas outside parentheses. */
  const split = (list: string) => {
    const parts: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] === "(") depth += 1; else if (list[i] === ")") depth -= 1;
      else if (list[i] === "," && depth === 0) { parts.push(list.slice(start, i).trim()); start = i + 1; }
    }
    return [...parts, list.slice(start).trim()];
  };
  /** One compound selector against one element: its specificity when it matches. */
  function compound(selector: string, cell: Cell): [number, number] | null {
    let classes = 0, types = 0, rest = selector;
    const is = /:is\(([^)]*)\)/.exec(rest);
    if (is) {
      const matched = split(is[1]).map(inner => compound(inner, cell)).filter((found): found is [number, number] => !!found);
      if (!matched.length) return null;
      const best = matched.reduce((a, b) => (a[0] - b[0] || a[1] - b[1]) >= 0 ? a : b);
      classes += best[0]; types += best[1];
      rest = rest.replace(is[0], "");
    }
    if (rest.includes(":last-child")) { if (!cell.last) return null; classes += 1; rest = rest.replace(":last-child", ""); }
    const tag = /^[a-z]+/.exec(rest)?.[0];
    if (tag) { if (tag !== cell.tag) return null; types += 1; }
    for (const [, name] of rest.matchAll(/\.([\w-]+)/g)) { if (!cell.classes.includes(name)) return null; classes += 1; }
    return [classes, types];
  }
  /** A descendant selector against an element and its ancestors, nearest last. */
  function matches(selector: string, path: Cell[]): [number, number] | null {
    const parts = selector.split(/\s+/);
    const subject = compound(parts[parts.length - 1], path[path.length - 1]);
    if (!subject) return null;
    let [classes, types] = subject, at = path.length - 2;
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      while (at >= 0 && !compound(parts[i], path[at])) at -= 1;
      if (at < 0) return null;
      const found = compound(parts[i], path[at])!;
      classes += found[0]; types += found[1]; at -= 1;
    }
    return [classes, types];
  }
  function resolved(property: string, cellClass: string): string | null {
    const path: Cell[] = [
      { tag: "table", classes: ["table"], last: false }, { tag: "tbody", classes: [], last: true }, { tag: "tr", classes: [], last: false },
      { tag: "td", classes: [cellClass], last: false },
    ];
    let winner: { value: string; weight: [number, number] } | null = null;
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const value = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim();
      if (!value) continue;
      for (const selector of split(selectors)) {
        const weight = matches(selector, path);
        if (weight && (!winner || (weight[0] - winner.weight[0] || weight[1] - winner.weight[1]) >= 0)) winner = { value, weight };
      }
    }
    return winner?.value ?? null;
  }

  it("breaks a setting's name only between its words", () => {
    expect(resolved("overflow-wrap", "setting")).toBe("normal");
    expect(resolved("word-break", "setting")).toBe("normal");
  });

  it("never breaks a variable's name or a source, and lets a value break anywhere", () => {
    expect(resolved("white-space", "variable")).toBe("nowrap");
    expect(resolved("white-space", "source")).toBe("nowrap");
    expect(resolved("overflow-wrap", "value")).toBe("anywhere");
  });
});
