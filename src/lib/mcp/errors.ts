import { ERROR_CATALOGUE } from '@/lib/api/error-catalogue';
import type { ErrorCode } from '@/lib/api/errors';
import type { ToolResult } from '@/lib/tools/execute';
import type { ArgumentIssue } from '@/lib/tools/validate';
export class McpTransportFailure extends Error {}
/** Product error codes remain authoritative; only documented error fields travel. */
export function codedFailure(code: ErrorCode, status = 502, issues?: ArgumentIssue[]): ToolResult {
  return { ok: false, status, body: { error: { code, message: ERROR_CATALOGUE[code], ...(issues ? { issues } : {}) } } };
}
export function sanitizeFailure(result: ToolResult): ToolResult {
  const error = (result.body as { error?: { code?: unknown; message?: unknown; key?: unknown; limit?: unknown; count?: unknown; position?: { line?: unknown; column?: unknown }; issues?: { code?: unknown; message?: unknown }[] } } | null)?.error;
  if (typeof error?.code !== 'string' || !Object.hasOwn(ERROR_CATALOGUE, error.code)) return codedFailure('internal');
  const code = error.code as ErrorCode;
  if (code === 'internal' || typeof error.message !== 'string') return codedFailure(code, result.status);
  const position = error.position && Number.isInteger(error.position.line) && Number.isInteger(error.position.column)
    ? { line: error.position.line, column: error.position.column } : undefined;
  const issues = Array.isArray(error.issues) ? error.issues.filter(issue => typeof issue?.code === 'string' && typeof issue.message === 'string').map(issue => ({ code: issue.code, message: issue.message })) : undefined;
  const capacity = code === 'instance_limit_reached' && ['mapsLimit', 'projectsLimit', 'peopleLimit'].includes(String(error.key))
    && Number.isSafeInteger(error.limit) && Number(error.limit) > 0 && Number.isSafeInteger(error.count) && Number(error.count) >= 0
    ? { key: error.key, limit: error.limit, count: error.count } : {};
  return { ...result, body: { error: { code, message: error.message, ...capacity, ...(position ? { position } : {}), ...(issues ? { issues } : {}) } } };
}
