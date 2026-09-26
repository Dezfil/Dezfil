/**
 * KML test fixtures (0063). KML is plain XML; the fixture is authored
 * directly rather than through any writer library.
 */

export interface KmlFolder {
  name: string;
  /** [lon, lat, name] placemarks; empty array = a folder with no geometry. */
  points: [number, number, string][];
}

export function buildKml(folders: KmlFolder[]): string {
  const body = folders
    .map((folder) => {
      const placemarks = folder.points
        .map(
          ([lon, lat, name]) =>
            `<Placemark><name>${name}</name><Point><coordinates>${lon},${lat},0</coordinates></Point></Placemark>`,
        )
        .join("\n");
      return `<Folder><name>${folder.name}</name>\n${placemarks}\n</Folder>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
${body}
</Document></kml>`;
}
