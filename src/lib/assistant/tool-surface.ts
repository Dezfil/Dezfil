import type { ToolDef } from '@/lib/tools/tools';
import type { ToolCall } from './provider';

/** External caller headers are owned by the assistant turn, not its model.
 * The alternate schema is projected from the same documented body/parameters.
 */
export function assistantTools(tools: ToolDef[]): ToolDef[] {
  return tools.map(tool => tool.providerInputSchema ? { ...tool, inputSchema: tool.providerInputSchema } : tool);
}
export function assistantCall(call: ToolCall, tool?: ToolDef): ToolCall {
  if (!tool?.headerParams?.length) return call;
  const owned = new Set(tool.headerParams.flatMap(parameter => [parameter.argument, parameter.name]));
  return { ...call, args: Object.fromEntries(Object.entries(call.args).filter(([key]) => !owned.has(key))) };
}
