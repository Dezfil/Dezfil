import { readApiError, readApiFailure } from "@/components/api";
import { serverUnreachable } from "@/components/failure-copy";
import { WriteRefusal } from "./save-unit";

export async function accountRequest<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method, cache: "no-store",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  } catch { throw new Error(serverUnreachable("complete this request")); }
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json() as Promise<T>;
}
export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : serverUnreachable("complete this request");
}

/** A card's write: a refusal keeps its code and status, so the card can
 * tell a row's problem from the card's, and a lost connection from both. */
export async function settingsWrite<T>(url: string, method: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method, cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch { throw new Error(serverUnreachable("complete this request")); }
  if (!response.ok) {
    const failure = await readApiFailure(response);
    throw new WriteRefusal(failure.code, failure.message, response.status);
  }
  return response.json() as Promise<T>;
}
