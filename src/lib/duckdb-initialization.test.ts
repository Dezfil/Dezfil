import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type Engine = typeof import("./duckdb");
type Lane = "trusted" | "hardened";
type SetupSeed = "connect" | "spatial" | "fence" | "lock";
const realCreate = DuckDBInstance.create.bind(DuckDBInstance);
const seedError = new Error("injected initialization failure");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function observeConnection(conn: DuckDBConnection) {
  return { conn, disconnect: vi.spyOn(conn, "disconnectSync") };
}

function observeInstance(instance: DuckDBInstance) {
  const connections: ReturnType<typeof observeConnection>[] = [];
  const connect = instance.connect.bind(instance);
  return {
    instance,
    close: vi.spyOn(instance, "closeSync"),
    connect: vi.spyOn(instance, "connect").mockImplementation(async () => {
      const conn = await connect();
      connections.push(observeConnection(conn));
      return conn;
    }),
    connections,
  };
}

let engine: Engine;
let root: string;
const instances: ReturnType<typeof observeInstance>[] = [];
let create: MockInstance<typeof DuckDBInstance.create>;

async function trackedInstance(args: Parameters<typeof DuckDBInstance.create>, seed?: SetupSeed, hold?: {
  entered: ReturnType<typeof deferred>;
  release: ReturnType<typeof deferred>;
}) {
  const tracked = observeInstance(await realCreate(...args));
  instances.push(tracked);
  if (seed === "connect") {
    tracked.connect.mockRejectedValueOnce(seedError);
  } else if (seed || hold) {
    const connect = tracked.connect.getMockImplementation()!;
    tracked.connect.mockImplementationOnce(async () => {
      const conn = await connect();
      const run = conn.run.bind(conn);
      vi.spyOn(conn, "run").mockImplementation(async (sql, ...args) => {
        if (hold && sql === "SET GLOBAL lock_configuration = true") {
          hold.entered.resolve();
          await hold.release.promise;
          throw seedError;
        }
        if (
          (seed === "spatial" && /^(LOAD|INSTALL) spatial$/.test(sql)) ||
          (seed === "fence" && sql === "SET GLOBAL enable_external_access = false") ||
          (seed === "lock" && sql === "SET GLOBAL lock_configuration = true")
        ) throw seedError;
        return run(sql, ...args);
      });
      return conn;
    });
  }
  return tracked.instance;
}

async function request(lane: Lane, sql = "SELECT 42 AS answer") {
  const read = async (conn: DuckDBConnection) =>
    (await conn.runAndReadAll(sql)).getRowObjects();
  if (lane === "trusted") return engine.withConnection(read);
  const conn = await engine.connectQueryInstance();
  try {
    return await read(conn);
  } finally {
    conn.disconnectSync();
  }
}

async function assertHardening() {
  const outside = path.join(root, "outside.csv");
  await writeFile(outside, "value\nsecret\n");
  const conn = await engine.connectQueryInstance();
  try {
    await expect(conn.run("SET GLOBAL threads = 2")).rejects.toThrow(/lock/i);
    await expect(
      conn.run(`SELECT * FROM read_csv('${outside.replace(/'/g, "''")}')`),
    ).rejects.toThrow(/disabled|permission|access/i);
  } finally {
    conn.disconnectSync();
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "engine-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(root, "data"));
  vi.resetModules();
  engine = await import("./duckdb");
  create = vi.spyOn(DuckDBInstance, "create").mockImplementation((...args) => trackedInstance(args));
});

afterEach(async () => {
  await (await import("./query/retained")).purgeQueryStores();
  // Release real native handles even when the pre-repair assertion fails.
  for (const instance of instances.splice(0)) {
    for (const conn of instance.connections) {
      if (conn.disconnect.mock.calls.length === 0) conn.conn.disconnectSync();
    }
    if (instance.close.mock.calls.length === 0) instance.instance.closeSync();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe.each<Lane>(["trusted", "hardened"])("%s initialization", (lane) => {
  it("retries a one-shot creation failure on the next request", async () => {
    create.mockRejectedValueOnce(seedError);
    await expect(request(lane)).rejects.toBe(seedError);
    await expect(request(lane)).resolves.toEqual([{ answer: 42 }]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("shares one held retry and never retries without a caller", async () => {
    create.mockRejectedValueOnce(seedError);
    await expect(request(lane)).rejects.toBe(seedError);
    await new Promise<void>((done) => setImmediate(done));
    expect(create).toHaveBeenCalledTimes(1);
    const release = deferred();
    create.mockImplementationOnce(async (...args) => {
      await release.promise;
      return trackedInstance(args);
    });
    const callers = Array.from({ length: 8 }, () => request(lane));
    const settled = Promise.allSettled(callers);
    try {
      expect.soft(create).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
    }
    expect(await settled).toEqual(
      Array.from({ length: 8 }, () => ({ status: "fulfilled", value: [{ answer: 42 }] })),
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(instances).toHaveLength(1);
    expect(instances[0].close).not.toHaveBeenCalled();
    expect(instances[0].connections).toHaveLength(9);
    for (const conn of instances[0].connections) expect(conn.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(["connection", "query"])("reuses a successful catalog after a request %s failure", async (failure) => {
    await request(lane, "CREATE TABLE retained AS SELECT 42 AS answer");
    if (failure === "connection") instances[0].connect.mockRejectedValueOnce(seedError);
    await expect(request(lane, failure === "query" ? "SELECT * FROM missing_table" : undefined))
      .rejects.toThrow(failure === "query" ? /missing_table/ : seedError.message);
    expect(await request(lane, "SELECT * FROM retained")).toEqual([{ answer: 42 }]);
    expect(await Promise.all(Array.from({ length: 4 }, () => request(lane, "SELECT * FROM retained"))))
      .toEqual(Array.from({ length: 4 }, () => [{ answer: 42 }]));
    expect(create).toHaveBeenCalledTimes(1);
    expect(instances[0].close).not.toHaveBeenCalled();
  });
});

describe("partial hardened setup", () => {
  it.each<SetupSeed>(["connect", "spatial", "fence", "lock"])("releases a failed %s setup and hardens its replacement", async (seed) => {
    create.mockImplementationOnce((...args) => trackedInstance(args, seed));
    await expect(request("hardened")).rejects.toBe(seedError);
    const failed = instances[0];
    expect.soft(failed.close).toHaveBeenCalledTimes(1);
    expect(failed.connections).toHaveLength(seed === "connect" ? 0 : 1);
    for (const conn of failed.connections) expect.soft(conn.disconnect).toHaveBeenCalledTimes(1);
    await expect(request("hardened")).resolves.toEqual([{ answer: 42 }]);
    await assertHardening();
    expect(create).toHaveBeenCalledTimes(2);
    expect(instances[1].close).not.toHaveBeenCalled();
  });

  it("an older rejection cannot discard or close the replacement after reset", async () => {
    const entered = deferred();
    const release = deferred();
    create.mockImplementationOnce((...args) => trackedInstance(args, undefined, { entered, release }));
    const older = request("hardened").catch((error: unknown) => error);
    await entered.promise;
    let replacement: DuckDBConnection | undefined;
    try {
      engine.resetQueryInstance();
      replacement = await engine.connectQueryInstance();
      const generation = engine.catalogGenerationOf(replacement);
      release.resolve();
      expect(await older).toBe(seedError);
      expect.soft(instances[0].close).toHaveBeenCalledTimes(1);
      expect.soft(instances[0].connections[0].disconnect).toHaveBeenCalledTimes(1);
      expect(await request("hardened")).toEqual([{ answer: 42 }]);
      const next = await engine.connectQueryInstance();
      try {
        expect(engine.catalogGenerationOf(next)).toBe(generation);
      } finally {
        next.disconnectSync();
      }
      expect(create).toHaveBeenCalledTimes(2);
      expect(instances[1].close).not.toHaveBeenCalled();
      expect((await replacement.runAndReadAll("SELECT 42 AS answer")).getRowObjects())
        .toEqual([{ answer: 42 }]);
    } finally {
      release.resolve();
      await older;
      replacement?.disconnectSync();
    }
  });

  it("optional extension refusal still permits a locked, spatial-capable instance", async () => {
    create.mockImplementationOnce(async (...args) => {
      const instance = await trackedInstance(args);
      const connect = instances[0].connect.getMockImplementation()!;
      instances[0].connect.mockImplementationOnce(async () => {
        const conn = await connect();
        const run = conn.run.bind(conn);
        vi.spyOn(conn, "run").mockImplementation(async (sql, ...args) => {
          if (/^(LOAD|INSTALL) (h3|json)\b/.test(sql)) throw seedError;
          return run(sql, ...args);
        });
        return conn;
      });
      return instance;
    });
    expect(await request("hardened", "SELECT ST_AsText(ST_Point(1, 2)) AS wkt"))
      .toEqual([{ wkt: "POINT (1 2)" }]);
    expect(engine.h3Available()).toBe(false);
    await assertHardening();
    expect(create).toHaveBeenCalledTimes(1);
    expect(instances[0].close).not.toHaveBeenCalled();
  });
});
