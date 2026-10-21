import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { DOCS_SITE_URL, HTTP_API_GUIDE_URL, docsPageUrl } from "@/lib/docs-site";
import { IGNORED_VALUES, unsupportedProtection } from "@/lib/postgis/protection-parameters";

// The served description is read by people and agents who have no checkout
// of this repository, so a path into it names nothing they can open. A page
// of the documentation is named by its site address instead.

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const TOP_FOLDERS = new Set(tracked.filter((file) => file.includes("/")).map((file) => file.split("/")[0]));
// Root files without an extension (LICENSE, NOTICE) are ordinary words in
// prose, so only the ones a reader would take for a file are looked for.
const ROOT_FILES = new Set(tracked.filter((file) => !file.includes("/") && /\.[A-Za-z]+$/.test(file)));

/** Every repository path named in a text: a path that starts at one of the
 * tracked top-level folders, or a tracked root file named on its own. A URL's
 * own path, an API path and a media type do not start a token here. */
function repositoryPaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?<![\w/.:@-])([\w.-]+)\/[\w./-]*\w/g)) {
    if (TOP_FOLDERS.has(match[1])) found.push(match[0]);
  }
  for (const match of text.matchAll(/(?<![\w/.:@-])[\w.-]+\.[A-Za-z]+(?![\w/])/g)) {
    if (ROOT_FILES.has(match[0])) found.push(match[0]);
  }
  return found;
}

/** Every string value in a JSON-shaped document, keys included. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { into.push(key); strings(item, into); }
  }
  return into;
}

describe("the served description names documentation by its site address", () => {
  it("finds a repository path where one is written, and nothing else", () => {
    expect(TOP_FOLDERS.has("docs")).toBe(true);
    expect(ROOT_FILES.has("README.md")).toBe(true);
    expect(repositoryPaths("See docs/api.md (Connections).")).toEqual(["docs/api.md"]);
    expect(repositoryPaths("Read docs/api/http-api.md, scripts/check.mjs or README.md.")).toEqual([
      "docs/api/http-api.md", "scripts/check.mjs", "README.md",
    ]);
    expect(repositoryPaths(
      `See ${HTTP_API_GUIDE_URL}. GET /api/openapi.json answers application/json; ` +
      "the data directory is ./data; WKT/WKB and lng/lat are words.",
    )).toEqual([]);
  });

  it("carries no repository path in any string of the built document", () => {
    const found = strings(buildOpenApiDocument()).flatMap(repositoryPaths);
    expect(found).toEqual([]);
  });

  it("names the HTTP API guide by its full site address where it once named the file", () => {
    expect(HTTP_API_GUIDE_URL).toBe("https://dezfil.io/docs/api/http-api/");
    expect(HTTP_API_GUIDE_URL.startsWith(DOCS_SITE_URL)).toBe(true);
    // The address is the page's path in the repository, so the page must be there.
    const page = `docs/${HTTP_API_GUIDE_URL.slice(DOCS_SITE_URL.length, -1)}.md`;
    expect(existsSync(page)).toBe(true);
    // And the page holds what the string sends the reader to: its Connections
    // section, with the table of how each string parameter is treated, every
    // parameter the refusal names among its rows.
    const text = readFileSync(page, "utf8");
    const section = text.split("\n## Connections\n")[1]?.split("\n## ")[0];
    expect(section, "a Connections section").toBeDefined();
    expect(section).toMatch(/^\| `channel_binding`, `gssencmode` \| /m);
    const rows = section!.split("\n").filter((line) => line.startsWith("| `")).map((line) => {
      const [names, values] = line.split(" | ");
      return { names: [...names.matchAll(/`([^`]+)`/g)].map((found) => found[1]), values: [...values.matchAll(/`([^`]+)`/g)].map((found) => found[1]) };
    });
    expect(rows.flatMap((row) => row.names).sort()).toEqual(Object.keys(IGNORED_VALUES).sort());
    for (const { names, values } of rows) for (const name of names) {
      expect(values, name).toEqual([...IGNORED_VALUES[name]]);
      expect(unsupportedProtection([[name, "not-a-value"]]), name).toBe(name);
      for (const value of values) expect(unsupportedProtection([[name, value]]), `${name}=${value}`).toBeUndefined();
    }
    const served = JSON.stringify(buildOpenApiDocument());
    expect(served).toContain(`See ${HTTP_API_GUIDE_URL} (Connections) for parameter dispositions.`);
  });

  it("builds a page address only from a section and a page", () => {
    expect(docsPageUrl("api/mcp")).toBe("https://dezfil.io/docs/api/mcp/");
    expect(docsPageUrl("self-host/configuration/storage"))
      .toBe("https://dezfil.io/docs/self-host/configuration/storage/");
    for (const bad of ["mcp", "api/mcp.md", "/api/mcp", "api/mcp/", "API/MCP"]) {
      expect(() => docsPageUrl(bad)).toThrow();
    }
  });
});
