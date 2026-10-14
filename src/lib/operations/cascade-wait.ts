import type { AccountScope } from "@/lib/auth/scope";
import { AuthError } from "@/lib/auth/errors";
import { getCascade } from "@/lib/metadata/owned-cascades";

/** A removed run cannot wait for a long statement to finish on its own.
 * Read durable state while waiting, including deletions from another process.
 * A read outage does not end the wait; an inactive initiator must stop.
 * Each wait logs at most one failed removal check. */
export async function waitForCascadeMember(
  scope: AccountScope,
  id: string,
  members: Iterable<Promise<string>>,
): Promise<string | null> {
  let timer: ReturnType<typeof setInterval> | undefined;
  let loggedReadFailure = false;
  try {
    return await Promise.race([...members, new Promise<null>((resolve, reject) => {
      timer = setInterval(() => {
        try { if (!getCascade(scope, id)) resolve(null); }
        catch (error) {
          if (error instanceof AuthError) { reject(error); return; }
          if (!loggedReadFailure) {
            loggedReadFailure = true;
            console.warn(`[operations] cascade ${id} removal check failed; waiting for member settlement:`, error);
          }
        }
      }, 250);
    })]);
  } finally { clearInterval(timer); }
}
