import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildOpenApiDocument } from "./openapi";
import { WORKFLOW_JSON_BODY_MAX_BYTES, SMALL_JSON_BODY_MAX_BYTES } from "./request-bounds";
import { documentedRoutes, publishedBodyRoutes, governedBodyRoutes, implementedRoutes, key, walk } from "../../../test-support/api-route-inventory";

/**
 * API parity (spec: every capability in the journey is documented; the diff
 * over the UI's own-API calls is empty). Three directions, all static and
 * deterministic — no browser needed:
 *   1. Every implemented route file + HTTP method is in the OpenAPI doc.
 *   2. Every OpenAPI operation maps to an implemented route.
 *   3. Every fetch("/api/…") in the UI hits a documented path.
 */

const COMPONENTS_DIR = path.join(process.cwd(), "src/components");

describe("API parity", () => {
  it("every implemented route is documented", () => {
    const documented = new Set(documentedRoutes().map(key));
    const missing = implementedRoutes()
      .map(key)
      .filter((k) => !documented.has(k));
    expect(missing).toEqual([]);
  });

  it("every documented operation is implemented", () => {
    const implemented = new Set(implementedRoutes(true).map(key));
    const missing = documentedRoutes()
      .map(key)
      .filter((k) => !implemented.has(k));
    expect(missing).toEqual([]);
  });

  it("publishes the enforced workflow JSON byte ceiling on every governed operation", () => {
    const workflows = governedBodyRoutes();
    const selections = publishedBodyRoutes();
    const operations = [...workflows, ...selections];
    expect(selections).toHaveLength(3);
    // The derivation needs a floor: a renamed reader or a reshaped route
    // export would empty this list and the loop below would assert
    // nothing while staying green. Seven
    // governed operations exist today; fewer means the scan broke, not
    // that the API shrank.
    expect(operations.length).toBeGreaterThanOrEqual(7);
    const document = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { description?: string }>>;
      components: {
        schemas: {
          Error: {
            properties: {
              error: { properties: { code: { enum: string[] } } };
            };
          };
        };
      };
      "x-error-codes": Record<string, string>;
    };

    for (const { path, method } of operations) {
      const limit = selections.some(row => row.path === path && row.method === method) ? SMALL_JSON_BODY_MAX_BYTES : WORKFLOW_JSON_BODY_MAX_BYTES;
      const expected = limit.toLocaleString("en-US");
      const description = document.paths[path]?.[method]?.description;
      expect(description, `${method.toUpperCase()} ${path}`).toContain(
        `At most ${expected} wire bytes`,
      );
      expect(description, `${method.toUpperCase()} ${path}`).toContain(
        "`request_body_too_large` before JSON parsing",
      );
    }
    expect(
      document.components.schemas.Error.properties.error.properties.code.enum,
    ).toContain("request_body_too_large");
    expect(document["x-error-codes"]).toHaveProperty("request_body_too_large");
    // The reverse direction: nothing documents the ceiling without being
    // governed by the readers the scan found.
    const governed = new Set(
      operations.map(({ path, method }) => `${method} ${path}`),
    );
    const documentedWithBound = Object.entries(document.paths).flatMap(
      ([path, methods]) =>
        Object.entries(methods)
          .filter(([, op]) => op.description?.includes("wire bytes"))
          .map(([method]) => `${method} ${path}`),
    );
    expect(new Set(documentedWithBound)).toEqual(governed);
  });

  it("documents the connection contract and tool names", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<
        string,
        Record<
          string,
          {
            "x-tool": string | false;
            description?: string;
            requestBody?: {
              content: {
                "application/json": {
                  schema: {
                    properties: Record<string, { writeOnly?: boolean }>;
                  };
                };
              };
            };
            responses?: Record<
              string,
              {
                content?: {
                  "application/json"?: { schema?: { $ref?: string } };
                };
              }
            >;
          }
        >
      >;
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    const create = doc.paths["/api/connections/postgis"].post;
    const update = doc.paths["/api/connections/postgis/{id}"].patch;
    const testConnection =
      doc.paths["/api/connections/postgis/{id}/test"].post;
    const snapshots =
      doc.paths["/api/connections/postgis/{id}/snapshots"].get;
    expect(create["x-tool"]).toBe("create_postgis_connection");
    expect(update["x-tool"]).toBe("update_postgis_connection");
    expect(snapshots["x-tool"]).toBe("list_postgis_snapshots");
    expect(create.requestBody?.content["application/json"].schema.properties.url)
      .toMatchObject({ writeOnly: true });
    expect(update.requestBody?.content["application/json"].schema.properties.password)
      .toMatchObject({ writeOnly: true });
    expect(update.description).toContain(
      "Changing the host or port, or turning SSL off, requires an entered password.",
    );
    expect(
      create.responses?.["201"].content?.["application/json"]?.schema?.$ref,
    ).toBe("#/components/schemas/PgConnection");
    expect(
      testConnection.responses?.["200"].content?.["application/json"]?.schema
        ?.$ref,
    ).toBe("#/components/schemas/PgConnection");
    expect(doc.components.schemas.PgConnectionHealth).toBeUndefined();
    expect(
      Object.keys(doc.components.schemas.PgConnection.properties ?? {}),
    ).toEqual(
      expect.arrayContaining([
        "status",
        "lastCheckedAt",
        "lastCheckError",
        "serverVersion",
        "postgisVersion",
      ]),
    );
  });

  it("documents the catalogue truth and bounded preview contract", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const tables = doc.paths["/api/connections/postgis/{id}/tables"].get;
    const preview = doc.paths["/api/connections/postgis/{id}/preview"].post;
    expect(tables["x-tool"]).toBe("list_postgis_tables");
    expect(preview["x-tool"]).toBe("preview_postgis_relation");

    // The published description is read by
    // every generated client, so it must not still promise the write the
    // operation stopped making.
    for (const operation of [tables, preview]) {
      expect(operation.description as string).not.toContain("health observation still records");
      expect(operation.description as string).not.toMatch(/records? the connection|status memory/i);
    }
    expect(preview.description as string).toContain(
      "records nothing about the connection",
    );

    const tableProperties = (((tables.responses as Record<string, unknown>)[
      "200"
    ] as { content: Record<string, { schema: Record<string, unknown> }> })
      .content["application/json"].schema.properties as Record<
      string,
      { items: { properties: Record<string, unknown> } }
    >).tables.items.properties;
    expect(Object.keys(tableProperties)).toEqual(
      expect.arrayContaining([
        "kind",
        "system",
        "spatialKind",
        "approxRows",
      ]),
    );
    expect(tableProperties.approxRows).toMatchObject({
      type: ["integer", "null"],
      minimum: 0,
    });

    const previewRequest = (preview.requestBody as {
      content: Record<
        string,
        {
          schema: {
            additionalProperties: boolean;
            properties: Record<string, unknown>;
            required: string[];
          };
        }
      >;
    }).content["application/json"].schema;
    expect(previewRequest.additionalProperties).toBe(false);
    expect(Object.keys(previewRequest.properties)).toEqual([
      "schema",
      "table",
      "filter",
    ]);
    expect(previewRequest.required).toEqual(["schema", "table"]);
    const previewResponse = (((preview.responses as Record<string, unknown>)[
      "200"
    ] as { content: Record<string, { schema: Record<string, unknown> }> })
      .content["application/json"].schema.properties as Record<
      string,
      Record<string, unknown>
    >);
    expect(previewResponse.rows).toMatchObject({ maxItems: 5 });
    expect(previewResponse.columns).toBeDefined();
  });

  it("documents the map note", () => {
    const doc = buildOpenApiDocument() as unknown as {
      components: {
        schemas: Record<
          string,
          { properties?: Record<string, unknown>; description?: string }
        >;
      };
    };
    expect(doc.components.schemas.MapNote?.properties?.corner).toBeDefined();
    expect(doc.components.schemas.Map.properties?.note).toBeDefined();
    expect(
      doc.components.schemas.PublishedView.properties?.note,
    ).toBeDefined();
  });

  it("documents basemap layer toggles", () => {
    const doc = buildOpenApiDocument() as unknown as {
      components: {
        schemas: Record<
          string,
          { properties?: Record<string, unknown>; description?: string }
        >;
      };
    };
    const groups = doc.components.schemas.BasemapLayers?.properties ?? {};
    expect(Object.keys(groups).sort()).toEqual([
      "borders",
      "buildings",
      "labels",
      "land",
      "roads",
      "water",
    ]);
    expect(doc.components.schemas.Map.properties?.basemapLayers).toBeDefined();
    expect(
      doc.components.schemas.MapUpdate.properties?.basemapLayers,
    ).toBeDefined();
    expect(
      doc.components.schemas.PublishedView.properties?.basemapLayers,
    ).toBeDefined();
  });

  it("documents overlay ergonomics", () => {
    const doc = buildOpenApiDocument() as unknown as {
      components: {
        schemas: Record<
          string,
          { properties?: Record<string, { description?: string }> }
        >;
      };
    };
    for (const schema of ["Map", "MapUpdate", "PublishedView"]) {
      expect(
        doc.components.schemas[schema].properties?.legendCorner,
        schema,
      ).toBeDefined();
    }
    // The three attribute-name states are documented on the layer.
    expect(
      doc.components.schemas.Layer.properties?.legendAttrs?.description,
    ).toMatch(/hides/);
  });

  it("documents Auto basemap semantics", () => {
    const doc = buildOpenApiDocument() as unknown as {
      components: {
        schemas: Record<
          string,
          { properties: Record<string, { description?: string }> }
        >;
      };
    };
    expect(doc.components.schemas.Map.properties.basemap.description).toMatch(
      /Auto/,
    );
    expect(
      doc.components.schemas.Config.properties.basemapOverrideUrl,
    ).toBeDefined();
  });

  it("documents the palette catalogue's grouping", () => {
    const doc = buildOpenApiDocument() as unknown as {
      components: {
        schemas: Record<
          string,
          { properties: Record<string, { items?: { properties: Record<string, unknown> } }> }
        >;
      };
    };
    const palette = doc.components.schemas.Config.properties.palettes.items
      ?.properties as Record<string, { enum?: string[]; type?: string }>;
    expect(palette.group?.enum).toEqual([
      "sequential",
      "diverging",
      "qualitative",
    ]);
    expect(palette.colorblindSafe?.type).toBe("boolean");
  });

  it("documents undo/redo", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { "x-tool": string | false }>>;
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    expect(doc.paths["/api/maps/{id}/undo"].post["x-tool"]).toBe("undo_change");
    expect(doc.paths["/api/maps/{id}/redo"].post["x-tool"]).toBe("redo_change");
    expect(doc.paths["/api/maps/{id}/history"].get["x-tool"]).toBe(
      "get_history",
    );
    const history = doc.components.schemas.History;
    expect(Object.keys(history.properties ?? {}).sort()).toEqual([
      "canRedo",
      "canUndo",
      "editRevision",
      "lastChangedAt",
      "lastChangedBy",
      "redoTarget",
      "undoTarget",
    ]);
    expect(doc.components.schemas.MapWithHistory).toBeDefined();
  });

  it("documents the docked timeline", () => {
    const doc = buildOpenApiDocument() as unknown as {
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    // The dock is map state — one schema referenced by the map shape and
    // the update body, so the assistant's update_map tool carries it.
    const timeline = doc.components.schemas.MapTimeline;
    expect(Object.keys(timeline.properties ?? {}).sort()).toEqual([
      "field",
      "layerId",
      "speed",
    ]);
    expect(doc.components.schemas.Map.properties?.timeline).toEqual({
      $ref: "#/components/schemas/MapTimeline",
    });
    expect(doc.components.schemas.MapUpdate.properties?.timeline).toEqual({
      $ref: "#/components/schemas/MapTimeline",
    });
    // The viewer's payload block is documented too.
    expect(
      doc.components.schemas.PublishedView.properties?.timeline,
    ).toBeDefined();
  });

  it("documents live filtering", () => {
    const doc = buildOpenApiDocument() as unknown as {
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    // The render response says when its data ships without the layer's
    // live filters — the client-enforcement contract.
    expect(
      doc.components.schemas.LayerRender.properties?.liveFiltered,
    ).toBeDefined();
  });

  it("documents render-mode-independent geometry metadata", () => {
    const doc = buildOpenApiDocument() as unknown as {
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    expect(
      doc.components.schemas.LayerRender.properties?.geometryType,
    ).toMatchObject({
      type: ["string", "null"],
      enum: ["POINT", "LINESTRING", "POLYGON", "MIXED", null],
    });
  });

  it("documents layer data export with its tool name", () => {
    // the tool name is asserted, not assumed from the sweep.
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, { get?: { "x-tool"?: string | false } }>;
    };
    const op = doc.paths["/api/layers/{id}/export/{format}"]?.get;
    expect(op).toBeDefined();
    expect(op?.["x-tool"]).toBe("export_layer_data");
  });

  it("documents the multi-geometry SQL contract on create and update", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<
        string,
        Record<string, { description?: string; "x-tool"?: string | false }>
      >;
    };
    const operations = [
      doc.paths["/api/maps/{id}/layers"]?.post,
      doc.paths["/api/layers/{id}"]?.patch,
    ];
    expect(operations[1]?.description).toContain("When `sql` is changed");

    for (const operation of operations) {
      expect(operation).toBeDefined();
      expect(operation?.description).toContain("at least one geometry column");
      expect(operation?.description).toContain(
        "first geometry column in select order",
      );
      expect(operation?.description).toContain(
        "primary geometry used for simple rendering",
      );
      expect(operation?.description).toContain(
        "additional geometry columns are allowed",
      );
    }
  });

  it("every fetch(\"/api/…\") in the UI hits a documented path", () => {
    const documented = documentedRoutes().map((r) => r.path);
    // Regex the templated path into a matcher: {param} → one path segment.
    const matchers = documented.map(
      (p) =>
        new RegExp(
          "^" + p.replace(/\{[^}]+\}/g, "[^/]+").replace(/\//g, "\\/") + "$",
        ),
    );

    const uiFiles = walk(COMPONENTS_DIR).filter(
      (f) => f.endsWith(".tsx") || f.endsWith(".ts"),
    );
    const calls: string[] = [];
    const fetchRe = /(?:fetch|accountRequest(?:<[^;]*?>)?)\(\s*[`"']([^`"']*\/api\/[^`"']*)[`"']/g;
    for (const file of uiFiles) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = fetchRe.exec(src)) !== null) {
        // Normalize template-literal interpolations to a placeholder segment.
        const raw = m[1].replace(/\$\{[^}]+\}/g, "X").split("?")[0];
        if (raw.includes("/api/")) calls.push(raw);
      }
    }

    // We must actually have found some calls, else the regex is broken.
    expect(calls.length).toBeGreaterThan(0);
    const undocumented = calls.filter(
      (c) => !matchers.some((re) => re.test(c)),
    );
    expect(undocumented).toEqual([]);
  });

  it("exposes map search as an agent tool with its documented inputs", () => {
    const document = buildOpenApiDocument() as {
      paths: Record<
        string,
        Record<
          string,
          {
            "x-tool"?: string | false;
            parameters?: { name: string; required?: boolean }[];
          }
        >
      >;
    };
    const search = document.paths["/api/maps/{id}/search"]?.get;
    expect(search).toBeDefined();
    expect(search?.["x-tool"]).toBe("search_map");
    const params = Object.fromEntries(
      (search?.parameters ?? []).map((p) => [p.name, p.required ?? false]),
    );
    expect(params).toEqual({ id: true, q: true, places: false });
  });
});

describe("the SQL workspace's contracts", () => {
  type Doc = {
    paths: Record<
      string,
      Record<
        string,
        {
          "x-tool"?: string | false;
          requestBody?: {
            content: Record<
              string,
              { schema: { properties?: Record<string, { enum?: unknown[] }> } }
            >;
          };
        }
      >
    >;
    components: {
      schemas: Record<
        string,
        {
          properties?: Record<
            string,
            { properties?: Record<string, { properties?: Record<string, unknown> }> }
          >;
        }
      >;
    };
  };
  const doc = buildOpenApiDocument() as unknown as Doc;

  it("documents the query operation's geometry encoding and the error position", () => {
    const props =
      doc.paths["/api/query"]?.post?.requestBody?.content["application/json"]
        .schema.properties;
    expect(props?.geometry?.enum).toEqual(["wkt", "geojson"]);
    const position =
      doc.components.schemas.Error.properties?.error.properties?.position;
    expect(position).toMatchObject({
      properties: { line: { type: "integer" }, column: { type: "integer" } },
    });
  });

  it("documents the result download with its tool name, formats, and the redeem half", () => {
    const post = doc.paths["/api/query/export"]?.post;
    expect(post?.["x-tool"]).toBe("export_sql_result");
    const props = post?.requestBody?.content["application/json"].schema.properties;
    expect(props?.format?.enum).toEqual(["geoparquet", "geojson", "csv"]);
    expect(props?.prepare).toBeDefined();
    const get = doc.paths["/api/query/export"]?.get;
    expect(get).toBeDefined();
    expect(get?.["x-tool"]).toBe(false);
  });
});
