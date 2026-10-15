import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync, rmSync } from "node:fs";

/** Only the engine's dedicated directory may be removed here. The caller
 * shares one instance across server bundles and drains its leases before close. */
export async function createTrustedInstance(config: Record<string, string>, directory: string, memoryMb: number): Promise<DuckDBInstance> {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  let instance: DuckDBInstance | undefined;
  try {
    instance = await DuckDBInstance.create(":memory:", {
      ...config, memory_limit: `${memoryMb}MB`, temp_directory: directory,
    });
    const conn = await instance.connect();
    try {
      // Applying this after creation updates the live buffer manager. Merely
      // supplying a startup option can report a cap without enforcing it.
      await conn.run(`SET GLOBAL max_temp_directory_size = '${memoryMb * 4}MB'`);
    } finally { conn.disconnectSync(); }
    const close = instance.closeSync.bind(instance);
    let closed = false;
    instance.closeSync = () => {
      if (closed) return;
      close(); closed = true;
      rmSync(directory, { recursive: true, force: true });
    };
    return instance;
  } catch (error) {
    instance?.closeSync();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
