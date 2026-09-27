// Run inside the candidate image, with --network=none and loopback allowed.
// Usage: node /probes/offline-alignment-probe.mjs /evidence [--tiled]
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { alignmentPoint, alignmentPositionError, alignmentStats, startAlignmentBasemap } from "./map-alignment-fixture.mjs";

const base = "http://127.0.0.1:3000";
const output = process.argv[2] ?? "/tmp/alignment-evidence";
const tiled = process.argv.includes("--tiled");
const basemap = await startAlignmentBasemap();
const evidence = [];
await mkdir(output, { recursive: true });

async function json(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

try {
  await json("/api/health");
  for (const [pole, sign] of [["north", 1], ["south", -1]]) {
    let table, map;
    try {
      const [lng, lat] = alignmentPoint(sign);
      const form = new FormData();
      form.append("file", new Blob([`name,lon,lat\nlandmark,${lng},${lat}\n`], { type: "text/csv" }), `align_${pole}_${Date.now()}.csv`);
      const uploaded = await fetch(`${base}/api/tables`, { method: "POST", body: form });
      if (!uploaded.ok) throw new Error(`Upload: ${uploaded.status} ${await uploaded.text()}`);
      table = (await uploaded.json()).name;
      map = (await json("/api/maps", "POST", { name: `Pole alignment ${pole}` })).id;
      const layer = await json(`/api/maps/${map}/layers`, "POST", {
        name: "landmark", sql: tiled ? `SELECT ST_Point(
          ST_X(p.geometry) + ((r.i % 49) - 24) * 0.000001,
          ST_Y(p.geometry) + (floor(r.i / 49) - 24) * 0.000001
        ) AS geometry FROM "${table}" p CROSS JOIN range(0, 2401) AS r(i)` : `SELECT * FROM "${table}"`,
      });
      await json(`/api/layers/${layer.id}`, "PATCH", { style: {
        fill: { type: "constant", color: { r: 26, g: 93, b: 74, a: 1 } },
        stroke: { r: 26, g: 93, b: 74, a: 1 },
        fillOpacity: 1, strokeOpacity: 0, strokeWidth: 0, pointRadius: 12, opacity: 1,
      } });
      await json(`/api/maps/${map}`, "PATCH", {
        customBasemap: { url: `${basemap.url}/${pole}-light.json`, name: "Local landmark", force: true },
      });
      let render;
      const deadline = Date.now() + 120_000;
      do {
        render = await json(`/api/layers/${layer.id}/render`);
        if (render.tiles?.state !== "building") break;
        if (Date.now() > deadline) throw new Error("Tiled landmark did not settle");
        await new Promise(resolve => setTimeout(resolve, 500));
      } while (true);
      if (tiled && (render.mode !== "tiled" || render.tiles?.state !== "ready")) {
        throw new Error(`Expected ready tiled landmark: ${JSON.stringify(render)}`);
      }
      if (!tiled && render.mode !== "inline") throw new Error(`Expected inline landmark: ${render.mode}`);
      const definition = {
        viewport: { lng, lat: sign * 85.051129, zoom: 10, pitch: 0, bearing: 0 },
        size: { width: 512, height: 512 }, mapScale: 1,
        legend: { visible: false, corner: "bottom-left", size: "m" }, widgets: [], title: null, appearance: "light",
      };
      const response = await fetch(`${base}/api/maps/${map}/export/image`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ definition }),
      });
      if (!response.ok) throw new Error(`Export: ${response.status} ${await response.text()}`);
      const png = Buffer.from(await response.arrayBuffer());
      const filename = `${pole}-${tiled ? "tiled" : "inline"}.png`;
      await writeFile(join(output, filename), png);
      const stats = alignmentStats(png);
      const positionError = alignmentPositionError(stats, sign);
      if (stats.width !== 512 || stats.height !== 512 || positionError >= 1.5
        || stats.data.count <= 15 || stats.ground.count <= 40
        || Math.abs(stats.data.x - stats.ground.x) >= 1.5
        || Math.abs(stats.data.y - stats.ground.y) >= 1.5) {
        throw new Error(`Basemap/data alignment failed: ${JSON.stringify(stats)}`);
      }
      evidence.push({ pole, mode: render.mode, filename, definition, stats, positionError });
      console.log(JSON.stringify(evidence.at(-1)));
    } finally {
      if (map) await json(`/api/maps/${map}`, "DELETE");
      if (table) await json(`/api/tables/${table}`, "DELETE");
    }
  }
  await writeFile(join(output, `alignment-${tiled ? "tiled" : "inline"}.json`), JSON.stringify(evidence, null, 2) + "\n");
} finally {
  await basemap.close();
}
