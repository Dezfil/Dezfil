import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
interface Result { ok: boolean; code?: string; status?: number; message?: string; }
/** Each contender opens its own connection in another process before the start barrier. */
export async function race(directory: string, file: string, actions: { kind: string; [key: string]: unknown }[]): Promise<Result[]> {
  const root = process.cwd();
  const loader = path.join(directory, "loader.mjs");
  const worker = path.join(directory, "worker.mjs");
  writeFileSync(loader, `import { registerHooks } from 'node:module';
    import { existsSync } from 'node:fs';
    import { pathToFileURL, fileURLToPath } from 'node:url';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "next/server") return next("next/server.js", context);
      if (specifier.startsWith('@/')) {
        const candidate = ${JSON.stringify(root)} + '/src/' + specifier.slice(2);
        return next(pathToFileURL(existsSync(candidate) ? candidate : candidate + '.ts').href, context);
      }
      if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        const candidate = new URL(specifier + '.ts', context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
      }
      return next(specifier, context);
    }, load(url, context, next) {
      if (url.endsWith('.json')) return next(url, { ...context, importAttributes: { type: 'json' } });
      return next(url, context);
    }});`);
  writeFileSync(worker, String.raw`import { pathToFileURL } from 'node:url';
    const root = ${JSON.stringify(root)};
    const { metadataDb } = await import(pathToFileURL(root + '/src/lib/metadata/db.ts'));
    const { POST: createProject } = await import(pathToFileURL(root + '/src/app/api/projects/route.ts'));
    const { socketRequest } = await import(pathToFileURL(root + '/src/lib/assistant/testing/socket-request.ts'));
    const { inviteAccount } = await import(pathToFileURL(root + '/src/lib/auth/admin.ts'));
    const { authenticateSession } = await import(pathToFileURL(root + '/src/lib/auth/credentials.ts'));
    const { accountScope } = await import(pathToFileURL(root + '/src/lib/auth/scope.ts'));
    const { createMap, duplicateMap } = await import(pathToFileURL(root + '/src/lib/map-service.ts'));
    const { copyTemplate, setCopySeamForTests } = await import(pathToFileURL(root + '/src/lib/templates/copy.ts'));
    const db = metadataDb();
    if (db.name !== ${JSON.stringify(file)}) throw new Error('Contender opened the wrong database');
    process.stdout.write('ready\n');
    process.stdin.once('data', async data => {
      const action = JSON.parse(data.toString());
      try {
        const context = authenticateSession(action.secret, db);
        const scope = accountScope(context, db);
        if (action.kind === 'projects') {
          const response = await createProject(socketRequest(new Request('http://instance.test/api/projects', {
            method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://instance.test',
              cookie: 'dezfil_session=' + action.secret }, body: JSON.stringify({ name: action.name }),
          })));
          if (response.status !== 201) {
            const { error } = await response.json();
            process.stdout.write(JSON.stringify({ ok: false, status: response.status, ...error }) + '\n');
            return;
          }
        }
        if (action.kind === 'people') inviteAccount(context, { name: action.name, email: action.name + '@example.test' }, db);
        if (action.kind === 'createMap') createMap(scope, action.name);
        if (action.kind === 'duplicateMap') duplicateMap(scope, action.sourceId);
        if (action.kind === 'copyTemplate') {
          setCopySeamForTests({ beforeTransaction() {
            // Finish every contender's async preparation before racing the outer transaction.
            const released = new Promise(resolve => process.once('message', resolve));
            process.stdout.write('prepared\n');
            return released;
          }});
          await copyTemplate(scope, action.templateId, { name: action.name });
        }
        process.stdout.write(JSON.stringify({ ok: true }) + '\n');
      } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }) + '\n'); }
      finally { db.close(); process.stdin.destroy(); process.disconnect(); }
    });`);
  const children = actions.map(() => spawn(process.execPath,
    ["--experimental-transform-types", "--import", loader, worker], { stdio: ["pipe", "pipe", "pipe", "ipc"] }));
  try {
    const results = children.map(child => {
      let output = "", errors = "";
      let readyResolve: () => void, readyReject: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      let preparedResolve: () => void, preparedReject: (error: Error) => void;
      const prepared = new Promise<void>((resolve, reject) => { preparedResolve = resolve; preparedReject = reject; });
      const result = new Promise<Result>((resolve, reject) => {
        child.stdout!.on("data", chunk => {
          output += chunk;
          if (output.startsWith("ready\n")) readyResolve();
          if (output.includes("\nprepared\n")) preparedResolve();
        });
        child.stderr!.on("data", chunk => { errors += chunk; });
        child.on("error", error => { readyReject(error); preparedReject(error); reject(error); });
        child.on("exit", code => {
          if (code !== 0) { const error = new Error(`Creation worker exited ${code}: ${errors}`); readyReject(error); preparedReject(error); reject(error); }
          else {
            preparedReject(new Error(`Creation worker exited before the transaction barrier: ${output}`));
            resolve(JSON.parse(output.trim().split("\n").at(-1)!));
          }
        });
      });
      // Register both rejection handlers before either worker can fail.
      void result.catch(() => {});
      void prepared.catch(() => {});
      return { ready, prepared, result };
    });
    await Promise.all(results.map(result => result.ready));
    children.forEach((child, index) => child.stdin!.end(JSON.stringify(actions[index])));
    const copies = actions.flatMap((action, index) => action.kind === "copyTemplate" ? [index] : []);
    await Promise.all(copies.map(index => results[index].prepared));
    copies.forEach(index => children[index].send("commit"));
    return await Promise.all(results.map(result => result.result));
  } finally { children.forEach(child => { if (child.exitCode === null) child.kill(); }); }
}

