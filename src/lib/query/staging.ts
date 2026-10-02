import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
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
const stages = new WeakMap<StagingInput, Stage>();
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
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await write(file);
    requireAccountScope(scope);
    const input = Object.freeze({ name: `__stage_${id.replaceAll("-", "_")}`, [stagingBrand]: true as const });
    stages.set(input, { owner, file, disposed: false, readers: 0, drained: Promise.withResolvers<void>() });
    return input;
  } catch (error) {
    await rm(file, { force: true }).catch(() => {});
    throw error;
  }
}

/** Invalidate immediately, remove only after any admitted connection releases
 * its lease. Cleanup still works after account deactivation. */
export function removeStagingInput(input: StagingInput): Promise<void> {
  const stage = stages.get(input);
  if (!stage) return Promise.resolve();
  stage.disposed = true;
  if (stage.readers === 0) stage.drained.resolve();
  return stage.cleanup ??= stage.drained.promise.then(() => rm(stage.file, { force: true })).catch(() => {});
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
