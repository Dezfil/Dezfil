// A Valhalla-speaking fixture provider for the browser gate: answers every origin with one stated square per band and
// a snapped candidate beside the origin. Start it, point
// DEZFIL_ISOCHRONE_URL at it, and the journeys have a provider that never
// flakes and never costs quota.
//
//   node scripts/isochrone-fixture.mjs [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3199);

function square(lon, lat, minutes) {
  const r = 0.005 + minutes * 0.0008;
  return [
    [
      [lon - r, lat - r],
      [lon + r, lat - r],
      [lon + r, lat + r],
      [lon - r, lat + r],
      [lon - r, lat - r],
    ],
  ];
}

createServer((req, res) => {
  const url = new URL(req.url ?? "", "http://x");
  let request;
  try {
    request = JSON.parse(url.searchParams.get("json") ?? "{}");
  } catch {
    res.writeHead(400).end();
    return;
  }
  const origin = request.locations?.[0];
  if (!origin) {
    res.writeHead(400).end();
    return;
  }
  const features = (request.contours ?? []).map((contour) => ({
    type: "Feature",
    properties: { contour: contour.time },
    geometry: {
      type: "Polygon",
      coordinates: square(origin.lon, origin.lat, contour.time),
    },
  }));
  features.push({
    type: "Feature",
    properties: { type: "snapped" },
    geometry: {
      type: "MultiPoint",
      coordinates: [[origin.lon + 0.0003, origin.lat + 0.0003]],
    },
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "FeatureCollection", features }));
}).listen(port, () => {
  console.log(`isochrone fixture answering on :${port}`);
});
