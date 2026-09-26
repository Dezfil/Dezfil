import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { ToolDef } from './tools';

const validators = new WeakMap<ToolDef, ReturnType<typeof fromJsonSchema>>();
export interface ArgumentIssue { message: string; path?: (string | number)[] }
export async function argumentIssues(tool: ToolDef, args: unknown): Promise<ArgumentIssue[] | undefined> {
  let validator = validators.get(tool);
  if (!validator) {
    validator = fromJsonSchema(tool.inputSchema as Parameters<typeof fromJsonSchema>[0]);
    validators.set(tool, validator);
  }
  const result = await validator['~standard'].validate(args);
  return result.issues?.map(issue => ({
    message: issue.message,
    ...(issue.path ? { path: issue.path.map(segment => {
      const key = typeof segment === 'object' ? segment.key : segment;
      return typeof key === 'number' ? key : String(key);
    }) } : {}),
  }));
}
export async function validArguments(tool: ToolDef, args: unknown): Promise<boolean> {
  return !await argumentIssues(tool, args);
}
