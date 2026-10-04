import { registerAccountFile, removeAccountFile } from "@/lib/ingest/file-ownership";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { dataDir } from "@/lib/config";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import type { DatasetScope } from "./access";
import { authorityOf } from "./context";

const stagingBrand: unique symbol = Symbol("private staging input");
export interface StagingInput {
  readonly name: string;
  readonly [stagingBrand]: true;
}
interface Stage {
  owner: string;
  file: string;
  disposed: boolean;
  readers: number;
  drained: ReturnType<typeof Promise.withResolvers<void>>;
  cleanup?: Promise<void>;
}
const key = Symbol.for("dezfil.query-staging");
const host = globalThis as typeof globalThis & { [key]?: Map<StagingInput, Stage> };
const stages = host[key] ??= new Map<StagingInput, Stage>();
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Only a trusted provider preparation can mint this in-memory capability.
 * Neither a file path nor a JSON copy can authorize a staging mount. */
export async function prepareStagingInput(
  scope: AccountScope,
  kind: "geocode" | "isochrone",
  write: (file: string) => Promise<void>,
): Promise<StagingInput> {
  const owner = requireAccountScope(scope);
  if (kind !== "geocode" && kind !== "isochrone") throw resourceAbsent();
  const id = randomUUID();
  const file = path.join(dataDir(), "tables", `${kind}-stage-${id}.parquet`);
  registerAccountFile(owner, file);
  const input = Object.freeze({ name: `__stage_${id.replaceAll("-", "_")}`, [stagingBrand]: true as const });
  const stage: Stage = { owner, file, disposed: false, readers: 1, drained: Promise.withResolvers<void>() };
  stages.set(input, stage);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await write(file);
    requireAccountScope(scope);
    if (stage.disposed) throw resourceAbsent();
    return input;
  } catch (error) {
    stage.disposed = true;
    throw error;
  } finally {
    stage.readers--;
    if (stage.disposed) {
      if (!stage.readers) stage.drained.resolve();
      await removeStagingInput(input);
    }
  }
}

/** Invalidate immediately, remove only after any admitted connection releases
 * its lease. Cleanup still works after account deactivation. */
export function removeStagingInput(input: StagingInput): Promise<void> {
  const stage = stages.get(input);
  if (!stage) return Promise.resolve();
  stage.disposed = true;
  if (stage.readers === 0) stage.drained.resolve();
  return stage.cleanup ??= stage.drained.promise.then(() => removeAccountFile(stage.file)).then(() => { stages.delete(input); }).catch(error => { stage.cleanup = undefined; throw error; });
}

export interface StagingLease {
  mount(conn: DuckDBConnection, abandoned: () => boolean): Promise<void>;
  assertLive(): void;
  release(): void;
}

/** Authority is checked before acquiring a connection or probing any file.
 * A capability stays with the job that received it; even another evaluation
 * by the same account has no staging input unless that job passes it. */
export function leaseStagingInputs(scope: DatasetScope, inputs: readonly StagingInput[] = []): StagingLease {
  const owner = inputs.length ? requireAccountScope(authorityOf(scope) as AccountScope) : null;
  const selected = inputs.map(input => {
    const stage = stages.get(input);
    if (!stage || stage.owner !== owner || stage.disposed) throw resourceAbsent();
    return { input, stage };
  });
  if (new Set(inputs).size !== inputs.length) throw resourceAbsent();
  for (const { stage } of selected) stage.readers++;
  let released = false;
  const assertLive = () => {
    if (selected.some(({ stage }) => stage.disposed)) throw resourceAbsent();
  };
  return {
    assertLive,
    async mount(conn, abandoned) {
      for (const { input, stage } of selected) {
        if (abandoned()) return;
        assertLive();
        // No replacement: a collision must never hide a durable dataset.
        await conn.run(`CREATE TEMP VIEW ${ident(input.name)} AS SELECT * FROM read_parquet('${stage.file.replace(/'/g, "''")}')`);
      }
    },
    release() {
      if (released) return;
      released = true;
      for (const { stage } of selected) {
        stage.readers--;
        if (stage.disposed && stage.readers === 0) stage.drained.resolve();
      }
    },
  };
}

export async function eraseAccountStaging(accountId: string): Promise<void> {
  await Promise.all([...stages].filter(([, stage]) => stage.owner === accountId).map(([input]) => removeStagingInput(input)));
}
export function stagingForTests(): { owner: string; file: string; readers: number }[] {
  return [...stages.values()].map(({ owner, file, readers }) => ({ owner, file, readers }));
}
