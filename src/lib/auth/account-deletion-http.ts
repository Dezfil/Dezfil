import { NextResponse } from "next/server";
import { privateResponse } from "./http";
import { finishAccountDeletion, type DeletionStatus } from "./account-deletion";
import type { AuthContext } from "./credentials";

export function deletionResponse(value: DeletionStatus) {
  return privateResponse(NextResponse.json(value, { status: value.state === "completed" ? 200 : 202 }));
}
/** A held reader must not hold the HTTP reply indefinitely. The durable
 * identifier lets the client observe or resume the same cleanup after reload. */
export async function advanceDeletionResponse(context: AuthContext, id: string) {
  const work = finishAccountDeletion(context, id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([work, new Promise<DeletionStatus>(resolve => {
      timer = setTimeout(() => resolve({ id, state: "pending" }), 100);
    })]);
    return deletionResponse(value);
  } finally { clearTimeout(timer); }
}
