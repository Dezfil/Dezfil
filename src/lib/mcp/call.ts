import { fromJsonSchema, type CallToolResult } from '@modelcontextprotocol/server';
import type { ToolDef } from '@/lib/tools/tools';
import { actionEffects } from '@/lib/assistant/action-metadata';
import { argumentIssues } from '@/lib/tools/validate';
import { executeMcpTool } from './execute';
import { mcpResult } from './result';
import { codedFailure, McpTransportFailure, sanitizeFailure } from './errors';
const validators = new WeakMap<ToolDef, { raw: ReturnType<typeof fromJsonSchema>; structured: ReturnType<typeof fromJsonSchema> }>();
function outputValidators(tool: ToolDef) {
  let pair = validators.get(tool);
  if (!pair) {
    pair = { raw: fromJsonSchema(tool.rawOutputSchema! as Parameters<typeof fromJsonSchema>[0]), structured: fromJsonSchema(tool.outputSchema! as Parameters<typeof fromJsonSchema>[0]) };
    validators.set(tool, pair);
  }
  return pair;
}
/** Own known-tool validation and errors without broadening the offered schema.
 * One dispatch at most. An unusable success establishes no mutation outcome.
 */
export async function callMcpTool(tool: ToolDef, args: Record<string, unknown>, baseUrl: string, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<CallToolResult> {
  try {
    const issues = await argumentIssues(tool, args);
    if (issues) return mcpResult(tool, codedFailure('invalid_request', 400, issues), null);
    const { result, history } = await executeMcpTool(tool, args, baseUrl, signal, fetchImpl);
    if (!result.ok) return mcpResult(tool, sanitizeFailure(result), null);
    const validators = outputValidators(tool);
    if ((await validators.raw['~standard'].validate(result.body)).issues) return mcpResult(tool, codedFailure('mcp_response_invalid'), null);
    const formatted = mcpResult(tool, result, history);
    if ((await validators.structured['~standard'].validate(formatted.structuredContent)).issues) return mcpResult(tool, codedFailure('mcp_response_invalid'), null);
    return formatted;
  } catch (error) {
    const code = error instanceof McpTransportFailure ? actionEffects(tool, args).readOnly ? 'mcp_read_failed' : 'mcp_transport_failed' : error instanceof SyntaxError ? 'mcp_response_invalid' : 'internal';
    return mcpResult(tool, codedFailure(code), null);
  }
}
