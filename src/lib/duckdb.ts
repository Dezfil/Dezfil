import {
  DuckDBInstance,
  type DuckDBConnection,
} from "@duckdb/node-api";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { loadTrustedH3 } from "./trusted-h3";
import { limits } from "@/lib/limits";
import { ensureTileDirs, tileScratchDir } from "@/lib/tiles/paths";

/**
 * Server-side query engine. Two separate in-memory instances share the
 * process: a trusted one for ingest/inspection, and a hardened one for user
 * SQL — filesystem fenced to the artifact directory, extension loading off,
 * configuration locked. Keeping them apart means hardening user queries can
 * never break trusted operations. All durable data lives in GeoParquet
 * artifacts under the data directory, never inside DuckDB itself.
 *
 * The spatial extension is installed at Docker build time (see
 * scripts/install-duckdb-extensions.mjs); DUCKDB_EXTENSION_DIR points at the
 * baked directory so runtime needs no network. In local dev the default
 * extension directory is used and installs on demand.
 */

let instancePromise: Promise<DuckDBInstance> | null = null;
let queryInstancePromise: Promise<DuckDBInstance> | null = null;

function baseConfig(): Record<string, string> {
  const config: Record<string, string> = {};
  if (process.env.DUCKDB_EXTENSION_DIR) {
    config.extension_directory = process.env.DUCKDB_EXTENSION_DIR;
  }
  return config;
}

async function loadSpatial(conn: DuckDBConnection): Promise<void> {
  try {
    await conn.run("LOAD spatial");
  } catch {
    await conn.run("INSTALL spatial");
    await conn.run("LOAD spatial");
  }
}

/**
 * h3 (community extension) powers hexagonal aggregation. Unlike spatial it is
 * optional: if it cannot load (e.g. Offline dev without a prior install), the
 * instance still comes up and only hex-bin layers fail, with a layer-scoped
 * error (plan: degrade, don't break).
 */
let h3Loaded = false;

async function loadH3(conn: DuckDBConnection): Promise<void> {
  try {
    await conn.run("LOAD h3");
    h3Loaded = true;
  } catch {
    try {
      await conn.run("INSTALL h3 FROM community");
      await conn.run("LOAD h3");
      h3Loaded = true;
    } catch {
      h3Loaded = false;
    }
  }
}

/** Whether hexagonal binning is available on the query instance. */
export function h3Available(): boolean {
  return h3Loaded;
}

/**
 * The same answer, but only once there is an instance to have answered it.
 *
 * `h3Available` reads a flag the hardened instance sets **while it loads its
 * extensions**, so on a cold process it says "absent" for a start-up reason
 * rather than a capability one. Admission asks this instead: a verb that needs
 * H3 must refuse because the extension could not load, never because it asked
 * first.
 *
 * **Through the bounded boundary, not around it.** Building the instance is
 * where `LOAD h3` can fall through to a community `INSTALL` over the network,
 * and a stalled fetch there would hold admission open past the query timeout —
 * the caller waiting on a coded refusal that never arrives. The bounded
 * evaluation's contract covers first-instance creation for exactly this
 * reason, so readiness is established inside it. Found at the cross-model
 * review.
 */
export async function h3Ready(): Promise<boolean> {
  const { boundedEvaluation } = await import("@/lib/query/bounded");
  await boundedEvaluation(async () => undefined);
  return h3Loaded;
}

/**
 * json powers the OSM tags column (un-promoted tags stay queryable).
 * Autoload is off on the hardened instance, so it loads explicitly
 * before lockdown; optional like h3 — without it only json-function
 * queries fail, with the engine's own message.
 */
async function loadJson(conn: DuckDBConnection): Promise<void> {
  try {
    await conn.run("LOAD json");
  } catch {
    try {
      await conn.run("INSTALL json");
      await conn.run("LOAD json");
    } catch {
      /* Json functions unavailable — degrade, don't break */
    }
  }
}

function getInstance(): Promise<DuckDBInstance> {
  if (!instancePromise) {
    const attempt = DuckDBInstance.create(":memory:", baseConfig()).catch((error) => {
      if (instancePromise === attempt) instancePromise = null;
      throw error;
    });
    instancePromise = attempt;
  }
  return instancePromise;
}

/** Optional ingest capability, separate from the hardened instance's flag.
 * Requested only when the bounded CSV sample contains H3-shaped text. */
export async function trustedH3Ready(): Promise<boolean> {
  return loadTrustedH3(await getInstance());
}

async function createHardenedInstance(): Promise<DuckDBInstance> {
  const instance = await DuckDBInstance.create(":memory:", baseConfig());
  try {
    const conn = await instance.connect();
    try {
      // Load extensions first — loading is impossible after the lockdown.
      await loadSpatial(conn);
      await loadH3(conn);
      await loadJson(conn);
      // allowed_directories only applies once external access is disabled:
      // together they fence the filesystem to the artifact directory plus the
      // tile scratch directory — the one writable spot, where tile builds
      // export the effective query. Served archives live one level above the
      // scratch and stay out of reach of user SQL.
      ensureTileDirs();
      const fence = [path.join(dataDir(), "tables"), tileScratchDir()]
        .map((p) => `'${p.replace(/'/g, "''")}'`)
        .join(", ");
      await conn.run(`SET GLOBAL allowed_directories = [${fence}]`);
      // User SQL runs inside a memory budget: a query pushed over it fails
      // with a coded error and the instance survives. Spilling is disabled
      // explicitly — DuckDB gives even in-memory instances a default temp
      // directory under the working directory, and a spilling query turns the
      // budget into a slow disk grind instead of the clean coded failure the
      // plan ratified.
      await conn.run(
        `SET GLOBAL memory_limit = '${Math.round(limits.queryMemoryMb)}MB'`,
      );
      await conn.run("SET GLOBAL temp_directory = ''");
      await conn.run("SET GLOBAL enable_external_access = false");
      await conn.run("SET GLOBAL autoinstall_known_extensions = false");
      await conn.run("SET GLOBAL autoload_known_extensions = false");
      await conn.run("SET GLOBAL lock_configuration = true");
    } finally {
      conn.disconnectSync();
    }
    return instance;
  } catch (error) {
    // Setup owns the instance even when acquiring its connection fails.
    // Disconnect above before closing; no partial lockdown may escape.
    instance.closeSync();
    throw error;
  }
}

function getQueryInstance(): Promise<DuckDBInstance> {
  if (!queryInstancePromise) {
    const attempt = createHardenedInstance().catch((error) => {
      // A reset may have installed a replacement while this attempt waited.
      if (queryInstancePromise === attempt) queryInstancePromise = null;
      throw error;
    });
    queryInstancePromise = attempt;
  }
  return queryInstancePromise;
}

/** Monotonic identity of the hardened catalog: bumped when the
 * instance is discarded and stamped onto every connection at creation,
 * so work still running for a discarded catalog can be told apart from
 * live work — a late pass must not bless the replacement catalog. */
let queryCatalogGeneration = 0;
const connectionGenerations = new WeakMap<DuckDBConnection, number>();

/** Tests re-point DEZFIL_DATA_DIR; the fence must be rebuilt. */
export function resetQueryInstance(): void {
  queryInstancePromise = null;
  queryCatalogGeneration += 1;
}

/** The generation of the catalog this connection was created against.
 * Connections not from connectQueryInstance answer the current one. */
export function catalogGenerationOf(conn: DuckDBConnection): number {
  return connectionGenerations.get(conn) ?? queryCatalogGeneration;
}

/** Whether the hardened instance exists yet: dropping a view from a
 * catalog that was never created must not create the instance to do it. */
export function hasQueryInstance(): boolean {
  return queryInstancePromise !== null;
}

/**
 * Run work on a fresh connection with spatial loaded, then release it.
 * Callers never share connections; per-request session state stays isolated.
 */
export async function withConnection<T>(
  fn: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const instance = await getInstance();
  const conn = await instance.connect();
  try {
    await loadSpatial(conn);
    return await fn(conn);
  } finally {
    conn.disconnectSync();
  }
}

/**
 * Hand out a hardened-instance connection whose lifecycle the caller owns.
 * Product code reaches this only through the bounded-evaluation boundary
 * (query/bounded) — the one door for user SQL, which defers the release
 * when an abandoned registration still holds the connection. Test harnesses
 * are the only other caller.
 */
export async function connectQueryInstance(): Promise<DuckDBConnection> {
  // Captured before the awaits: a reset landing mid-acquisition discards
  // exactly the catalog this connection will belong to, and the stamp
  // must say so.
  const generation = queryCatalogGeneration;
  const instance = await getQueryInstance();
  const conn = await instance.connect();
  connectionGenerations.set(conn, generation);
  return conn;
}
