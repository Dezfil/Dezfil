import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolDef } from '@/lib/tools/tools';
import type { ToolResult } from '@/lib/tools/execute';
import { byteLocation } from '@/lib/tools/output-schema';

export function mcpResult(tool: ToolDef, result: ToolResult, history: { mapId: string; group: string } | null): CallToolResult {
  const text = typeof result.body === 'string' ? result.body : JSON.stringify(result.body) ?? '';
  const content: CallToolResult['content'] = [{ type: 'text', text }];
  let structured = result.body;
  const binary = result.ok ? tool.outputAdaptation?.binary : undefined;
  const body = result.body as Record<string, unknown> | null;
  const key = binary?.representation === 'attachment' ? 'attachment' : 'image';
  if (binary && body && typeof body[key] === 'object' && body[key] !== null) {
    const { content_base64, ...metadata } = body[key] as Record<string, unknown>;
    structured = { ...body, [key]: { ...metadata, content: byteLocation(binary.nativeImage, `/${key}/content_base64`) } };
    if (binary.nativeImage) content.push({ type: 'image', data: content_base64 as string, mimeType: metadata.content_type as string });
  }
  return { content, structuredContent: { result: structured, history }, isError: !result.ok };
}
