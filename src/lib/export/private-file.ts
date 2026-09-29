import { open } from "node:fs/promises";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";

/** Hold the descriptor and recheck the initiator before returning private
 * bytes. A failed open or withdrawn account releases both file and handle. */
export async function openPrivateExport(scope: AccountScope, file: { path: string; cleanup(): Promise<void> }) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    requireAccountScope(scope);
    handle = await open(file.path);
    const size = (await handle.stat()).size;
    requireAccountScope(scope);
    return { handle, size };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await file.cleanup().catch(() => undefined);
    throw error;
  }
}
