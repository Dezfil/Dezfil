import { readApiError } from "@/components/api";
import { serverUnreachable } from "@/components/failure-copy";

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
