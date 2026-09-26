import { statSync, writeFileSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { lit } from "../../src/lib/ingest/ingest";

export interface Bytes { exists: boolean; logical: number; allocated: number }
export function bytes(file: string): Bytes {
  try { const s = statSync(file); return { exists: true, logical: s.size, allocated: s.blocks * 512 }; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return { exists: false, logical: 0, allocated: 0 }; }
}
export function refusal(e: unknown) {
  return { class: e instanceof Error ? e.constructor.name : typeof e, message: e instanceof Error ? e.message : String(e), code: (e as { code?: string })?.code ?? null };
}
export type Seed = "none" | "synthetic" | "pre-copy" | "post-copy" | "unobserved";
export interface Attempt {
  layer: string;
  file: string;
  startedMs: number;
  settledMs: number;
  status: "completed" | "copy-rejected";
  observations: (Bytes & { relativeToRejectionMs: number })[];
  pollCount: number;
  nonzeroObserved: number;
  atRejection: Record<string, Bytes>;
  error: ReturnType<typeof refusal> | null;
  metadata: { accepted: boolean; rows?: unknown[]; error?: ReturnType<typeof refusal> };
}
export interface Bind { sql: string; status: "bound" | "refused"; error?: ReturnType<typeof refusal> }

export function classify(attempt: Attempt | undefined, seed: Seed, binds: Bind[]) {
  if (!attempt) return { classification: "none-observed", measurement: "refused", reason: binds.some(b => b.status === "refused") ? "pre-copy refusal" : "COPY never started" };
  if (attempt.status === "completed") return { classification: "not a rejection", measurement: "refused", reason: "COPY completed; later failure has another cleanup owner" };
  const observed = attempt.observations.some(o => o.logical > 0 && o.relativeToRejectionMs < 0);
  const remains = attempt.atRejection[attempt.file].logical > 0;
  const classification = !observed ? "none-observed" : remains ? "bytes-remain" : "bytes-gone";
  if (seed === "synthetic") return { classification, measurement: "ownership control", reason: "synthetic prefix, not native magnitude" };
  if (!observed) return { classification, measurement: "inconclusive", reason: "no nonzero bytes observed before COPY rejection" };
  if (!/Unsupported geometry type in WKB/i.test(attempt.error?.message ?? "")) return { classification, measurement: "refused", reason: "not the native corrupt-row refusal class" };
  if (remains && attempt.metadata.accepted) return { classification, measurement: "refused", reason: "residue is complete Parquet" };
  return { classification, measurement: "confirmed", reason: remains ? "native incomplete output remains" : "engine cleanup; builder COPY catch removes nothing" };
}

/** Connection proxy only: the production builder, outer rollback and refresh
 * owner run unchanged. Poll synchronously every 2 ms while native work runs on
 * DuckDB's thread; record nonzero samples before handing rejection to owners.
 */
export function observeCopy(conn: DuckDBConnection, seed: Seed = "none", prefix?: Buffer) {
  const attempts: Attempt[] = [], binds: Bind[] = [];
  const metadata = async (file: string) => {
    try { return { accepted: true, rows: (await conn.runAndReadAll(`SELECT * FROM parquet_metadata(${lit(file)})`)).getRowObjectsJson() }; }
    catch (e) { return { accepted: false, error: refusal(e) }; }
  };
  const proxy = new Proxy(conn, {
    get(target, prop) {
      if (prop === "runAndReadAll") return async (sql: string) => {
        if (/^DESCRIBE SELECT \* FROM ST_Read\(/.test(sql)) {
          try {
            if (seed === "pre-copy" && sql.includes("'broken'")) throw new Error("seeded pre-copy refusal");
            const result = await target.runAndReadAll(sql);
            binds.push({ sql, status: "bound" }); return result;
          } catch (e) { binds.push({ sql, status: "refused", error: refusal(e) }); throw e; }
        }
        if (seed === "post-copy" && /^DESCRIBE SELECT \* FROM read_parquet\(/.test(sql)) throw new Error("seeded post-copy measurement fault");
        return target.runAndReadAll(sql);
      };
      if (prop === "run") return async (sql: string) => {
        const match = sql.match(/^COPY .* TO '((?:''|[^'])+)' \(FORMAT PARQUET\)$/s);
        if (!match) return target.run(sql);
        const file = match[1].replace(/''/g, "'");
        const layer = sql.match(/layer := '([^']+)'/)?.[1] ?? "unknown";
        const startedMs = performance.now();
        const samples: (Bytes & { ms: number })[] = [];
        let pollCount = 0;
        const observe = () => {
          pollCount++;
          const value = bytes(file);
          if (seed !== "unobserved" && value.logical > 0) samples.push({ ...value, ms: performance.now() });
        };
        const interval = setInterval(observe, 2);
        let error: unknown, result: Awaited<ReturnType<DuckDBConnection["run"]>> | undefined;
        try {
          if (seed === "synthetic" && layer === "broken") {
            if (!prefix?.length) throw new Error("Synthetic ownership prefix missing");
            writeFileSync(file, prefix);
            observe();
            throw new Error("synthetic COPY-stage ownership seed");
          }
          result = await target.run(sql);
        } catch (e) { error = e; }
        const settledMs = performance.now();
        clearInterval(interval);
        const atRejection = Object.fromEntries([...attempts.map(a => a.file), file].map(f => [f, bytes(f)]));
        const attempt: Attempt = { layer, file, startedMs, settledMs, status: error ? "copy-rejected" : "completed",
          observations: samples.map(({ ms, ...s }) => ({ ...s, relativeToRejectionMs: ms - settledMs })),
          pollCount, nonzeroObserved: samples.length, atRejection, error: error ? refusal(error) : null,
          metadata: await metadata(file) };
        attempts.push(attempt);
        if (error) throw error;
        return result!;
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { conn: proxy, attempts, binds };
}
