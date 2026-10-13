/**
 * A workflow's run history as a card's time fact reads it, shared by every
 * page that draws one: the start of the newest recorded run, whatever its
 * outcome; null when the history records none; "unreadable" when it could
 * not be read, because the server refused, the connection failed or the
 * answer could not be read. Never invented: a failed read is never "never
 * run".
 */

/** The newest recorded run's start, as an ISO time; null for none;
 * "unreadable" when the history could not be read. */
export type LastRun = string | null | "unreadable";

/** One read of the workflow's runs, never from the cache. */
export async function readLastRun(workflowId: string): Promise<LastRun> {
  try {
    const response = await fetch(`/api/recipes/${workflowId}/runs`, { cache: "no-store" });
    if (!response.ok) return "unreadable";
    const body = (await response.json()) as { runs: { startedAt: string }[] };
    return body.runs[0]?.startedAt ?? null;
  } catch {
    return "unreadable";
  }
}
