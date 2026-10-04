import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { testAccountScope } from "@/lib/test-support/accounts";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { publishMap } from "@/lib/publish/publish-service";

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

/**
 * A single-user store with a published map on plain names, built the same
 * way every time, and what an anonymous reader receives from its link: the
 * view, the widget values and a layer's extent, with the identities that
 * differ from run to run replaced by their role. A capture of this taken
 * before publications evaluated in a restricted mount is the fixture the
 * upgrade test compares against.
 */
export async function singleUserPublication(directory: string): Promise<string> {
  const scope = testAccountScope();
  for (const [file, body] of [
    ["roads.csv", "sentinel,lon,lat\nroad,13.4,52.5\nlane,13.5,52.6\n"],
    ["stats.csv", "name,value\nalpha,1\nbeta,2\n"],
    ["parks.csv", "sentinel,lon,lat\npark,13.3,52.4\n"],
  ]) {
    const source = path.join(directory, file);
    await writeFile(source, body);
    await ingestFile(scope, source, file);
  }
  const map = createMap(scope, "Survey");
  const layers = [
    await createLayer(scope, map.id, { name: "Roads", sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
    await createLayer(scope, map.id, { name: "Stats", sql: "SELECT name, value, ST_Point(value, value) AS geom FROM main.stats" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
    await createLayer(scope, map.id, { name: "Lanes", sql: "SELECT * FROM query_table('roads') WHERE sentinel = 'lane'" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
  ];
  updateMap(scope, map.id, { widgets: [{ id: "count", type: "formula", layerId: layers[0].id, title: "Count", field: null,
    agg: "count", aggField: null, unit: null, note: null, format: null, visible: true }] }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  const { token } = publishMap(scope, map.id, {}, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  const call = async (load: () => Promise<Record<string, unknown>>, method: string, url: string, params: Record<string, string>) => {
    const response = await ((await load())[method] as Handler)(socketRequest(new Request(`http://instance.test${url}`, { method,
      headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) })), { params: Promise.resolve(params) });
    return { status: response.status, body: await response.json() as unknown };
  };
  const captured = {
    view: await call(() => import("@/app/api/published/[token]/route"), "GET", `/api/published/${token}`, { token }),
    widgets: await call(() => import("@/app/api/published/[token]/widget-values/route"), "POST",
      `/api/published/${token}/widget-values`, { token }),
    extent: await call(() => import("@/app/api/published/[token]/extent/[layerId]/route"), "POST",
      `/api/published/${token}/extent/${layers[0].id}`, { token, layerId: layers[0].id }),
  };
  let text = JSON.stringify(captured, null, 2) + "\n";
  for (const [value, role] of [[token, "<token>"], [map.id, "<map>"], ...layers.map((layer, i) => [layer.id, `<layer ${i}>`])]) {
    text = text.split(value).join(role);
  }
  return text;
}
