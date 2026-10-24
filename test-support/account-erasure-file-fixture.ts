import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { open } from "../src/lib/metadata/db";

/** An independent file ledger. Do not derive these paths from the inventory:
 * a missing location must fail instead of disappearing from both sides. */
export function populateErasureFiles(directory: string) {
  const db = open(path.join(directory, "metadata.sqlite"));
  db.exec("INSERT INTO workspace_settings VALUES ('fixture', 'control', 'time')");
  const paths = [
    "tables/target.parquet", "tables/control.parquet", "tables/retired-target.parquet", "tables/geocode-stage-target.parquet",
    "tmp/target.geojson", "tmp/control.geojson", "exports/target.zip", "exports/control.zip",
    "tiles/target.pmtiles", "tiles/control.pmtiles", "tiles/scratch/target.geojson", "tiles/scratch/control.parquet",
    "thumbnails/target-light.png", "thumbnails/target-dark.png", "thumbnails/target.json", "thumbnails/control.png",
    "artifact-inputs/thumbnails/target.json", "artifact-inputs/thumbnails/control.json",
    "artifact-inputs/tiles/target.json", "artifact-inputs/tiles/control.json",
    "cache/geocode/target.json", "cache/geocode/control.json", "cache/geocode/.target.tmp",
    "cache/isochrone/target.json", "cache/isochrone/control.json", "cache/overpass/target.json", "cache/overpass/control.json",
    "account-deletions/target.json", "account-deletions/control.json", "account-deletions/partial.json.tmp",
    "file-owners/target.json", "file-owners/control.json",
    "secret.key", "assistant-models.json", "engine-spill/control.tmp",
    "templates/control-template/1/template.json", "templates/control-template/1/record.json",
    "profile-pictures/target.current.webp", "profile-pictures/target.stopped.webp.part", "profile-pictures/control.current.webp",
  ];
  for (const file of paths) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), file.includes("target") ? "target-content-sentinel" : "retained-control-sentinel");
  }
  return { db, paths };
}
