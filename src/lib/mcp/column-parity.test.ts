import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { GET as readLayerRoute, PATCH as layerRoute } from "@/app/api/layers/[id]/route";
import { buildMcpFetchHandler } from "./handler";

/**
 * parity: a column refusal is byte-identical for a headless MCP
 * caller and a direct HTTP caller of the same lane — same code, same
 * copy, same status class. The MCP wire path is real: stock client →
 * /api/mcp handler → tool executor → the actual layer route, looped
 * in-process.
 */

let dir: string;
let layerId: string;

const BAD_STYLE = {
  fill: {
    type: "quantile",
    attribute: "typo",
    palette: "viridis",
    breaks: [1],
    colors: [
      { r: 0, g: 0, b: 0, a: 1 },
      { r: 1, g: 1, b: 1, a: 1 },
    ],
  },
  fillOpacity: 1,
  stroke: { r: 0, g: 0, b: 0, a: 1 },
  strokeOpacity: 1,
  strokeWidth: 1,
  pointRadius: 4,
  opacity: 1,
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "assets.csv");
  await writeFile(src, "name,val,lon,lat\na,1,1,2\nb,2,3,4\n");
  await ingestFile(testAccountScope(), src, "assets.csv");
  const map = createMap(testAccountScope(), "parity");
  const layer = await createLayer(testAccountScope(), map.id, {
    name: "l",
    sql: "SELECT * FROM assets",
  }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  layerId = layer.id;

  const handler = buildMcpFetchHandler();
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const { pathname } = new URL(url);
      const request = input instanceof Request ? input : new Request(url, init);
      if (pathname === "/api/mcp") return handler.fetch(request);
      const layerMatch = /^\/api\/layers\/([^/]+)$/.exec(pathname);
      if (layerMatch) {
        const route = request.method === "GET" ? readLayerRoute : layerRoute;
        return route(testAccountRequest(request), {
          params: Promise.resolve({ id: layerMatch[1] }),
        });
      }
      throw new Error(`Unexpected self-call in test: ${pathname}`);
    }) as typeof fetch,
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("column refusal parity", () => {
  it("MCP and the route report the identical coded refusal", async () => {
    const client = new Client({ name: "parity", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL("http://localhost:3000/api/mcp"),
      ),
    );
    const result = await client.callTool({
      name: "update_layer",
      arguments: { id: layerId, style: BAD_STYLE, expected_revision: readEditRevision({ kind: "map", id: readEditLayer(layerId)!.mapId })!.editRevision! },
    });
    const text = (result.content as { type: string; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    const viaMcp = JSON.parse(text) as {
      error?: { code?: string; message?: string };
    };
    expect(result.isError).toBe(true);
    expect(viaMcp.error?.code).toBe("column_unavailable");
    await client.close();

    const direct = await layerRoute(
      testAccountRequest(new Request(`http://localhost:3000/api/layers/${layerId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "X-Edit-Revision": readEditRevision({ kind: "map", id: readEditLayer(layerId)!.mapId })!.editRevision! },
        body: JSON.stringify({ style: BAD_STYLE }),
      })),
      { params: Promise.resolve({ id: layerId }) },
    );
    expect(direct.status).toBe(400);
    const body = (await direct.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("column_unavailable");
    // Identical shape and identical copy — not merely the same class.
    expect(body.error.message).toBe(viaMcp.error?.message);
  }, 30_000);
});

it("returns a stored legacy style through the closed tool output schema", async () => {
  const layer = readEditLayer(layerId)!;
  metadataDb().prepare("UPDATE layers SET style = ? WHERE id = ?").run(
    JSON.stringify({ ...layer.style, undefined: 4 }), layerId,
  );
  const client = new Client({ name: "style-read", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3000/api/mcp")));
  try {
    const result = await client.callTool({ name: "get_layer", arguments: { id: layerId } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ result: { style: layer.style } });
    expect(result.structuredContent).not.toHaveProperty("result.style.undefined");
  } finally {
    await client.close();
  }
}, 30_000);
