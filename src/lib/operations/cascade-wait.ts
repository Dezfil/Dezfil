import type { AccountScope } from "@/lib/auth/scope";
import { getCascade } from "@/lib/metadata/owned-cascades";

/** A removed run cannot wait for a long statement to finish on its own.
 * Read durable state while waiting, including deletions from another process.
 * One timer per wait is cleared on settlement, removal or a read failure. */
export async function waitForCascadeMember(
  scope: AccountScope,
  id: string,
  members: Iterable<Promise<string>>,
): Promise<string | null> {
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    return await Promise.race([...members, new Promise<null>((resolve, reject) => {
      timer = setInterval(() => {
        try { if (!getCascade(scope, id)) resolve(null); }
        catch (error) { reject(error); }
      }, 250);
    })]);
  } finally { clearInterval(timer); }
}
