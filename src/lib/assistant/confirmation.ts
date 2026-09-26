import { ApiError } from "@/lib/api/errors";
import type { ToolDef } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import type { ToolCall } from "./provider";
import { valuesAt, type ResolvedConfirmation } from "./action-metadata";

interface ConfirmationDeps { baseUrl: string; fetchImpl?: typeof fetch; signal?: AbortSignal }
/** The recipe API owns membership. Bind its current ordered plan, never model-supplied membership. */
export async function prepareConfirmation(tool: ToolDef, call: ToolCall, deps: ConfirmationDeps): Promise<{ words: ResolvedConfirmation; subject?: unknown } | undefined> {
  let required = tool.confirm;
  if (tool.confirmWhen === "when_wide" && call.args.plan !== true) {
    const probe = await executeTool(tool, { ...call.args, plan: true }, deps.baseUrl, deps.fetchImpl, undefined, deps.signal);
    const plan = (probe.body as { plan?: { wide?: unknown; members?: unknown } } | null)?.plan;
    if (!probe.ok || typeof plan?.wide !== "boolean" || !Array.isArray(plan.members) || !plan.members.every((id) => typeof id === "string" && id.length > 0)) {
      throw new ApiError("assistant_plan_unavailable", "The current workflow membership could not be established. No run was approved or started.", 409);
    }
    call.args = { ...call.args, members: [...plan.members] };
    required = plan.wide;
  }
  if (!required) return undefined;
  const words = tool.confirmation;
  if (!words) throw new Error(`Missing confirmation declaration for ${tool.name}`);
  const identity = String(call.args[words.subject.argument] ?? "");
  let name: string | undefined;
  let read: unknown;
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
    }
  } catch { /* Identity remains exact if the optional display name cannot be read. */ }
  const target = name && name !== identity ? `${name} (${identity})` : identity;
  return { words: { target: words.target.replace("{target}", target), consequence: words.consequence }, subject: read };
}
