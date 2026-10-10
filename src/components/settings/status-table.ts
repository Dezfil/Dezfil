import type { Part, PartTestAnswer } from "@/lib/system/part-test-answer";
import type { PartStates } from "@/lib/system/part-states";
import type { InstanceRead } from "./instance-read";

/**
 * System's Status rows, one per part with a Test: the row's address, label
 * and search words, the meta line under its label, and the state beside its
 * Test. The state comes from the configuration read (the data folder's from
 * the readiness check) and follows a Test's answer where the answer says
 * more: a pass is the part working, a program not found is not found.
 */

export interface StatusRowFacts {
  readonly id: string;
  readonly label: string;
  readonly keys: string;
}

export const STATUS_ROWS: Readonly<Record<Part, StatusRowFacts>> = {
  data_folder: { id: "sys-data-folder", label: "Data folder", keys: "data directory disk volume writable test" },
  query_engine: { id: "sys-engine", label: "Query engine", keys: "duckdb engine extensions spatial h3 json test" },
  tile_builder: { id: "sys-tiler", label: "Tile builder", keys: "tippecanoe pmtiles tiles test" },
  image_renderer: { id: "sys-renderer", label: "Image renderer", keys: "chromium browser export png render images at once test" },
  metadata_database: { id: "sys-metadata", label: "Metadata database", keys: "sqlite metadata database test" },
};

/** The readiness check's answer, the data folder's state before a Test. */
export type Health = "checking" | "ready" | "unready";

/** A part's state: a dot's tone and its words, or the quiet Checking. */
export interface PartState {
  readonly tone: "on" | "off" | "danger" | "checking";
  readonly text: string;
}

/** The line under a part's label: a path or a file name in the code face,
 * else a program and what is known of it. */
export interface PartMeta {
  readonly text: string;
  readonly mono?: boolean;
}

const WRITABLE: PartState = { tone: "on", text: "Writable" };
const NOT_WRITABLE: PartState = { tone: "danger", text: "Not writable" };
const READY: PartState = { tone: "on", text: "Ready" };
const NOT_STARTED: PartState = { tone: "off", text: "Not started yet" };
const FOUND: PartState = { tone: "on", text: "Found" };
const NOT_FOUND: PartState = { tone: "danger", text: "Not found" };

export function partMeta(part: Part, read: Pick<InstanceRead, "settings" | "parts">): PartMeta | null {
  const parts: PartStates = read.parts;
  switch (part) {
    case "data_folder": {
      const folder = read.settings.dataDir?.value;
      return typeof folder === "string" ? { text: folder, mono: true } : null;
    }
    case "query_engine": {
      const engine = parts.query_engine;
      const name = engine.version ? `DuckDB ${engine.version}` : "DuckDB";
      return { text: engine.started && engine.extensions.length ? `${name} · ${engine.extensions.join(", ")}` : name };
    }
    case "tile_builder": return { text: parts.tile_builder.version ? `tippecanoe ${parts.tile_builder.version}` : "tippecanoe" };
    case "image_renderer": return { text: `Chromium · ${parts.image_renderer.imagesAtOnce} at once` };
    case "metadata_database": return { text: parts.metadata_database.file, mono: true };
  }
}

/** The part's state: the last Test's answer where it decides it, else what
 * the reads report. */
export function partState(part: Part, parts: PartStates, health: Health, answer: PartTestAnswer | null): PartState {
  const passed = answer?.result === "passed";
  const notFound = answer?.result === "failed" && answer.reason === "not_found";
  switch (part) {
    case "data_folder":
      if (answer) return passed ? WRITABLE : NOT_WRITABLE;
      return health === "checking" ? { tone: "checking", text: "Checking" } : health === "ready" ? WRITABLE : NOT_WRITABLE;
    case "query_engine":
      if (passed) return READY;
      if (notFound) return NOT_STARTED;
      return parts.query_engine.started ? READY : NOT_STARTED;
    case "tile_builder":
    case "image_renderer":
      if (passed) return FOUND;
      if (notFound) return NOT_FOUND;
      return parts[part].found ? FOUND : NOT_FOUND;
    case "metadata_database":
      return READY;
  }
}
