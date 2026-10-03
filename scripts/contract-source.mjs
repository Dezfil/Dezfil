import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/** Load the same static contract as the application, with no build or server. */
export async function contractSource(root = process.cwd()) {
  const source = pathToFileURL(path.join(root, 'src') + path.sep).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const target = specifier.startsWith('@/') ? new URL(specifier.slice(2), source).href : specifier;
      let result;
      try { result = next(target, context); }
      catch (error) {
        if (!target.startsWith('.') && !target.startsWith('file:')) throw error;
        result = next(target + '.ts', context);
      }
      return result.url.startsWith(source) && result.url.endsWith('.ts')
        ? { ...result, format: 'module-typescript' } : result;
    },
  });
  try {
    const { buildOpenApiDocument } = await import(new URL('lib/api/openapi.ts', source));
    const { buildTools } = await import(new URL('lib/tools/tools.ts', source));
    return { document: buildOpenApiDocument(), tools: buildTools() };
  } finally { hooks.deregister(); }
}
