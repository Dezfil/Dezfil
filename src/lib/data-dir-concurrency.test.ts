import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureDataDir } from "./data-dir";
import { GET } from "@/app/api/health/route";
import { buildOpenApiDocument } from "@/lib/api/openapi";

// These are storage failure-injection tests. HTTP provenance has its own suite.
vi.mock("@/lib/auth/ingress.mjs", () => ({ requireIngress: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type Overlap = {
  dir: string;
  written: string[];
  removals: number;
  failures: unknown[];
  writesDone: ReturnType<typeof deferred>;
  firstRemovalDone: ReturnType<typeof deferred>;
};
const overlap = vi.hoisted(() => ({ current: null as Overlap | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args);
      const schedule = overlap.current;
      if (!schedule || !String(args[0]).startsWith(`${schedule.dir}/.dezfil-write-probe`)) return;
      schedule.written.push(String(args[0]));
      if (schedule.written.length === 2) schedule.writesDone.resolve();
      await schedule.writesDone.promise;
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      const schedule = overlap.current;
      if (!schedule || !String(args[0]).startsWith(`${schedule.dir}/.dezfil-write-probe`)) {
        return fs.rm(...args);
      }
      const order = ++schedule.removals;
      if (order === 2) await schedule.firstRemovalDone.promise;
      try {
        // Never suppress ENOENT: the first real removal completes before
        // the second starts. Both real writes have already completed.
        await fs.rm(...args);
      } catch (error) {
        schedule.failures.push(error);
        throw error;
      } finally {
        if (order === 1) schedule.firstRemovalDone.resolve();
      }
    },
  };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(process.cwd(), ".tmp-storage-"));
  vi.stubEnv("DEZFIL_DATA_DIR", root);
});

afterEach(async () => {
  overlap.current?.writesDone.resolve();
  overlap.current?.firstRemovalDone.resolve();
  overlap.current = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await chmod(root, 0o755);
  await rm(root, { recursive: true, force: true });
});

function forceOverlap() {
  const schedule: Overlap = {
    dir: root,
    written: [],
    removals: 0,
    failures: [],
    writesDone: deferred(),
    firstRemovalDone: deferred(),
  };
  overlap.current = schedule;
  return schedule;
}

async function denyWrites() {
  await chmod(root, 0o555);
  const error: unknown = await writeFile(path.join(root, "denied-control"), "probe")
    .catch((cause: unknown) => cause);
  // A privileged test user must fail the control, never silently pass it.
  expect(error).toBeInstanceOf(Error);
  const refusal = error as NodeJS.ErrnoException;
  expect(refusal.code).toMatch(/^(EACCES|EPERM|EROFS)$/);
  expect(refusal.path).toContain(root);
  return refusal;
}

describe("real storage readiness", () => {
  it("two probes survive forced write/write/remove/remove overlap", async () => {
    const schedule = forceOverlap();
    const results = await Promise.allSettled([ensureDataDir(root), ensureDataDir(root)]);
    expect(schedule.written).toHaveLength(2);
    expect(schedule.removals).toBe(2);
    expect.soft(schedule.failures).toEqual([]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await readdir(root)).toEqual([]);
  });

  it("overlapping readiness requests both answer ready and leave no probe", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const schedule = forceOverlap();
    const responses = await Promise.all([GET(), GET()]);
    expect(schedule.written).toHaveLength(2);
    expect(schedule.removals).toBe(2);
    expect.soft(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await Promise.all(responses.map((response) => response.json())))
      .toEqual([{ status: "ready" }, { status: "ready" }]);
    expect(schedule.failures).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("50 batches of 50 real probes pass between sequential controls", async () => {
    for (let i = 0; i < 3; i += 1) await ensureDataDir(root);
    const failures: unknown[] = [];
    for (let batch = 0; batch < 50; batch += 1) {
      const results = await Promise.allSettled(Array.from({ length: 50 }, () => ensureDataDir(root)));
      failures.push(...results.filter((result) => result.status === "rejected"));
    }
    for (let i = 0; i < 3; i += 1) await ensureDataDir(root);
    expect(failures).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("real denied writes answer 503 without the seeded path or actual error code", async () => {
    const refusal = await denyWrites();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET();
    const wire = await response.text();
    expect.soft(response.status).toBe(503);
    expect.soft(JSON.parse(wire)).toEqual({
      status: "unready", reason: "An unexpected server error occurred.",
    });
    expect.soft(wire).not.toContain(root);
    expect.soft(wire).not.toContain(refusal.code!);
    expect(log).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls[0][1] as Error;
    expect(logged.message).toContain(root);
    expect((logged.cause as NodeJS.ErrnoException).code).toBe(refusal.code);
    expect((logged.cause as NodeJS.ErrnoException).path).toContain(root);
    expect(await readdir(root)).toEqual([]);
  });

  it("OpenAPI describes both real readiness bodies including the 503 reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    type Schema = {
      type: string;
      required: string[];
      properties: Record<string, { type: string; enum?: string[] }>;
    };
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, { get: { responses: Record<string, {
        content: { "application/json": { schema: { $ref: string } } };
      }> } }>;
      components: { schemas: Record<string, Schema> };
    };
    const ready = await GET();
    await denyWrites();
    const unready = await GET();
    expect([ready.status, unready.status]).toEqual([200, 503]);
    for (const response of [unready, ready]) {
      const documented = doc.paths["/api/health"].get.responses[String(response.status)];
      expect(documented, `explicit ${response.status} response`).toBeDefined();
      const ref = documented.content["application/json"].schema.$ref;
      const schema = doc.components.schemas[ref.split("/").at(-1)!];
      const body = await response.json() as Record<string, string>;
      expect(schema.type).toBe("object");
      expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(body).sort());
      expect(schema.required).toEqual(expect.arrayContaining(Object.keys(body)));
      expect(schema.properties.status.enum).toEqual([body.status]);
      for (const [key, value] of Object.entries(body)) {
        expect(schema.properties[key].type).toBe(typeof value);
        if (schema.properties[key].enum) expect(schema.properties[key].enum).toContain(value);
      }
    }
  });
});
