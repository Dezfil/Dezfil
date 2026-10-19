import { pictureRendererAvailable } from "@/lib/pictures/renderer";
import path from "node:path";
import { version as engineVersion } from "@duckdb/node-api";
import { queryEngineExtensions } from "@/lib/duckdb";
import { chromiumPath } from "@/lib/export/render-drive";
import { knownTilerVersion, tilerFound } from "@/lib/tiles/tiler";
import { executableFound } from "./executable";
import type { PartStates } from "./part-states";

/**
 * Each part's state for the configuration read. It starts nothing and runs
 * no program: the engine's version comes from the library itself, whether
 * the engine has started and what it loaded from what it recorded as it
 * started; the tile builder and the image renderer are found by a file
 * check of where their settings point, never by running them, and the tile
 * builder's version is the one its last run answered, none before.
 */

/** The version number in a version banner, never the rest of its words. */
function versionNumber(banner: string | null): string | null {
  return banner?.match(/\d+(?:\.\d+)+/)?.[0] ?? null;
}

export function readPartStates({ imagesAtOnce, metadataFile }: {
  /** Images at once in effect, as the read resolved it. */
  imagesAtOnce: number;
  /** The metadata database's file, as opened. */
  metadataFile: string;
}): PartStates {
  const extensions = queryEngineExtensions();
  return {
    query_engine: { version: versionNumber(engineVersion()), started: extensions !== null, extensions: extensions ? [...extensions] : [] },
    tile_builder: { found: tilerFound(), version: versionNumber(knownTilerVersion()) },
    image_renderer: { found: executableFound(chromiumPath()), available: pictureRendererAvailable(), imagesAtOnce },
    metadata_database: { file: path.basename(metadataFile) },
  };
}
