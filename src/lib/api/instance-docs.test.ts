import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { HTTP_METHODS } from "@/lib/api/http-methods";
import { buildTools } from "@/lib/tools/tools";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: a plain-JS gate, no declaration file on purpose.
import { SETTINGS_AREAS, tableRegions } from "../../../scripts/settings-tables.mjs";

/**
 * The admin's operations on this instance, every one under
 * /api/instance, are each described in the MCP guide by the tool it
 * generates, and every key the settings change takes is in a settings
 * table, so a new one cannot ship with no reader-facing word. Each
 * operation's own entry is the generated operation reference's.
 */

const mcp = readFileSync("docs/api/mcp.md", "utf8");

/** A count from twenty to ninety-nine, in the guides' words. */
function inWords(count: number): string {
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"][Math.floor(count / 10)];
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][count % 10];
  return ones ? `${tens}-${ones}` : tens;
}

describe("the instance operations in the guides", () => {
  const document = buildOpenApiDocument();
  const operations = Object.entries(document.paths).filter(([path]) => path.startsWith("/api/instance/"))
    .flatMap(([path, item]) => Object.entries(item as Record<string, { "x-tool"?: boolean }>)
      .filter(([method, operation]) => HTTP_METHODS.has(method) && operation["x-tool"] !== false)
      .map(([method]) => ({ call: `${method.toUpperCase()} ${path}`, method, path })));
  const tools = buildTools();

  it("covers the settings, the services, the parts, the storage and the basemap library", () => {
    expect(operations.map(operation => operation.call).sort()).toEqual([
      "DELETE /api/instance/basemaps/{id}", "DELETE /api/instance/caches", "GET /api/instance/settings", "GET /api/instance/storage",
      "PATCH /api/instance/basemaps/{id}", "PATCH /api/instance/settings", "POST /api/instance/basemaps",
      "POST /api/instance/parts/{part}/test", "POST /api/instance/services/{service}/test",
    ]);
  });

  it("names how many keys the settings change takes in the MCP guide, and lists every one in a settings table's Settings key column", () => {
    const keys = Object.keys(document.components.schemas.InstanceSettingsPatch.properties);
    expect(mcp.replace(/\s+/g, " ")).toContain(`editable-key input, ${inWords(keys.length)} keys`);
    const listed = new Set<string>();
    for (const { page, table } of SETTINGS_AREAS as { page: string; table: string }[]) {
      const region = (tableRegions(readFileSync(page, "utf8")) as { name: string; content?: string }[]).find((found) => found.name === table);
      expect(region?.content, `${page}: ${table}`).toBeDefined();
      // The rows below the header: the separator row starts with "|-".
      for (const row of region!.content!.split("\n").filter((line) => line.startsWith("| ")).slice(1)) {
        const cell = row.split(/(?<!\\)\|/)[3].trim();
        for (const key of cell.matchAll(/`([^`]+)`/g)) listed.add(key[1]);
      }
    }
    expect(keys.filter(key => !listed.has(key))).toEqual([]);
    // A key no table lists is named, so the check reads the column.
    expect([...keys, "invented.key"].filter(key => !listed.has(key))).toEqual(["invented.key"]);
  });

  it.each(["GET /api/instance/settings", "PATCH /api/instance/settings", "POST /api/instance/services/{service}/test",
    "DELETE /api/instance/caches", "POST /api/instance/parts/{part}/test", "GET /api/instance/storage",
    "POST /api/instance/basemaps", "PATCH /api/instance/basemaps/{id}", "DELETE /api/instance/basemaps/{id}"])("describes %s in the MCP guide by its tool", call => {
    const operation = operations.find(found => found.call === call)!;
    const tool = tools.find(found => found.method === operation.method && found.path === operation.path);
    expect(tool, call).toBeDefined();
    expect(mcp, tool!.name).toContain(`\`${tool!.name}\``);
  });
});
