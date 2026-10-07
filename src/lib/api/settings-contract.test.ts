import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "./openapi";

/**
 * The settings surface's documented contract. Parity only proves the
 * route exists; these prove the instance name is documented the way the
 * Developer page shows it — the operation's own description (the page
 * renders descriptions, not schema internals) — and that the wire shape
 * names null as the unnamed state.
 */

type Json = Record<string, unknown>;

function settingsOps(): { get: Json; patch: Json } {
  const doc = buildOpenApiDocument() as Json;
  const paths = doc.paths as Json;
  const settings = paths["/api/settings"] as Json;
  return { get: settings.get as Json, patch: settings.patch as Json };
}

describe("the settings contract in the OpenAPI document", () => {
  it("names the instance name in the GET description, visibly", () => {
    const { get } = settingsOps();
    const description = get.description as string;
    expect(description).toContain("instance name");
    // The unnamed state is part of the visible prose, not schema-only.
    expect(description).toContain("null when unnamed");
  });

  it("documents instanceName as nullable in the response schema, required", () => {
    const doc = buildOpenApiDocument() as Json;
    const schemas = (doc.components as Json).schemas as Json;
    const settings = schemas.WorkspaceSettings as Json;
    const properties = settings.properties as Json;
    expect(properties).toHaveProperty("instanceName");
    expect((properties.instanceName as Json).type).toEqual(["string", "null"]);
    expect(settings.required).toContain("instanceName");
  });

  it("documents instanceName on the PATCH body with the clearing rule", () => {
    const { patch } = settingsOps();
    const body = patch.requestBody as Json;
    const content = (body.content as Json)["application/json"] as Json;
    const properties = (content.schema as Json).properties as Json;
    expect(properties).toHaveProperty("instanceName");
    const field = properties.instanceName as Json;
    expect(field.type).toEqual(["string", "null"]);
    expect(field.maxLength).toBe(80);
    expect(field.description as string).toContain("clears");
  });
});

describe("the Projects list's remembered view in the settings contract", () => {
  it("documents the projects slice on the PATCH body with its three sorts", () => {
    const { patch } = settingsOps();
    const content = ((patch.requestBody as Json).content as Json)[
      "application/json"
    ] as Json;
    const properties = (content.schema as Json).properties as Json;
    const slices = (properties.viewPrefs as Json).properties as Json;
    expect(slices).toHaveProperty("projects");
    const sort = ((slices.projects as Json).properties as Json).sort as Json;
    expect(sort.enum).toEqual(["updated", "name", "largest"]);
  });

  it("documents viewPrefs, the projects slice included, on the settings response", () => {
    const doc = buildOpenApiDocument() as Json;
    const schemas = (doc.components as Json).schemas as Json;
    const properties = (schemas.WorkspaceSettings as Json).properties as Json;
    expect(properties).toHaveProperty("viewPrefs");
    const slices = (properties.viewPrefs as Json).properties as Json;
    for (const screen of ["maps", "data", "workflows", "projects"]) {
      expect(slices).toHaveProperty(screen);
    }
  });
});

it("requires cookie or bearer authentication and generates both settings tools with refusal schemas", () => {
  const { get, patch } = settingsOps();
  for (const operation of [get, patch]) {
    expect(operation.security).toEqual([{ CookieSession: [] }, { BearerToken: [] }]);
    expect(operation.responses).toHaveProperty("401");
    expect(operation.responses).toHaveProperty("403");
    expect(operation.description).toContain("private, no-store");
  }
  expect(get["x-tool"]).toBe("get_settings");
  expect(patch["x-tool"]).toBe("update_settings");
  expect(patch.description).toContain("Only admins");
  expect(patch.description).toContain("before any write");
});

describe("the look in the settings contract", () => {
  const CHOICES = {
    color: ["kelp", "harbor", "heather", "slate"], contrast: ["standard", "more"], font: ["inter", "system"],
    background: ["atlantic", "plain", "graticule", "hex"], corners: ["rounded", "soft"], rail: ["hover", "open", "icons"],
  };
  const DEFAULTS = { color: "kelp", contrast: "standard", font: "inter", background: "atlantic", corners: "rounded", rail: "hover" };
  const picks = (look: Json) => {
    const properties = look.properties as Record<string, Json>;
    return {
      choices: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, value.enum])),
      defaults: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, value.default])),
      described: Object.values(properties).every(value => typeof value.description === "string" && value.description.length > 0),
    };
  };

  it("documents the look on the read: always present, every pick present, closed, with its choices and default", () => {
    const doc = buildOpenApiDocument() as Json;
    const settings = ((doc.components as Json).schemas as Json).WorkspaceSettings as Json;
    expect(settings.required).toContain("look");
    const look = (settings.properties as Json).look as Json;
    expect(look.type).toBe("object");
    expect(look.additionalProperties).toBe(false);
    expect(look.required).toEqual(Object.keys(CHOICES));
    expect(picks(look)).toEqual({ choices: CHOICES, defaults: DEFAULTS, described: true });
  });

  it("documents the look on the update body as an optional, partial, closed slice", () => {
    const { get, patch } = settingsOps();
    const body = (((patch.requestBody as Json).content as Json)["application/json"] as Json).schema as Json;
    expect(body.required ?? []).not.toContain("look");
    const look = (body.properties as Json).look as Json;
    expect(look.additionalProperties).toBe(false);
    expect(look.required).toBeUndefined();
    expect(picks(look)).toEqual({ choices: CHOICES, defaults: DEFAULTS, described: true });
    expect(get.description as string).toContain("look");
    expect(patch.description as string).toContain("look");
  });
});

it("documents the source-list grouping on the read, always present, and on the update body", () => {
  const doc = buildOpenApiDocument() as Json;
  const settings = ((doc.components as Json).schemas as Json).WorkspaceSettings as Json;
  const field = (settings.properties as Json).sourceGrouping as Json;
  expect(field.enum).toEqual(["person", "project"]);
  expect(field.default).toBe("person");
  expect(field.description as string).toContain("source list");
  expect(settings.required).toContain("sourceGrouping");
  const { get, patch } = settingsOps();
  const body = (((patch.requestBody as Json).content as Json)["application/json"] as Json).schema as Json;
  expect(((body.properties as Json).sourceGrouping as Json).enum).toEqual(["person", "project"]);
  expect(get.description as string).toContain("how the SQL console's source list groups datasets");
});
