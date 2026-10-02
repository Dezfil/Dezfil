import type { ToolDef } from '@/lib/tools/tools';
import type { ToolCall } from './provider';

/** Revision headers are owned per call by the loop, never by its model.
 * The alternate schema is projected from the same documented body/parameters.
 */
export function assistantTools(tools: ToolDef[]): ToolDef[] {
  return tools.map(tool => tool.providerInputSchema ? { ...tool, inputSchema: tool.providerInputSchema } : tool);
}
export function assistantCall(call: ToolCall, tool?: ToolDef): ToolCall {
  if (!tool) return call;
  const owned = new Set((tool.headerParams ?? []).flatMap(parameter => [parameter.argument, parameter.name]));
  if (tool.compoundRevisionPath === "self") owned.add("expectedRevisions");
  const args = Object.fromEntries(Object.entries(call.args).filter(([key]) => !owned.has(key)));
  if (tool.compoundRevisionPath === "members" && args.members && typeof args.members === "object" && !Array.isArray(args.members)) {
    args.members = Object.fromEntries(Object.entries(args.members).filter(([key]) => key !== "expectedRevisions"));
  }
  return { ...call, args };
}
