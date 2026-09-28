import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { buildTools } from "./tools";
import { executeTool, elideAttachment } from "./execute";

/**
 * Tool parity (the tool set and the machine-readable API description
 * agree — empty diff, CI-enforced). Extends the parity chain: routes ⟺
 * OpenAPI ⟺ UI calls ⟺ tools.
 */

function documentedOperations(): {
  path: string;
  method: string;
  tool?: string | false;
}[] {
  const doc = buildOpenApiDocument();
  const out: { path: string; method: string; tool?: string | false }[] = [];
  for (const [p, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(
      methods as Record<string, Record<string, unknown>>,
    )) {
      out.push({
        path: p,
        method,
        tool: op["x-tool"] as string | false | undefined,
      });
    }
  }
  return out;
}

describe("tool parity", () => {
  it("every documented operation has exactly one tool, and no extras", () => {
    const ops = documentedOperations().filter((o) => o.tool !== false);
    const tools = buildTools();
    expect(tools.length).toBe(ops.length);

    const opTools = ops.map((o) => o.tool).sort();
    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(opTools);
  });

  it("tool exclusions are exactly the agent transports, binary tiles, and entry exchange", () => {
    // The MCP endpoint and the in-product assistant are how agents reach the
    // API — never tools the agent itself calls. Assistant reservation, recovery
    // and release manage the invoking client's execution ownership; exposing
    // those to its model would recursively operate its own lifecycle. Tile
    // endpoints return MVT bytes for a map renderer; agents read a layer's tile
    // state through render_layer / view_published_map instead. Account entry
    // and session exchange belong to the caller transport. Map
    // thumbnails are binary card images the builder captures. Table export is a
    // browser file download — agents read data through SQL and the features
    // endpoint. The settle-lane renders and published widget values are viewer
    // mechanics: agents read widget values through read_widget_values on the
    // map.
    const excluded = documentedOperations()
      .filter((o) => o.tool === false)
      .map((o) => `${o.method.toUpperCase()} ${o.path}`)
      .sort();
    expect(excluded).toEqual([
      "DELETE /api/assistant/runs/{id}",
      "GET /api/assistant",
      "GET /api/assistant/pending",
      // The policy read: what a page admits and offers is a fact about
      // the assistant's own runs, for a client to ask before it sends;
      // a model calling it would read its own offer.
      "GET /api/assistant/policy",
      "GET /api/assistant/runs/{id}",
      // Entry and session exchange belong to the caller transport.
      "GET /api/auth/entry",
      "GET /api/auth/session",
      // The configured imagery style is a renderer asset, like the tile
      // endpoints below: an agent reads the basemap offer from the
      // configuration, never the style document.
      "GET /api/basemaps/satellite",
      "GET /api/layers/{id}/slider-preview",
      "GET /api/layers/{id}/tiles/{z}/{x}/{y}",
      "GET /api/maps/{id}/thumbnail",
      // The project export's redeem half is the page's native-stream
      // mechanic, exactly like the query one below; agents call the
      // POST directly.
      "GET /api/projects/{id}/export",
      "GET /api/published/{token}/tiles/{layerId}/{z}/{x}/{y}",
      // The query-result download's redeem half is the page's
      // native-stream mechanic; agents call the POST directly.
      "GET /api/query/export",
      "GET /api/tables/{name}/export",
      "POST /api/assistant/messages",
      "POST /api/assistant/runs",
      "POST /api/assistant/runs/{id}/cancel",
      "POST /api/auth/redeem",
      "POST /api/auth/setup",
      "POST /api/auth/sign-in",
      "POST /api/auth/sign-out",
      "POST /api/layers/{id}/render",
      "POST /api/mcp",
      "POST /api/published/{token}/render/{layerId}",
      "POST /api/published/{token}/widget-values",
      "PUT /api/maps/{id}/thumbnail",
    ]);
  });

  it("tool names are unique snake_case", () => {
    const names = buildTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("every tool has a non-empty description", () => {
    for (const tool of buildTools()) {
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
    }
  });

  it("documents the geometry facts on both dependency reads", () => {
    // The tool takes its prose from the operation, so a response-schema
    // addition alone documents nothing an agent can read.
    const byName = new Map(buildTools().map((t) => [t.name, t]));
    for (const name of ["get_map_dependencies", "get_workflow_dependencies"]) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool!.description, name).toMatch(/geometry column/);
      expect(tool!.description, name).toMatch(/sampled geometry type/);
      expect(tool!.inputSchema.required).toEqual(["id"]);
    }
    expect(byName.get("get_workflow_dependencies")!.description).toMatch(
      /never answers partially/,
    );
  });

  it("exposes the export's dataset format as an optional choice", () => {
    const tool = buildTools().find((t) => t.name === "export_project")!;
    const props = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.datasetFormat?.enum).toEqual(["geoparquet", "geojson", "csv"]);
    expect(tool.inputSchema.required ?? []).not.toContain("datasetFormat");
    expect(tool.description).toMatch(/GeoJSON or CSV/);
  });

  it("input schemas are self-contained (no unresolved $ref)", () => {
    for (const tool of buildTools()) {
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain("$ref");
    }
  });

  it("path parameters are required arguments", () => {
    const byName = new Map(buildTools().map((t) => [t.name, t]));
    expect(byName.get("get_map")?.inputSchema.required).toContain("id");
    expect(byName.get("view_published_map")?.inputSchema.required).toContain(
      "token",
    );
    for (const tool of byName.values()) {
      for (const p of tool.pathParams) {
        expect(tool.inputSchema.required, tool.name).toContain(p);
      }
    }
  });

  it("the upload tool takes filename + base64 content", () => {
    const upload = buildTools().find((t) => t.name === "upload_table");
    expect(upload?.upload).toBe(true);
    expect(upload?.inputSchema.required).toEqual([
      "filename",
      "content_base64",
    ]);
    expect(upload?.bodyKeys).toEqual([]);
  });

  it("body keys carry the documented request fields", () => {
    const byName = new Map(buildTools().map((t) => [t.name, t]));
    // run_sql carries the geometry encoding beside the statement.
    expect(byName.get("run_sql")?.bodyKeys).toEqual(["sql", "geometry"]);
    expect(byName.get("export_sql_result")?.bodyKeys).toEqual([
      "sql",
      "format",
      "name",
      "prepare",
    ]);
    expect(byName.get("run_sql")?.inputSchema.required).toContain("sql");
    expect(byName.get("create_layer")?.bodyKeys).toContain("sql");
    expect(byName.get("update_map")?.bodyKeys).toContain("viewport");
    expect(byName.get("create_postgis_connection")?.bodyKeys).toEqual([
      "name",
      "url",
      "host",
      "port",
      "database",
      "username",
      "password",
      "ssl",
    ]);
    expect(byName.get("update_postgis_connection")?.bodyKeys).toEqual([
      "name",
      "url",
      "host",
      "port",
      "database",
      "username",
      "password",
      "ssl",
    ]);
    expect(byName.get("list_postgis_snapshots")?.pathParams).toEqual(["id"]);
    expect(byName.get("preview_postgis_relation")?.pathParams).toEqual(["id"]);
    expect(byName.get("preview_postgis_relation")?.bodyKeys).toEqual([
      "schema",
      "table",
      "filter",
    ]);
    expect(
      byName.get("preview_postgis_relation")?.inputSchema.required,
    ).toEqual(["id", "schema", "table"]);
  });

  it("the layout tool preserves the published position-map bounds", () => {
    const document = buildOpenApiDocument() as unknown as {
      components: {
        schemas: {
          RecipeLayoutInput: {
            properties: Record<
              "steps" | "sources",
              { maxProperties: number; propertyNames: { maxLength: number } }
            >;
          };
        };
      };
    };
    const published =
      document.components.schemas.RecipeLayoutInput.properties;
    const layout = buildTools().find((tool) => tool.name === "set_recipe_layout");
    const properties = layout?.inputSchema.properties as Record<
      string,
      { maxProperties?: number; propertyNames?: { maxLength?: number } }
    >;
    for (const map of ["steps", "sources"] as const) {
      expect(properties[map].maxProperties).toBe(
        published[map].maxProperties,
      );
      expect(properties[map].propertyNames?.maxLength).toBe(
        published[map].propertyNames.maxLength,
      );
    }
  });

  it("exactly the destructive/exposure-changing tools require confirmation", () => {
    const confirmed = buildTools()
      .filter((t) => t.confirm)
      .map((t) => t.name)
      .sort();
    expect(confirmed).toEqual([
      "clear_table_geometry",
      "delete_layer",
      "delete_map",
      "delete_palette",
      "delete_postgis_connection",
      // Dissolving a set is confirmed even though it deletes no object:
      // the gesture reads as deletion to the person asked.
      "delete_project",
      "delete_recipe",
      "delete_table",
      "publish_map",
      "remove_recipe_step",
      "unpublish_map",
    ]);
    for (const tool of buildTools().filter((t) => t.confirm)) {
      expect(tool.description).not.toContain("Requires explicit user confirmation");
      expect(tool.confirmation?.target).toBeTruthy();
      expect(tool.confirmation?.consequence).toBeTruthy();
    }
  });

  /**
   * The fourth case draws out, and the one a boolean cannot hold: one
   * control whose blast radius depends on what it is aimed at.
   */
  it("carries a conditional confirmation for the run whose radius varies", () => {
    const byName = new Map(buildTools().map((t) => [t.name, t]));
    const runRecipe = byName.get("run_recipe");
    expect(runRecipe?.confirmWhen).toBe("when_wide");
    expect(runRecipe?.description).toContain("confirmation");
    // Not flattened into the unconditional set: doing so would over-prompt on
    // a leaf, which is precisely the case the spec says is *not* confirmed.
    expect(runRecipe?.confirm).toBe(false);
    // And the narrow control beside it declares nothing at all.
    expect(byName.get("run_recipe_step")?.confirm).toBe(false);
    expect(byName.get("run_recipe_step")?.confirmWhen).toBeUndefined();
  });
});

describe("executeTool", () => {
  const tools = new Map(buildTools().map((t) => [t.name, t]));

  function fakeFetch(capture: { url?: string; init?: RequestInit }) {
    return (async (url: RequestInfo | URL, init?: RequestInit) => {
      capture.url = String(url);
      capture.init = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  it("substitutes and encodes path parameters", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const result = await executeTool(
      tools.get("inspect_table")!,
      { name: "my table" },
      "http://localhost:3000",
      fakeFetch(capture),
    );
    expect(capture.url).toBe("http://localhost:3000/api/tables/my%20table");
    expect(capture.init?.method).toBe("GET");
    expect(result.status).toBe(200);
  });

  it("retains extra body keys allowed by the declared open object", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await executeTool(
      tools.get("run_sql")!,
      { sql: "SELECT 1", stray: "ignored" },
      "http://localhost:3000/",
      fakeFetch(capture),
    );
    expect(capture.url).toBe("http://localhost:3000/api/query");
    expect(JSON.parse(String(capture.init?.body))).toEqual({ sql: "SELECT 1", stray: "ignored" });
  });

  it("keeps credentials and caller limits out of preview requests and tool results", async () => {
    const secret = "distinctive-tool-secret";
    const capture: { url?: string; init?: RequestInit } = {};
    const echo = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capture.url = String(url);
      capture.init = init;
      return new Response(String(init?.body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const result = await executeTool(
      tools.get("preview_postgis_relation")!,
      {
        id: "c1",
        schema: "public",
        table: "roads",
        filter: "class = 'primary'",
        password: secret,
        url: `postgres://reader:${secret}@db.example.org/gis`,
        limit: 500,
        sql: `SELECT '${secret}'`,
      },
      "http://localhost:3000",
      echo,
    );
    // enforces the documented closed body before dispatch, rather than
    // silently dropping schema-invalid credentials or caller limits.
    expect(capture.url).toBeUndefined();
    expect(result).toMatchObject({ ok: false, body: { error: { code: "invalid_request" } } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("builds multipart uploads from base64 content", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await executeTool(
      tools.get("upload_table")!,
      {
        filename: "points.csv",
        content_base64: Buffer.from("lat,lng\n1,2\n").toString("base64"),
      },
      "http://localhost:3000",
      fakeFetch(capture),
    );
    expect(capture.init?.body).toBeInstanceOf(FormData);
    const file = (capture.init?.body as FormData).get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("points.csv");
  });

  it("sends documented query parameters on the request URL", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await executeTool(
      tools.get("search_map")!,
      { id: "m1", q: "52.5, 13.4", places: "1" },
      "http://localhost:3000",
      fakeFetch(capture),
    );
    expect(capture.url).toBe(
      "http://localhost:3000/api/maps/m1/search?q=52.5%2C+13.4&places=1",
    );
  });

  it("requires required query parameters and drops absent optional ones", async () => {
    const missing = await executeTool(
      tools.get("search_map")!,
      { id: "m1" },
      "http://localhost:3000",
    );
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe(400);

    const capture: { url?: string; init?: RequestInit } = {};
    await executeTool(
      tools.get("search_map")!,
      { id: "m1", q: "alex" },
      "http://localhost:3000",
      fakeFetch(capture),
    );
    expect(capture.url).toBe("http://localhost:3000/api/maps/m1/search?q=alex");
    // The schema exposes the query inputs to the agent, q required.
    const schema = tools.get("search_map")!.inputSchema;
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["id", "q", "places"]),
    );
    expect(schema.required).toEqual(expect.arrayContaining(["id", "q"]));
    expect(schema.required).not.toContain("places");
  });

  it("reports a missing path parameter as a coded error, not a throw", async () => {
    const result = await executeTool(
      tools.get("get_map")!,
      {},
      "http://localhost:3000",
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );
  });

  it("returns API errors as data for agents to branch on", async () => {
    const errorFetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: "not_found", message: "No such map." } }),
        { status: 404, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const result = await executeTool(
      tools.get("get_map")!,
      { id: "nope" },
      "http://localhost:3000",
      errorFetch,
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "not_found",
    );
  });

  it("maps 204 to a null body", async () => {
    const noContent = (async () =>
      new Response(null, { status: 204 })) as typeof fetch;
    const result = await executeTool(
      tools.get("delete_map")!,
      { id: "m1" },
      "http://localhost:3000",
      noContent,
    );
    expect(result).toEqual({ status: 204, ok: true, body: null });
  });

  // Attachment envelope: a download response reaches agents as bytes,
  // never text-decoded — the round trip is byte-for-byte.
  it("wraps an attachment response as a base64 envelope, byte-for-byte", async () => {
    // Deliberately non-UTF8 bytes: text-decoding this corrupts it.
    const payload = Buffer.from([
      0x50, 0x41, 0x52, 0x31, 0x00, 0xff, 0xfe, 0x80, 0x7f, 0x00, 0x01,
    ]);
    const binary = (async () =>
      new Response(new Uint8Array(payload), {
        status: 200,
        headers: {
          "content-type": "application/vnd.apache.parquet",
          "content-disposition": 'attachment; filename="Stations.parquet"',
        },
      })) as typeof fetch;
    const result = await executeTool(
      tools.get("export_layer_data")!,
      { id: "l1", format: "geoparquet" },
      "http://localhost:3000",
      binary,
    );
    expect(result.ok).toBe(true);
    const body = result.body as {
      attachment: {
        filename: string;
        content_type: string;
        size_bytes: number;
        content_base64: string;
      };
    };
    expect(body.attachment.filename).toBe("Stations.parquet");
    expect(body.attachment.content_type).toBe(
      "application/vnd.apache.parquet",
    );
    expect(body.attachment.size_bytes).toBe(payload.byteLength);
    expect(
      Buffer.from(body.attachment.content_base64, "base64").equals(payload),
    ).toBe(true);
  });

  it("refuses an attachment over the documented cap with a coded error", async () => {
    process.env.DEZFIL_TOOL_ATTACHMENT_MAX_MB = "0.001";
    try {
      const big = (async () =>
        new Response(new Uint8Array(4096), {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="big.csv"',
          },
        })) as typeof fetch;
      const result = await executeTool(
        tools.get("export_layer_data")!,
        { id: "l1", format: "csv" },
        "http://localhost:3000",
        big,
      );
      expect(result.ok).toBe(false);
      expect(result.body).toMatchObject({
        error: { code: "attachment_too_large" },
      });
    } finally {
      delete process.env.DEZFIL_TOOL_ATTACHMENT_MAX_MB;
    }
  });

  it("an over-cap attachment rejects without materializing the body", async () => {
    process.env.DEZFIL_TOOL_ATTACHMENT_MAX_MB = "0.001"; // ~1 KB
    try {
      // Declared length over the cap: 413 from the header alone.
      const declared = (async () =>
        new Response(new Uint8Array(16), {
          status: 200,
          headers: {
            "content-type": "application/vnd.apache.parquet",
            "content-disposition": 'attachment; filename="huge.parquet"',
            "content-length": String(64 * 1024 * 1024),
          },
        })) as typeof fetch;
      const overDeclared = await executeTool(
        tools.get("export_layer_data")!,
        { id: "l1", format: "geoparquet" },
        "http://localhost:3000",
        declared,
      );
      expect(overDeclared.status).toBe(413);
      expect(overDeclared.body).toMatchObject({
        error: { code: "attachment_too_large" },
      });

      // Undeclared length: the stream is abandoned the moment it crosses
      // the cap — a would-be multi-GB body pulls only a few chunks, never
      // materializing (the no-buffer proof).
      let pulls = 0;
      const endless = new ReadableStream({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1024));
        },
      });
      const chunked = (async () =>
        new Response(endless, {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="huge.csv"',
          },
        })) as typeof fetch;
      const overStreamed = await executeTool(
        tools.get("export_layer_data")!,
        { id: "l1", format: "csv" },
        "http://localhost:3000",
        chunked,
      );
      expect(overStreamed.status).toBe(413);
      expect(overStreamed.body).toMatchObject({
        error: { code: "attachment_too_large" },
      });
      expect(pulls).toBeLessThan(16);
    } finally {
      delete process.env.DEZFIL_TOOL_ATTACHMENT_MAX_MB;
    }
  });

  it("elides attachment content for model text, keeping the metadata", () => {
    const envelope = {
      attachment: {
        filename: "a.parquet",
        content_type: "application/vnd.apache.parquet",
        size_bytes: 3,
        content_base64: "AAAA",
      },
    };
    const elided = elideAttachment(envelope) as typeof envelope;
    expect(elided.attachment.filename).toBe("a.parquet");
    expect(elided.attachment.size_bytes).toBe(3);
    expect(elided.attachment.content_base64).not.toBe("AAAA");
    expect(elided.attachment.content_base64).toMatch(/elided/);
    // Non-envelope bodies pass through untouched.
    const plain = { rows: 3 };
    expect(elideAttachment(plain)).toBe(plain);
    expect(elideAttachment("text")).toBe("text");
  });
});
