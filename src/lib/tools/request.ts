import type { ToolDef } from './tools';

/** Route arguments solely by their documented locations. Explicit owner
 * headers take precedence, so the assistant's turn stamp cannot be replaced.
 */
export function toolRequest(tool: ToolDef, args: Record<string, unknown>, baseUrl: string, headers?: Record<string, string>, signal?: AbortSignal) {
  let apiPath = tool.path;
  for (const param of tool.pathParams) {
    const value = args[param];
    if (value === undefined || value === null || value === '') throw new Error(`Missing required parameter: ${param}`);
    apiPath = apiPath.replace(`{${param}}`, encodeURIComponent(String(value)));
  }
  const query = new URLSearchParams();
  for (const param of tool.queryParams) {
    const value = args[param];
    if (value === undefined || value === null) {
      if (tool.inputSchema.required?.includes(param)) throw new Error(`Missing required parameter: ${param}`);
    } else query.set(param, String(value));
  }
  const qs = query.toString();
  const url = baseUrl.replace(/\/$/, '') + apiPath + (qs ? `?${qs}` : '');
  const init: RequestInit = { method: tool.method.toUpperCase(), signal };
  const external = new Set([...tool.pathParams, ...tool.queryParams, ...(tool.headerParams ?? []).map(p => p.argument)]);
  const body = Object.fromEntries(Object.entries(args).filter(([key, value]) => !external.has(key) && value !== undefined));
  // Hand-authored internal discovery definitions predate the body metadata.
  const hasBody = tool.bodyContent !== undefined || tool.bodyKeys.length > 0;
  const includeBody = Object.keys(body).length > 0 || tool.bodyRequired !== false;
  if (tool.upload && includeBody) {
    const multipart = tool.multipart ?? { field: 'file', filename: 'filename', content: 'content_base64' };
    const filename = args[multipart.filename], content = args[multipart.content];
    if (typeof filename !== 'string' || typeof content !== 'string') throw new Error('Upload requires string filename and content_base64');
    const bytes = Buffer.from(content, 'base64');
    const form = new FormData();
    form.append(multipart.field, new Blob([new Uint8Array(bytes)]), filename);
    for (const [key, value] of Object.entries(body)) {
      if (![multipart.filename, multipart.content].includes(key)) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    init.body = form;
  } else if (hasBody && includeBody) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const routedHeaders = new Headers(init.headers);
  for (const parameter of tool.headerParams ?? []) {
    const value = args[parameter.argument];
    if (value !== undefined) routedHeaders.set(parameter.name, String(value));
  }
  for (const [key, value] of Object.entries(headers ?? {})) routedHeaders.set(key, value);
  if ([...routedHeaders].length) init.headers = Object.fromEntries(routedHeaders);
  return { url, init };
}
