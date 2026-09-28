// A shared geographic landmark for browser and in-container export probes.
// The basemap draws a red disc; the data layer draws a smaller green disc
// at the same coordinate. Their decoded centroids must coincide.
import { createServer } from "node:http";
import { decodePng } from "./png-probe.mjs";

export const ALIGNMENT_DATA = [26, 93, 74];
export const ALIGNMENT_GROUND = [224, 48, 80];
export const alignmentPoint = (sign) => [12, sign * 85.035];
export const alignmentBackground = (theme) => theme === "dark" ? "#1a2a3a" : "#f0e6c8";

// At an unpadded endpoint camera, coverage puts the nearest world edge at
// the canvas edge. Project the landmark from that edge independently of
// either renderer, so two equally misplaced discs cannot certify alignment.
export function expectedPoleLandmarkPixel(sign, width = 512, height = 512, zoom = 10) {
  const [, latitude] = alignmentPoint(1);
  const northing = 0.5 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / (2 * Math.PI);
  const fromWorldEdge = northing * 512 * 2 ** zoom;
  return { x: width / 2, y: sign > 0 ? fromWorldEdge : height - fromWorldEdge };
}

export function alignmentPositionError(stats, sign) {
  const expected = expectedPoleLandmarkPixel(sign, stats.width, stats.height);
  return Math.max(...[stats.data, stats.ground].flatMap(point => [
    point.x === null ? Infinity : Math.abs(point.x - expected.x),
    point.y === null ? Infinity : Math.abs(point.y - expected.y),
  ]));
}

export function alignmentStyle(sign, theme = "light") {
  return {
    version: 8,
    sources: { landmark: { type: "geojson", data: {
      type: "FeatureCollection", features: [{ type: "Feature", properties: {},
        geometry: { type: "Point", coordinates: alignmentPoint(sign) } }],
    } } },
    layers: [
      { id: "background", type: "background", paint: { "background-color": alignmentBackground(theme) } },
      { id: "landmark", type: "circle", source: "landmark", paint: {
        "circle-radius": 30, "circle-color": "#e03050", "circle-pitch-alignment": "map",
      } },
    ],
  };
}

export async function startAlignmentBasemap() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(alignmentStyle(url.pathname.includes("south") ? -1 : 1,
      url.pathname.includes("dark") ? "dark" : "light")));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

export function alignmentStats(png) {
  const image = decodePng(png);
  const stats = [ALIGNMENT_GROUND, ALIGNMENT_DATA].map(color => {
    let count = 0, sumX = 0, sumY = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const pixel = image.at(x, y);
        if (color.every((channel, i) => Math.abs(pixel[i] - channel) <= 12)) {
          count++; sumX += x; sumY += y;
        }
      }
    }
    return { count, x: count ? sumX / count : null, y: count ? sumY / count : null };
  });
  return { width: image.width, height: image.height, ground: stats[0], data: stats[1], corner: image.at(5, 5).slice(0, 3) };
}
