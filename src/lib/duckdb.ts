import { registerQueryStore } from "./query/retained";
import { registerCrsValidator } from "./query/projection-policy";
import type { DatasetScope } from "@/lib/query/access";
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

const nativeInstances = new Set<WeakRef<DuckDBInstance>>();
const nativeCreating = new Set<Promise<DuckDBInstance>>();
const leases = new Set<ReturnType<typeof Promise.withResolvers<void>>>();
function watchInstance(promise: Promise<DuckDBInstance>): Promise<DuckDBInstance> {
  nativeCreating.add(promise);
  void promise.then(instance => { nativeInstances.add(new WeakRef(instance)); nativeCreating.delete(promise); }, () => nativeCreating.delete(promise));
  return promise;
}
function holdConnection(): () => void {
  const lease = Promise.withResolvers<void>(); leases.add(lease);
  return () => { leases.delete(lease); lease.resolve(); };
}
function observeDisconnect(conn: DuckDBConnection, release: () => void): void {
  const close = conn.disconnectSync.bind(conn); let closed = false;
  conn.disconnectSync = () => { if (closed) return; close(); closed = true; release(); };
}
registerQueryStore({
  async drain() { await Promise.allSettled([...nativeCreating, ...[...leases].map(l => l.promise)]); },
  busy: () => nativeCreating.size > 0 || leases.size > 0,
  clear() {
    for (const ref of nativeInstances) { ref.deref()?.closeSync(); nativeInstances.delete(ref); }
    instancePromise = null; queryInstancePromise = null; queryCatalogGeneration++;
    connectionGenerations = new WeakMap();
  },
});

function baseConfig(): Record<string, string> {
  const config: Record<string, string> = {};
  if (process.env.DUCKDB_EXTENSION_DIR) {
    config.extension_directory = process.env.DUCKDB_EXTENSION_DIR;
  }
  return config;
}

/**
 * Test wiring, never set in a deployment: the repository the hardened
 * instance installs extensions from. The engine downloads with its own
 * HTTP client, which no guard in this process sees, so a test that may
 * make the engine install points this at a loopback repository that
 * records each request; unset, the engine's own repositories apply.
 */
function testExtensionRepository(): string | null {
  return process.env.DEZFIL_TEST_EXTENSION_REPOSITORY || null;
}

/** The extensions the hardened instance loads as it starts. */
export type EngineExtension = "spatial" | "h3" | "json";

/** A start that installs nothing met a spatial extension that is not
 * installed where the engine looks for it. */
export class SpatialNotInstalled extends Error {
  constructor() { super("The spatial extension is not installed."); }
}

async function loadSpatial(conn: DuckDBConnection, install = true): Promise<void> {
  try {
    await conn.run("LOAD spatial");
  } catch (error) {
    if (!install) {
      // Not installed is the one failure said as such; a file that is
      // there but will not load stays the engine's own error.
      const listed = await conn.runAndReadAll("SELECT installed FROM duckdb_extensions() WHERE extension_name = 'spatial'");
      if (listed.getRows()[0]?.[0] !== true) throw new SpatialNotInstalled();
      throw error;
    }
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

async function loadH3(conn: DuckDBConnection, install = true): Promise<boolean> {
  try {
    await conn.run("LOAD h3");
    h3Loaded = true;
  } catch {
    // A start that installs nothing leaves hexagons off until the next.
    if (!install) return h3Loaded = false;
    try {
      const repository = testExtensionRepository();
      await conn.run(`INSTALL h3 FROM ${repository ? `'${repository.replace(/'/g, "''")}'` : "community"}`);
      await conn.run("LOAD h3");
      h3Loaded = true;
    } catch {
      h3Loaded = false;
    }
  }
  return h3Loaded;
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
export async function h3Ready(scope: DatasetScope): Promise<boolean> {
  const { boundedEvaluation } = await import("@/lib/query/bounded");
  await boundedEvaluation(async () => undefined, { scope });
  return h3Loaded;
}

/**
 * json powers the OSM tags column (un-promoted tags stay queryable).
 * Autoload is off on the hardened instance, so it loads explicitly
 * before lockdown; optional like h3 — without it only json-function
 * queries fail, with the engine's own message.
 */
async function loadJson(conn: DuckDBConnection, install = true): Promise<boolean> {
  try {
    await conn.run("LOAD json");
    return true;
  } catch {
    if (!install) return false;
    try {
      await conn.run("INSTALL json");
      await conn.run("LOAD json");
      return true;
    } catch {
      /* Json functions unavailable — degrade, don't break */
      return false;
    }
  }
}

function getInstance(): Promise<DuckDBInstance> {
  if (!instancePromise) {
    const attempt = watchInstance(DuckDBInstance.create(":memory:", baseConfig())).catch((error) => {
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
  const release = holdConnection();
  try { return await loadTrustedH3(await getInstance()); } finally { release(); }
}

/**
 * The hardened instance. `install` false is the load-only start: the
 * extensions already installed load and nothing is installed, the
 * engine's own installing off before its first statement, so a missing
 * spatial extension fails the start with `SpatialNotInstalled` and a
 * missing optional one stays off until the next start. `loaded` is told
 * of each extension as it loads.
 */
async function createHardenedInstance(install: boolean, loaded: (extension: EngineExtension) => void): Promise<DuckDBInstance> {
  const repository = testExtensionRepository();
  const instance = await DuckDBInstance.create(":memory:", {
    ...baseConfig(),
    ...(repository ? { custom_extension_repository: repository, autoinstall_extension_repository: repository } : {}),
    ...(install ? {} : { autoinstall_known_extensions: "false" }),
  });
  try {
    const conn = await instance.connect();
    try {
      // Load extensions first — loading is impossible after the lockdown.
      await loadSpatial(conn, install);
      loaded("spatial");
      if (await loadH3(conn, install)) loaded("h3");
      if (await loadJson(conn, install)) loaded("json");
      registerCrsValidator(conn);
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

/** What the hardened instance in place loaded as it started, kept with the
 * attempt that started it so a discarded instance's loads are never read. */
let startedQueryInstance: { attempt: Promise<DuckDBInstance>; extensions: readonly EngineExtension[] } | null = null;

/** The hardened instance, started when there is none. An instance already
 * starting is joined whichever start it is; `install` says only how a
 * start made here loads its extensions. A failed start is discarded, so
 * the next caller starts afresh. */
function getQueryInstance(install = true): Promise<DuckDBInstance> {
  if (!queryInstancePromise) {
    const extensions: EngineExtension[] = [];
    const attempt: Promise<DuckDBInstance> = watchInstance(createHardenedInstance(install, extension => { extensions.push(extension); })).then(
      (instance) => {
        if (queryInstancePromise === attempt) startedQueryInstance = { attempt, extensions };
        return instance;
      },
      (error) => {
        // A reset may have installed a replacement while this attempt waited.
        if (queryInstancePromise === attempt) queryInstancePromise = null;
        throw error;
      },
    );
    queryInstancePromise = attempt;
  }
  return queryInstancePromise;
}

/** The extensions the hardened instance in place loaded, in load order, or
 * null while there is none (or it is still starting). Starts nothing. */
export function queryEngineExtensions(): readonly EngineExtension[] | null {
  return startedQueryInstance !== null && startedQueryInstance.attempt === queryInstancePromise ? startedQueryInstance.extensions : null;
}

/** Monotonic identity of the hardened catalog: bumped when the
 * instance is discarded and stamped onto every connection at creation,
 * so work still running for a discarded catalog can be told apart from
 * live work — a late pass must not bless the replacement catalog. */
let queryCatalogGeneration = 0;
let connectionGenerations = new WeakMap<DuckDBConnection, number>();

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
  const release = holdConnection();
  let conn: DuckDBConnection | undefined;
  try {
    const instance = await getInstance(); conn = await instance.connect();
    await loadSpatial(conn); return await fn(conn);
  } finally { conn?.disconnectSync(); release(); }
}

/**
 * Hand out a hardened-instance connection whose lifecycle the caller owns.
 * Product code reaches this through the bounded-evaluation boundary
 * (query/bounded) — the one door for user SQL, which defers the release
 * when an abandoned registration still holds the connection — and through
 * the query engine's Test, which asks one fixed question and starts a cold
 * engine with `install` false, loading only what is installed. Test
 * harnesses are the only other caller.
 */
export async function connectQueryInstance({ install = true }: { install?: boolean } = {}): Promise<DuckDBConnection> {
  // Captured before the awaits: a reset landing mid-acquisition discards
  // exactly the catalog this connection will belong to, and the stamp
  // must say so.
  const release = holdConnection(), generation = queryCatalogGeneration;
  try {
    const instance = await getQueryInstance(install), conn = await instance.connect();
    connectionGenerations.set(conn, generation); observeDisconnect(conn, release); return conn;
  } catch (error) { release(); throw error; }
}

export function engineStateForTests() { return { trusted: instancePromise !== null, hardened: queryInstancePromise !== null, creating: nativeCreating.size, leases: leases.size, instances: [...nativeInstances].filter(ref => ref.deref()).length }; }
export function connectionStampForTests(conn: DuckDBConnection): boolean { return connectionGenerations.has(conn); }
