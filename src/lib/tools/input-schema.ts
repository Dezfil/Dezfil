import { resolveRefs, type JsonSchema } from './schema';

export interface Parameter {
  name: string; in: string; schema?: unknown; required?: boolean; description?: string;
  'x-tool-name'?: string;
}
export interface InputOperation {
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  'x-tool-input'?: { closed?: boolean; multipart?: { field: string; filename: string; content: string } };
}
export interface InputSchema extends Record<string, unknown> {
  type: 'object'; properties: Record<string, unknown>; required?: string[];
}
/** Names at the body root, including composition/conditional branches. */
function fields(schema: JsonSchema): Record<string, unknown> {
  if (typeof schema === 'boolean') return {};
  const result = { ...schema.properties as Record<string, unknown> };
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    for (const child of schema[key] as JsonSchema[] ?? []) {
      for (const [name, value] of Object.entries(fields(child))) result[name] ??= key === 'allOf' ? value : {};
    }
  }
  for (const key of ['then', 'else']) if (schema[key]) for (const name of Object.keys(fields(schema[key] as JsonSchema))) result[name] ??= {};
  return result;
}

/** A body constraint evaluates the body subset of the flat argument object.
 * Parameter names are explicitly admitted to closed branches, excluded from
 * body key counts and property-name/pattern checks, but validated separately.
 */
function admitParameters(schema: JsonSchema, names: string[]): JsonSchema {
  if (typeof schema === 'boolean' || !names.length) return schema;
  const out = { ...schema };
  if (out.properties || out.additionalProperties !== undefined || out.unevaluatedProperties !== undefined) {
    out.properties = { ...out.properties as Record<string, unknown>, ...Object.fromEntries(names.map(n => [n, {}])) };
  }
  if (out.propertyNames) out.propertyNames = { anyOf: [out.propertyNames, { enum: names }] };
  if (out.patternProperties) {
    const excluded = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    out.patternProperties = Object.fromEntries(Object.entries(out.patternProperties as Record<string, unknown>).map(([pattern, value]) => [`^(?!(?:${excluded})$)(?=[\\s\\S]*(?:${pattern}))`, value]));
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(out[key])) out[key] = (out[key] as JsonSchema[]).map(child => admitParameters(child, names));
  for (const key of ['not', 'if', 'then', 'else']) if (out[key] !== undefined) out[key] = admitParameters(out[key] as JsonSchema, names);
  if (out.dependentSchemas) out.dependentSchemas = Object.fromEntries(Object.entries(out.dependentSchemas as Record<string, JsonSchema>).map(([name, child]) => [name, admitParameters(child, names)]));
  if (typeof out.minProperties === 'number' || typeof out.maxProperties === 'number') {
    if (names.length > 8) throw new Error('Body key-count adaptation exceeds eight parameters');
    const { minProperties, maxProperties } = out;
    delete out.minProperties; delete out.maxProperties;
    const choices = Array.from({ length: 2 ** names.length }, (_, mask) => {
      const present = names.filter((_, i) => mask & (1 << i));
      return { required: present, allOf: names.filter(n => !present.includes(n)).map(n => ({ not: { required: [n] } })),
        ...(typeof minProperties === 'number' ? { minProperties: minProperties + present.length } : {}),
        ...(typeof maxProperties === 'number' ? { maxProperties: maxProperties + present.length } : {}) };
    });
    out.allOf = [...out.allOf as unknown[] ?? [], { anyOf: choices }];
  }
  return out;
}

export function projectInput(operation: InputOperation, schemas: Record<string, unknown>, name: string) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const pathParams: string[] = [], queryParams: string[] = [];
  const headerParams: { name: string; argument: string }[] = [];
  for (const parameter of operation.parameters ?? []) {
    if (!['path', 'query', 'header'].includes(parameter.in)) throw new Error(`${name}: unsupported parameter location ${parameter.in}`);
    const argument = parameter['x-tool-name'] ?? parameter.name;
    if (argument in properties) throw new Error(`${name}: duplicate parameter ${argument}`);
    if (!parameter.schema) throw new Error(`${name}/${argument}: missing parameter schema`);
    const resolved = resolveRefs(parameter.schema, schemas);
    properties[argument] = typeof resolved === 'boolean' ? resolved : { ...resolved, ...(parameter.description ? { description: parameter.description } : {}) };
    if (parameter['x-tool-name'] && parameter.in !== 'header') throw new Error(`${name}/${argument}: aliases are only declared for headers`);
    if (parameter.in === 'path') pathParams.push(argument);
    if (parameter.in === 'query') queryParams.push(argument);
    if (parameter.in === 'header') headerParams.push({ name: parameter.name, argument });
    if (parameter.in === 'path' || parameter.required) required.push(argument);
  }
  const externalNames = Object.keys(properties);
  const content = operation.requestBody?.content ?? {};
  for (const media of Object.keys(content)) if (!['application/json', 'multipart/form-data'].includes(media)) throw new Error(`${name}/requestBody/${media}: undeclared input adaptation`);
  const upload = 'multipart/form-data' in content;
  let body = resolveRefs(content[upload ? 'multipart/form-data' : 'application/json']?.schema ?? { type: 'object' }, schemas);
  const multipart = operation['x-tool-input']?.multipart;
  if (upload) {
    if (!multipart || typeof body === 'boolean') throw new Error(`${name}: undeclared multipart adaptation`);
    if (['allOf', 'anyOf', 'oneOf', 'if'].some(key => key in (body as Record<string, unknown>))) throw new Error(`${name}/requestBody: multipart composition has no declared adaptation`);
    const props = fields(body);
    const file = props[multipart.field] as { type?: string; format?: string; description?: string };
    if (file?.type !== 'string' || file.format !== 'binary') throw new Error(`${name}: multipart file is not declared binary`);
    delete props[multipart.field];
    props[multipart.filename] = { type: 'string', description: 'The uploaded file name, including its extension.' };
    props[multipart.content] = { type: 'string', description: 'The file bytes, encoded as base64.' + (file.description ? ' ' + file.description : '') };
    body = { ...body, properties: props, required: (body.required as string[] ?? []).flatMap(key => key === multipart.field ? [multipart.filename, multipart.content] : [key]) };
  }
  const bodyFields = fields(body);
  for (const key of Object.keys(bodyFields)) if (externalNames.includes(key)) throw new Error(`Tool ${name}: body key "${key}" collides with a parameter`);
  const bodyKeys = Object.keys(bodyFields);
  let projected = admitParameters(body, externalNames);
  if (operation.requestBody && !operation.requestBody.required) {
    projected = { anyOf: [{ type: 'object', properties, additionalProperties: false }, projected] };
  }
  const bodyRequired = operation.requestBody?.required && typeof body === 'object' ? body.required as string[] ?? [] : [];
  const inputSchema: InputSchema = {
    ...typeof projected === 'object' ? projected : { allOf: [projected] },
    type: 'object', properties: { ...properties, ...bodyFields },
    ...(operation['x-tool-input']?.closed ? { additionalProperties: false } : {}),
    ...required.length || bodyRequired.length ? { required: [...new Set([...required, ...bodyRequired])] } : {},
  };
  return { inputSchema, pathParams, queryParams, headerParams, bodyKeys: upload ? bodyKeys.filter(key => key !== multipart?.filename && key !== multipart?.content) : bodyKeys, upload,
    ...(operation.requestBody ? { bodyRequired: operation.requestBody.required === true, bodyContent: upload ? 'multipart' as const : 'json' as const } : {}),
    ...(multipart ? { multipart } : {}),
  };
}
