import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = process.cwd();
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "next/server") return next("next/server.js", context);
  const target = specifier.startsWith("@/") ? pathToFileURL(root + "/src/" + specifier.slice(2)).href : specifier;
  if ((target.startsWith(".") || target.startsWith("file:")) && context.parentURL) {
    const candidate = new URL(target + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return { ...next(candidate.href, context), format: "module-typescript" };
  }
  const result = next(target, context);
  return result.url.endsWith(".ts") ? { ...result, format: "module-typescript" } : result;
} });
const { metadataDb, closeMetadataDb } = await import("../src/lib/metadata/db.ts");
const { initializeAuthGenerations } = await import("../src/lib/auth/generations.ts");
const { readGenerations } = await import("../src/lib/metadata/auth-generations.ts");
const db = metadataDb(), logs = [];
console.info = line => logs.push(line);
const command = await new Promise(resolve => {
  process.once("message", resolve);
  process.send({ ready: true, pid: process.pid });
});
if (command === "hold") {
  db.exec("BEGIN IMMEDIATE");
  await new Promise(resolve => {
    process.once("message", resolve);
    process.send({ locked: true });
  });
} else {
  const transaction = db.transaction.bind(db);
  db.transaction = callback => {
    const run = transaction(callback);
    return { immediate() {
      // Report after any pre-transaction reads, just before SQLite waits for the lock.
      process.send({ attempting: true });
      return run.immediate();
    } };
  };
}
const applied = initializeAuthGenerations(db);
if (command === "hold") db.exec("COMMIT");
process.stdout.write(JSON.stringify({ applied, generations: readGenerations(db), logs }));
closeMetadataDb();
if (process.connected) process.disconnect();
