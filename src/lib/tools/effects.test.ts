import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { buildTools } from "./tools";

type Operation = Record<string, unknown>;
function operations() {
  return Object.entries(buildOpenApiDocument().paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      key: `${method.toUpperCase()} ${path}`,
      operation: operation as Operation,
    })),
  );
}

// This checks the published declarations independently of tool derivation.
function assertMetadata(operation: Operation) {
  const effects = operation["x-effects"] as { writes?: { resource: string }[]; readOnly?: boolean } | undefined;
  expect(effects, "missing effects").toBeDefined();
  expect(typeof effects?.readOnly, "explicit read-only declaration").toBe("boolean");
  expect(Array.isArray(effects?.writes), "explicit resource collection").toBe(true);
  expect(effects?.readOnly).toBe(effects?.writes?.length === 0);
  if (operation["x-confirm"]) {
    const words = operation["x-confirmation"] as Record<string, unknown> | undefined;
    expect(typeof words?.target, "missing target words").toBe("string");
    expect(String(words?.target).trim().length).toBeGreaterThan(0);
    expect(typeof words?.consequence, "missing consequence words").toBe("string");
    expect(String(words?.consequence).trim().length).toBeGreaterThan(0);
  }
}

const resources = (operation: Operation) =>
  (operation["x-effects"] as { writes: { resource: string }[] }).writes.map((entry) => entry.resource).sort();

describe("effects and confirmation parity", () => {
  it("every operation, including excluded transports, declares product effects", () => {
    for (const { operation } of operations()) assertMetadata(operation);
  });

  // Independent semantic oracles. HTTP method is deliberately insufficient.
  for (const name of ["run_sql", "preview_table_geometry", "export_project", "compute_fill", "preview_postgis_relation"]) {
    it(`${name} reads without product mutation despite POST`, () => {
      const operation = operations().find((entry) => entry.operation["x-tool"] === name)!.operation;
      assertMetadata(operation);
      expect(resources(operation)).toEqual([]);
      expect(operation["x-effects"]).toMatchObject({ readOnly: true });
    });
  }
  for (const [name, expected] of [
    ["update_layer", ["layers"]],
    // the connection test is the one PostGIS operation that still writes
    // the connection's stored health; the catalogue browse and the
    // relation preview declare no write at all.
    ["test_postgis_connection", ["connections"]],
    ["publish_map", ["publications"]],
    ["set_table_geometry", ["tables"]],
    ["delete_project", ["projects"]],
    ["run_recipe", ["recipes", "runs", "tables"]],
  ] as const) {
    it(`${name} declares its independently expected resources`, () => {
      const operation = operations().find((entry) => entry.operation["x-tool"] === name)!.operation;
      assertMetadata(operation);
      expect(resources(operation)).toEqual([...expected]);
      if (name === "run_recipe") expect(operation["x-effects"]).toMatchObject({ planningArgument: "plan" });
    });
  }

  it("list_postgis_tables reads the source catalogue and writes nothing", () => {
    const operation = operations().find((entry) => entry.operation["x-tool"] === "list_postgis_tables")!.operation;
    assertMetadata(operation);
    expect(resources(operation)).toEqual([]);
    expect(operation["x-effects"]).toMatchObject({ readOnly: true });
  });

  for (const [name, expected] of [
    ["upload_table", ["id", "tables.*.id"]],
    ["import_table_from_url", ["id", "tables.*.id"]],
    ["import_table_from_overture", "id"],
    ["import_table_from_postgis", "id"],
    ["import_table_from_osm", "tables.*.id"],
  ] as const) {
    it(`${name} identifies outputs in its documented response envelope`, () => {
      const tool = buildTools().find((entry) => entry.name === name)!;
      expect(tool.effects.writes.find((entry) => entry.resource === "tables")?.result).toEqual(expected);
      if (name === "import_table_from_postgis") {
        expect(tool.effects.writes.find((entry) => entry.resource === "connections")?.argument).toBe("connectionId");
      }
    });
  }

  it("all generated tools carry exactly their source metadata", () => {
    for (const tool of buildTools()) {
      const source = operations().find((entry) => entry.operation["x-tool"] === tool.name)!.operation;
      assertMetadata(source);
      const derived = tool as unknown as Record<string, unknown>;
      expect(derived.effects, tool.name).toEqual(source["x-effects"]);
      if (source["x-confirm"]) expect(derived.confirmation, tool.name).toEqual(source["x-confirmation"]);
    }
  });

  for (const omission of ["effects", "target", "consequence"] as const) {
    it(`seeding the ${omission} omission makes the same parity assertion fail`, () => {
      const source = structuredClone(operations().find((entry) => entry.operation["x-tool"] === "publish_map")!.operation);
      assertMetadata(source); // must pass first: absent baseline metadata cannot satisfy this proof
      if (omission === "effects") delete source["x-effects"];
      else delete (source["x-confirmation"] as Record<string, unknown>)[omission];
      expect(() => assertMetadata(source)).toThrow();
    });
  }
});
