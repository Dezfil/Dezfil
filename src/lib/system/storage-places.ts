import { STORAGE_RESERVE_NAME } from "./storage-reserve";
import { PICTURE_RECORD, STAGED_EXPORT_RECORD } from "@/lib/ingest/file-ownership";
import type { StorageKind } from "./storage-answer";

/**
 * The places table: which kind a file in the data folder is, from where it
 * sits and, for a table file or a tile archive, whether the metadata or an
 * installed template references it. Templates are the downloaded versions
 * (`templates/`) and the engine's copies of an installed version's data in
 * the artifact directory, which no sweep removes while a version needs
 * them. Leftover files are exactly what the next restart's sweeps
 * remove: the upload and download scratch (`tmp/`), the tile scratch
 * (`tiles/scratch/`), staged project exports (`exports/`), table files no
 * dataset or installed template uses, archives no tile record names and
 * the build evidence of those archives, unfinished thumbnail writes (a
 * `.tmp` beside the images and their evidence), the ownership records
 * of the staged exports, told by their names, which the restart's recovery
 * removes with them, written or not, and every file in the profile
 * pictures' folder that is not an account's current picture (a replaced
 * one, an unfinished write, one no account names) with the records of
 * pictures that are not current, also told by their names. A test holds
 * this table against the sweeps themselves, so a place they learn to clear
 * is a finding here.
 *
 * Paths are taken as segments under the data folder; nothing here touches
 * the disk.
 */

/** What the metadata and the installed templates reference, by the names
 * the files carry. */
export interface StorageReferences {
  /** The file names of the tables the metadata registers. */
  readonly tableFiles: ReadonlySet<string>;
  /** The layers with a tile record. */
  readonly tileLayers: ReadonlySet<string>;
  /** The file names, in the artifact directory, of the engine's copies of
   * an installed template's data. */
  readonly templateFiles: ReadonlySet<string>;
  /** The file names of the accounts' current pictures. */
  readonly pictureFiles: ReadonlySet<string>;
  /** The names of those pictures' ownership records. */
  readonly pictureRecords: ReadonlySet<string>;
}

const METADATA_FILES = new Set(["metadata.sqlite", "metadata.sqlite-wal", "metadata.sqlite-shm", "metadata.sqlite-journal"]);
const ARCHIVE = ".pmtiles";
const EVIDENCE = ".json";
const UNFINISHED_WRITE = ".tmp";

/** The kind of the file at `segments`, a path under the data folder. */
export function placeOf(segments: readonly string[], references: StorageReferences): StorageKind {
  const [top, second, third] = segments;
  if (segments.length === 1 && top === STORAGE_RESERVE_NAME) return "other";
  if (segments.length === 1) return METADATA_FILES.has(top) ? "metadata_database" : "other";
  switch (top) {
    // A table's file, or everything under one entry of the folder, by that entry's name.
    case "tables":
      if (references.tableFiles.has(second)) return "tables";
      return references.templateFiles.has(second) ? "templates" : "leftover_files";
    case "templates": return "templates";
    case "tiles":
      if (second === "scratch") return "leftover_files";
      if (second.endsWith(ARCHIVE)) return references.tileLayers.has(second.slice(0, -ARCHIVE.length)) ? "tile_archives" : "leftover_files";
      return "other";
    case "thumbnails": return second.endsWith(UNFINISHED_WRITE) ? "leftover_files" : "thumbnails";
    case "artifact-inputs":
      if (segments.length === 2) return "other";
      if (second === "thumbnails") return third.endsWith(UNFINISHED_WRITE) ? "leftover_files" : "thumbnails";
      if (second === "tiles") {
        // An archive's evidence follows its record; a half-written one is no sweep's.
        if (!third.endsWith(EVIDENCE)) return "tile_archives";
        return references.tileLayers.has(third.slice(0, -EVIDENCE.length)) ? "tile_archives" : "leftover_files";
      }
      return "other";
    case "profile-pictures": return segments.length === 2 && references.pictureFiles.has(second) ? "profile_pictures" : "leftover_files";
    case "file-owners":
      if (segments.length !== 2) return "other";
      if (second.startsWith(STAGED_EXPORT_RECORD)) return "leftover_files";
      if (second.startsWith(PICTURE_RECORD)) return references.pictureRecords.has(second) ? "other" : "leftover_files";
      return "other";
    case "cache": return "service_caches";
    case "tmp":
    case "exports": return "leftover_files";
    default: return "other";
  }
}

const ALL: readonly StorageKind[] = ["tables", "tile_archives", "service_caches", "thumbnails", "profile_pictures", "templates", "metadata_database", "leftover_files", "other"];

/** The kinds a file somewhere under the folder `dir` may be: what a walk
 * stopped before it finished that folder leaves unfinished. */
export function kindsWithin(dir: readonly string[], references: StorageReferences): readonly StorageKind[] {
  const at = dir.join("/");
  switch (at) {
    case "": return ALL;
    case "tables": return ["tables", "templates", "leftover_files"];
    case "tiles": return ["tile_archives", "leftover_files", "other"];
    case "thumbnails":
    case "artifact-inputs/thumbnails": return ["thumbnails", "leftover_files"];
    case "artifact-inputs": return ["tile_archives", "thumbnails", "leftover_files", "other"];
    case "artifact-inputs/tiles": return ["tile_archives", "leftover_files"];
    case "file-owners": return ["other", "leftover_files"];
    case "profile-pictures": return ["profile_pictures", "leftover_files"];
    // Deeper, the folder's own place decides every file under it.
    default: return [placeOf([...dir, ""], references)];
  }
}
