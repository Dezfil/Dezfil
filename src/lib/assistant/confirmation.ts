import { callPath, type AssistantRevisions } from "./edit-revisions";
import { ApiError, type ErrorCode } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import type { ConfirmationWords } from "@/lib/api/operation-metadata";
import type { ToolDef } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import type { ToolCall } from "./provider";
import { valuesAt, type ResolvedConfirmation } from "./action-metadata";
import { recordedArguments } from "./recorded-arguments";

interface ConfirmationDeps { revisions?: AssistantRevisions; baseUrl: string; fetchImpl?: typeof fetch; signal?: AbortSignal }
/** The recipe API owns membership. Bind its current ordered plan, never model-supplied membership. */
export async function prepareConfirmation(tool: ToolDef, call: ToolCall, deps: ConfirmationDeps): Promise<{ words: ResolvedConfirmation; subject?: unknown; runPlanRevision?: string } | undefined> {
  let required = tool.confirm;
  let runPlanRevision: string | undefined;
  if (tool.confirmWhen === "when_wide" && call.args.plan !== true) {
    const probe = await executeTool(tool, { ...call.args, plan: true }, deps.baseUrl, deps.fetchImpl, undefined, deps.signal);
    const body = probe.body as { editRevision?: string; plan?: { wide?: unknown; members?: unknown } } | null;
    const plan = body?.plan;
    if (!probe.ok || typeof body?.editRevision !== "string" || typeof plan?.wide !== "boolean" || !Array.isArray(plan.members) || !plan.members.every((id) => typeof id === "string" && id.length > 0)) {
      throw new ApiError("assistant_plan_unavailable", "The current workflow membership could not be established. No run was approved or started.", 409);
    }
    runPlanRevision = body.editRevision;
    deps.revisions?.observe(callPath(tool, call.args), probe.body);
    call.args = { ...call.args, members: [...plan.members] };
    required = plan.wide;
  }
  if (!required) return undefined;
  const words = tool.confirmation;
  if (!words) throw new Error(`Missing confirmation declaration for ${tool.name}`);
  const identity = String(call.args[words.subject.argument] ?? "");
  // The words are a record of the call: an address in them reads as scheme and host.
  const shown = String(recordedArguments(call.args)[words.subject.argument] ?? "");
  let name: string | undefined;
  let read: unknown;
  let refused: ApiError | undefined;
  if (words.subject.path === null) return { runPlanRevision, words: { target: words.target.replace("{target}", shown), consequence: words.consequence } };
  const pathname = words.subject.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(String(call.args[key] ?? "")));
  try {
    const response = await (deps.fetchImpl ?? fetch)(deps.baseUrl.replace(/\/$/, "") + pathname, { signal: deps.signal });
    if (response.ok) {
      let subject: unknown = await response.json();
      if (words.subject.collection !== undefined) {
        const collection = valuesAt(subject, words.subject.collection)[0];
        subject = Array.isArray(collection) ? collection.find((item) => valuesAt(item, words.subject.identity ?? "id")[0] === identity) : undefined;
      }
      const resolved = valuesAt(subject, words.subject.name)[0];
      if (typeof resolved === "string" && resolved) name = resolved;
      read = subject;
    } else {
      refused = await readRefusal(response);
    }
  } catch { /* Identity remains exact if the optional display name cannot be read. */ }
  const target = name && name !== identity ? `${name} (${shown})` : shown;
  if (words.subject.binds || words.subject.facts) {
    const fill = bindSubject(words.subject, call, read, refused);
    const render = (text: string) => text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, key: string) =>
      key === "target" ? target : Object.hasOwn(fill, key) ? fill[key] : whole);
    return { runPlanRevision, words: { target: render(words.target), consequence: render(words.consequence) }, subject: read };
  }
  return { runPlanRevision, words: { target: words.target.replace("{target}", target), consequence: words.consequence }, subject: read };
}

/** The subject read's own refusal, when it answered one. */
async function readRefusal(response: Response): Promise<ApiError | undefined> {
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown } } | null;
    const { code, message } = body?.error ?? {};
    if (typeof code === "string" && Object.hasOwn(ERROR_CATALOGUE, code) && typeof message === "string") {
      return new ApiError(code as ErrorCode, message, response.status);
    }
  } catch { /* Not a coded refusal. */ }
  return undefined;
}

/** Complete the argument the confirmation binds from the subject read, and
 * read the facts its words name. A call that leaves the bound argument out
 * waits only once the read gave it: what the words name is what runs. */
function bindSubject(subject: ConfirmationWords["subject"], call: ToolCall, read: unknown, refused: ApiError | undefined): Record<string, string> {
  const fill: Record<string, string> = {};
  let describes = read !== undefined;
  if (subject.binds) {
    const { argument, path } = subject.binds;
    const value = read === undefined ? undefined : valuesAt(read, path)[0];
    if (call.args[argument] === undefined) {
      if (value === undefined || value === null) {
        throw refused ?? new ApiError("internal", "What this call acts on could not be read, so nothing was asked or started.", 502);
      }
      call.args = { ...call.args, [argument]: value };
    } else {
      describes = describes && value === call.args[argument];
    }
    fill[argument] = String(call.args[argument]);
  }
  for (const [key, fact] of Object.entries(subject.facts ?? {})) {
    const value = describes ? valuesAt(read, fact.path)[0] : undefined;
    fill[key] = value === undefined || value === null ? fact.fallback
      : fact.bytes && typeof value === "number" ? byteSize(value) : String(value);
  }
  return fill;
}

function byteSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return gb < 10 ? `${gb.toFixed(1)} GB` : `${Math.round(gb)} GB`;
}
