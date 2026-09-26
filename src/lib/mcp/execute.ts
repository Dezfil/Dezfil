import { codedFailure, McpTransportFailure } from "./errors";
import { CHANGE_GROUP_HEADER } from '@/lib/api/change-group';
import { historyAssociation, subjectFacts } from '@/lib/assistant/action-metadata';
import { executeTool } from '@/lib/tools/execute';
import type { ToolDef } from '@/lib/tools/tools';

/** API client only. The subject read is declared by the operation; stored
 * history is never read here. A bodyless deletion resolves its map before work.
 */
export async function executeMcpTool(tool: ToolDef, args: Record<string, unknown>, baseUrl: string, signal?: AbortSignal) {
  const groupParameter = tool.headerParams?.find(parameter => parameter.name.toLowerCase() === CHANGE_GROUP_HEADER.toLowerCase());
  const group = groupParameter && typeof args[groupParameter.argument] === 'string' ? args[groupParameter.argument] as string : undefined;
  const transport: typeof fetch = async (input, init) => {
    try { return await fetch(input, init); }
    catch { throw new McpTransportFailure(); }
  };
  let knownMapId: string | undefined;
  const subject = tool.effects.history && group ? tool.confirmation?.subject : undefined;
  if (subject) {
    const pathname = subject.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(String(args[key] ?? '')));
    const response = await transport(baseUrl.replace(/\/$/, '') + pathname, { signal });
    if (!response.ok) {
      const body: unknown = await response.json();
      return { result: { status: response.status, ok: false, body }, history: null };
    }
    knownMapId = subjectFacts(await response.json())?.mapId;
    if (!knownMapId) return { result: codedFailure('mcp_response_invalid'), history: null };
  }
  const result = await executeTool(tool, args, baseUrl, transport, undefined, signal);
  return { result, history: result.ok ? historyAssociation(tool, args, result.body, group, knownMapId) ?? null : null };
}
