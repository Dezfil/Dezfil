import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { APP_VERSION } from "./version";

describe("the reported version", () => {
  it("is package.json's version, in the API description too", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(APP_VERSION).toBe(manifest.version);
    expect(buildOpenApiDocument().info.version).toBe(manifest.version);
  });
});
