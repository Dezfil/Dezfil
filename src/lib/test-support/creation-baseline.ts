import { metadataDb } from "@/lib/metadata/db";
import { POST as postMap } from "@/app/api/maps/route";
import { POST as postLayer } from "@/app/api/maps/[id]/layers/route";
import { POST as postSketch } from "@/app/api/maps/[id]/sketches/route";
import { testAccountRequest } from "./accounts";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Row = Record<string, unknown>;

/** One layer per geometry family the default style tells apart, added in
 * this order, so each takes the next color of the cycle. */
export const BASELINE_LAYERS = [
  { role: "points layer", name: "Points", sql: "SELECT ST_Point(13.40, 52.52) AS geom" },
  { role: "lines layer", name: "Lines", sql: "SELECT ST_GeomFromText('LINESTRING (13.30 52.45, 13.50 52.58)') AS geom" },
  { role: "areas layer", name: "Areas", sql: "SELECT ST_GeomFromText('POLYGON ((13.30 52.45, 13.50 52.45, 13.50 52.58, 13.30 52.45))') AS geom" },
] as const;

const SKETCH_FEATURE = { kind: "point", geometry: { type: "Point", coordinates: [13.45, 52.5] } };
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const GENERATED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/;

/**
 * A map made the way every client makes one, through the operations: the
 * map, then a points, a lines and an areas layer from SQL with no style,
 * then a drawn sketch. What the calls answered and what they stored (the
 * map's row, its layers' rows and its history) are returned as one JSON
 * text with every generated identity replaced by its role and every time
 * by `<time>`, so the same calls give the same text on every run. A
 * capture of this taken before new maps and layers read anything but the
 * product's constants is the fixture the creation test compares against.
 */
export async function creationBaseline(): Promise<string> {
  const call = async (handler: Handler, url: string, body: unknown, id = "", revision?: string) => {
    const request = testAccountRequest(new Request(`http://instance.test${url}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...(revision ? { "X-Edit-Revision": revision } : {}) },
    }));
    const response = await handler(request, { params: Promise.resolve({ id }) });
    const answer = { status: response.status, body: await response.json() as Row };
    if (response.status !== 201) throw new Error(`${url} answered ${response.status}: ${JSON.stringify(answer.body)}`);
    return answer;
  };
  const map = await call(postMap, "/api/maps", { name: "Baseline" });
  const mapId = String(map.body.id);
  const revisions = [String(map.body.editRevision)];
  const layers = [];
  for (const layer of BASELINE_LAYERS) {
    const added = await call(postLayer, `/api/maps/${mapId}/layers`, { name: layer.name, sql: layer.sql }, mapId, revisions.at(-1));
    revisions.push(String(added.body.editRevision));
    layers.push(added);
  }
  const sketch = await call(postSketch, `/api/maps/${mapId}/sketches`, { feature: SKETCH_FEATURE }, mapId, revisions.at(-1));
  revisions.push(String(sketch.body.editRevision));

  const db = metadataDb();
  const stored = {
    map: db.prepare("SELECT * FROM maps WHERE id = ?").get(mapId) as Row,
    layers: db.prepare("SELECT * FROM layers WHERE map_id = ? ORDER BY ordinal").all(mapId) as Row[],
    history: db.prepare("SELECT * FROM map_history WHERE map_id = ? ORDER BY seq").all(mapId) as Row[],
  };
  const roles: [string, string][] = [
    [mapId, "<map>"],
    ...layers.map((added, i): [string, string] => [String(added.body.id), `<${BASELINE_LAYERS[i].role}>`]),
    [String(sketch.body.layerId), "<sketch layer>"],
    [String(sketch.body.tableId), "<sketch dataset>"],
    [String(sketch.body.featureId), "<sketch feature>"],
    ...revisions.map((revision, i): [string, string] => [revision, `<revision ${i + 1}>`]),
    ...stored.history.flatMap((step, i): [string, string][] => [
      [String(step.id), `<step ${i + 1}>`],
      ...(step.group_id ? [[String(step.group_id), `<group of step ${i + 1}>`] as [string, string]] : []),
    ]),
  ];
  let text = JSON.stringify({ calls: { map, layers, sketch }, stored }, null, 2) + "\n";
  for (const [value, role] of roles) text = text.split(value).join(role);
  text = text.replace(TIME, "<time>");
  const unnamed = text.match(GENERATED);
  if (unnamed) throw new Error(`The capture holds a generated value with no role: ${unnamed[0]}`);
  return text;
}
