import { readApiError } from "../api";
import { serverUnreachable } from "../failure-copy";
import type { WorkflowStep } from "../workflow-model";

export const UNCONFIRMED_EDIT = "Couldn't confirm the change was saved.";
export type EditAnswer =
  | { ok: true; body: unknown }
  | { ok: false; refused: { code: string; message: string; status: number } }
  | { ok: false; failed: string; uncertain?: boolean };

/** Every completed transport outcome is a value, including a successful
 * header whose body could not be read. Structural callers share this road. */
export async function editCall(path: string, init: RequestInit, action: string): Promise<EditAnswer> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { "content-type": "application/json" }, cache: "no-store" });
  } catch {
    return { ok: false, failed: serverUnreachable(action) };
  }
  if (response.ok) {
    try { return { ok: true, body: await response.json() }; }
    catch { return { ok: false, failed: UNCONFIRMED_EDIT, uncertain: true }; }
  }
  if (response.status >= 400 && response.status < 500) {
    const body = (await response.clone().json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    return { ok: false, refused: { code: body.error?.code ?? "invalid_request", message: body.error?.message ?? (await readApiError(response)), status: response.status } };
  }
  return { ok: false, failed: await readApiError(response) };
}

// API object key order need not match the request's. Compare JSON values
// recursively, including nested parameters, while preserving array order.
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every((k) => Object.hasOwn(y, k) && equal(x[k], y[k]));
}

/** Uncertain writes survive failed reads. A caller retries its own
 * continuation as before; this boundary reads first before allowing a send. */
export class UncertainEdits {
  private pending = new Set<string>();
  constructor(private base: string) {}
  private async read(stepId: string, parameters: Record<string, unknown>): Promise<{ readable: boolean; accepted: EditAnswer | null }> {
    const result = await editCall(`${this.base}/${stepId}`, { method: "GET" }, "read the node");
    if (!result.ok) return { readable: false, accepted: null };
    const step = (result.body as { step?: WorkflowStep } | null)?.step;
    if (!step?.parameters) return { readable: false, accepted: null };
    this.pending.delete(stepId);
    const applied = step.proposedParameters ? "proposed" : "active";
    return { readable: true, accepted: equal(step.proposedParameters ?? step.parameters, parameters) ? { ok: true, body: { step, applied } } : null };
  }
  async send(stepId: string, parameters: Record<string, unknown>): Promise<EditAnswer> {
    const failed: EditAnswer = { ok: false, failed: UNCONFIRMED_EDIT };
    if (this.pending.has(stepId)) {
      const read = await this.read(stepId, parameters);
      if (!read.readable) return failed;
      if (read.accepted) return read.accepted;
    }
    const result = await editCall(`${this.base}/${stepId}`, { method: "PATCH", body: JSON.stringify({ parameters }) }, "save the change");
    if (!result.ok && "uncertain" in result && result.uncertain) {
      this.pending.add(stepId);
      const read = await this.read(stepId, parameters);
      return read.accepted ?? failed;
    }
    return result;
  }
}
