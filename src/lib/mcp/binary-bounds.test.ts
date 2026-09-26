import { afterEach, expect, it, vi } from 'vitest';
import { buildTools } from '@/lib/tools/tools';
import { executeTool } from '@/lib/tools/execute';
import { mcpResult } from './result';
import { limits } from '@/lib/limits';
afterEach(() => vi.unstubAllEnvs());
it('the default 32 MiB attachment cap serializes one byte copy, with metadata resolving to it', async () => {
  expect(limits.toolAttachmentMaxBytes).toBe(32 * 1024 * 1024);
  const bytes = Buffer.alloc(32 * 1024 * 1024, 0xa7);
  const tool = buildTools().find(tool => tool.name === 'export_layer_data')!;
  const executed = await executeTool(tool, { id: 'layer', format: 'geoparquet' }, 'http://localhost:3307', async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="cap.parquet"', 'content-length': String(bytes.length) } }));
  expect(executed.ok).toBe(true);
  const result = mcpResult(tool, executed, null);
  const legacy = JSON.parse((result.content![0] as { text: string }).text).attachment;
  expect(Buffer.from(legacy.content_base64, 'base64').equals(bytes)).toBe(true);
  expect(result.structuredContent).toEqual({ result: { attachment: { filename: 'cap.parquet', content_type: 'application/octet-stream', size_bytes: bytes.length, content: { index: 0, type: 'text', jsonPointer: '/attachment/content_base64' } } }, history: null });
  const serialized = JSON.stringify(result);
  expect(serialized.indexOf(legacy.content_base64)).toBeGreaterThan(0);
  expect(serialized.indexOf(legacy.content_base64, serialized.indexOf(legacy.content_base64) + 1)).toBe(-1);
});
it('384 KiB retained image transport has exactly legacy and native byte copies', () => {
  const bytes = Buffer.alloc(384 * 1024, 0x97);
  const base64 = bytes.toString('base64');
  const tool = buildTools().find(tool => tool.name === 'read_map_look_image')!;
  const result = mcpResult(tool, { ok: true, status: 200, body: { attachment: { filename: 'cap.png', content_type: 'image/png', size_bytes: bytes.length, content_base64: base64 } } }, null);
  expect(JSON.stringify(result).split(base64)).toHaveLength(3);
  expect(JSON.stringify(result.structuredContent)).not.toContain(base64);
  expect(result.content).toHaveLength(2);
});
for (const mode of ['declared', 'streamed'] as const) it(`${mode} overflow cancels the bytes before buffering an oversized attachment`, async () => {
  vi.stubEnv('DEZFIL_TOOL_ATTACHMENT_MAX_MB', '0.001');
  let cancelled = false, pulls = 0;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(600)); }, cancel() { cancelled = true; } });
  const tool = buildTools().find(tool => tool.name === 'export_layer_data')!;
  const result = await executeTool(tool, { id: 'layer', format: 'csv' }, 'http://localhost:3307', async () => new Response(stream, { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="cap.csv"', ...(mode === 'declared' ? { 'content-length': '2000' } : {}) } }));
  expect(result).toMatchObject({ ok: false, status: 413, body: { error: { code: 'attachment_too_large' } } });
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(mode === 'declared' ? 1 : 3);
});
