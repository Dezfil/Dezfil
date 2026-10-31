import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
interface Result { ok: boolean; code?: string; }
/** Each contender opens its own connection in another process before the start barrier. */
export async function race(directory: string, file: string, actions: object[]): Promise<Result[]> {
  const root = process.cwd();
  const loader = path.join(directory, "loader.mjs");
  const worker = path.join(directory, "worker.mjs");
  writeFileSync(loader, `import { registerHooks } from 'node:module';
    import { existsSync } from 'node:fs';
    import { pathToFileURL, fileURLToPath } from 'node:url';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "next/server") return next("next/server.js", context);
      if (specifier.startsWith('@/')) return next(pathToFileURL(${JSON.stringify(root)} + '/src/' + specifier.slice(2) + '.ts').href, context);
      if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        const candidate = new URL(specifier + '.ts', context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
      }
      return next(specifier, context);
    }});`);
  writeFileSync(worker, String.raw`import { pathToFileURL } from 'node:url';
    const root = ${JSON.stringify(root)};
    const { open } = await import(pathToFileURL(root + '/src/lib/metadata/db.ts'));
    const { createProject } = await import(pathToFileURL(root + '/src/lib/metadata/owned-projects.ts'));
    const { inviteAccount } = await import(pathToFileURL(root + '/src/lib/auth/admin.ts'));
    const { authenticateSession } = await import(pathToFileURL(root + '/src/lib/auth/credentials.ts'));
    const { accountScope } = await import(pathToFileURL(root + '/src/lib/auth/scope.ts'));
    const { insertMap } = await import(pathToFileURL(root + '/src/lib/metadata/maps.ts'));
    const db = open(${JSON.stringify(file)});
    process.stdout.write('ready\n');
    process.stdin.once('data', async data => {
      const action = JSON.parse(data.toString());
      try {
        const context = authenticateSession(action.secret, db);
        const scope = accountScope(context, db);
        if (action.kind === 'projects') createProject(scope, { name: action.name }, db);
        if (action.kind === 'people') inviteAccount(context, { name: action.name, email: action.name + '@example.test' }, db);
        if (action.kind === 'maps') insertMap(scope, action.map, db);
        process.stdout.write(JSON.stringify({ ok: true }) + '\n');
      } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code }) + '\n'); }
      finally { db.close(); process.stdin.destroy(); }
    });`);
  const children = actions.map(() => spawn(process.execPath,
    ["--experimental-transform-types", "--import", loader, worker], { stdio: ["pipe", "pipe", "pipe"] }));
  try {
    const results = children.map(child => {
      let output = "", errors = "";
      let readyResolve: () => void, readyReject: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const result = new Promise<Result>((resolve, reject) => {
        child.stdout.on("data", chunk => { output += chunk; if (output.startsWith("ready\n")) readyResolve(); });
        child.stderr.on("data", chunk => { errors += chunk; });
        child.on("error", error => { readyReject(error); reject(error); });
        child.on("exit", code => {
          if (code !== 0) { const error = new Error(`Creation worker exited ${code}: ${errors}`); readyReject(error); reject(error); }
          else resolve(JSON.parse(output.trim().split("\n").at(-1)!));
        });
      });
      // Register both rejection handlers before either worker can fail.
      void result.catch(() => {});
      return { ready, result };
    });
    await Promise.all(results.map(result => result.ready));
    children.forEach((child, index) => child.stdin.end(JSON.stringify(actions[index])));
    return await Promise.all(results.map(result => result.result));
  } finally { children.forEach(child => { if (child.exitCode === null) child.kill(); }); }
}

