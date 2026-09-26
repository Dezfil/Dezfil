import { resolveRefs, type JsonSchema } from './schema';
export interface OutputAdaptation {
  envelope: 'result-history';
  binary?: { representation: 'attachment' | 'json-image'; nativeImage: boolean };
}
export interface OutputOperation {
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  'x-tool-output'?: OutputAdaptation;
}
const history = { anyOf: [{ type: 'null' }, { type: 'object', properties: { mapId: { type: 'string' }, group: { type: 'string', pattern: '^[\\w-]{1,64}$' } }, required: ['mapId', 'group'], additionalProperties: false }] };
// MCP adds input-validation diagnostics to the API's coded error envelope.
const errorResult = {
  type: 'object', required: ['error'], additionalProperties: false, properties: { error: {
    type: 'object', required: ['code', 'message'], additionalProperties: false, properties: {
      code: { type: 'string' }, message: { type: 'string' },
      position: { type: 'object', required: ['line', 'column'], additionalProperties: false, properties: { line: { type: 'integer' }, column: { type: 'integer' } } },
      issues: { type: 'array', items: {
        type: 'object', required: ['message'], additionalProperties: false, properties: {
          code: { type: 'string' }, message: { type: 'string' }, path: { type: 'array', items: { type: ['string', 'number'] } },
        },
      } },
    },
  } },
};
export function byteLocation(native: boolean, pointer: string) {
  return native ? { index: 1, type: 'image', field: 'data' } : { index: 0, type: 'text', jsonPointer: pointer };
}
function locationSchema(native: boolean, pointer: string) {
  const location = byteLocation(native, pointer);
  return { type: 'object', properties: Object.fromEntries(Object.entries(location).map(([key, value]) => [key, { const: value }])), required: Object.keys(location), additionalProperties: false };
}
export function attachmentSchema(native: boolean, media: string) {
  return { type: 'object', required: ['attachment'], additionalProperties: false, properties: { attachment: {
    type: 'object', required: ['filename', 'content_type', 'size_bytes', 'content'], additionalProperties: false,
    properties: { filename: { type: 'string' }, content_type: { type: 'string', ...(media.startsWith('image/') ? { const: media } : {}) }, size_bytes: { type: 'integer', minimum: 0 }, content: locationSchema(native, '/attachment/content_base64') },
  } } };
}
/** Projection is declared per operation; every success media/status contributes. */
export function projectOutput(operation: OutputOperation, schemas: Record<string, unknown>, name: string) {
  const adaptation = operation['x-tool-output'];
  if (adaptation?.envelope !== 'result-history') throw new Error(`${name}/responses: missing output envelope adaptation`);
  const branches: JsonSchema[] = [];
  const rawBranches: JsonSchema[] = [];
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (!/^2\d\d$/.test(status)) continue;
    const media = Object.entries(response.content ?? {});
    if (!media.length) {
      if (status !== '204') throw new Error(`${name}/responses/${status}: success content is undeclared`);
      branches.push({ type: 'null' }); rawBranches.push({ type: 'null' });
    }
    for (const [type, content] of media) {
      if (content.schema === undefined) throw new Error(`${name}/responses/${status}/${type}: missing schema`);
      const source = resolveRefs(content.schema, schemas);
      if (typeof source === 'object' && source.format === 'binary') {
        if (adaptation.binary?.representation !== 'attachment') throw new Error(`${name}/responses/${status}/${type}: undeclared binary adaptation`);
        branches.push(attachmentSchema(adaptation.binary.nativeImage, type));
        rawBranches.push({ type: 'object', required: ['attachment'], properties: { attachment: { type: 'object', required: ['filename', 'content_type', 'size_bytes', 'content_base64'], properties: {
          filename: { type: 'string' }, content_type: { type: 'string', ...(type.startsWith('image/') ? { const: type } : {}) }, size_bytes: { type: 'integer', minimum: 0 }, content_base64: { type: 'string' },
        } } } });
      } else {
        rawBranches.push(source);
        if (adaptation.binary?.representation === 'json-image') {
          const projected = structuredClone(source) as Record<string, unknown>;
          const props = projected.properties as Record<string, Record<string, unknown>>;
          const image = props?.image;
          if (!image?.properties || !(image.required as string[] | undefined)?.includes('content_base64')) throw new Error(`${name}/responses/${status}/image: undeclared byte field`);
          const fields = image.properties as Record<string, unknown>;
          delete fields.content_base64;
          fields.content = locationSchema(adaptation.binary.nativeImage, '/image/content_base64');
          image.required = (image.required as string[]).map(key => key === 'content_base64' ? 'content' : key);
          branches.push(projected);
        } else branches.push(source);
      }
    }
  }
  if (!branches.length) throw new Error(`${name}/responses: no success schema`);
  const union = (values: JsonSchema[]) => values.length === 1 ? values[0] : { anyOf: values };
  return { outputSchema: { type: 'object' as const, properties: { result: union([...branches, errorResult]), history }, required: ['result', 'history'], additionalProperties: false }, rawOutputSchema: union(rawBranches), outputAdaptation: adaptation };
}
