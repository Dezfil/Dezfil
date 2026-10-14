import { renameSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { templateSource } from "./template-source.mjs";

const usage = "Usage: npm run templates:install -- ARCHIVE --sha256 HASH --size BYTES [--target templates] [--allow-downgrade]";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    sha256: { type: "string" }, size: { type: "string" }, target: { type: "string", default: "templates" },
    "allow-downgrade": { type: "boolean", default: false },
  } });
  const size = Number(values.size);
  if (positionals.length !== 1 || !/^[0-9a-f]{64}$/.test(values.sha256 ?? "") || !Number.isSafeInteger(size) || size < 1) throw new Error(usage);
  const input = positionals[0];
  const remote = /^https?:\/\//i.test(input);
  if (remote) {
    const url = new URL(input);
    if (url.username || url.password) throw new Error("The archive URL must not contain credentials.");
  }
  const target = path.resolve(values.target);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const lock = target + ".lock";
  await mkdir(lock).catch(error => {
    if (error.code === "EEXIST") throw new Error(`Another template install owns the target lock: ${lock}`);
    throw error;
  });
  let scratch, closeStore, resetEngine, loader;
  let preserveScratch = false;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try { await resetEngine?.(); }
    finally {
      closeStore?.(); loader?.deregister();
      try { if (scratch && !preserveScratch) await rm(scratch, { recursive: true, force: true }); }
      finally { await rm(lock, { recursive: true, force: true }); }
    }
  };
  try {
    scratch = await mkdtemp(path.join(parent, `.${path.basename(target)}-install-`));
    // An install owns its whole temporary instance and never opens an operator's data.
    process.env.DEZFIL_DATA_DIR = path.join(scratch, "data");
    loader = templateSource();
    const { metadataDb, closeMetadataDb } = await import("../src/lib/metadata/db.ts");
    const { purgeQueryStores } = await import("../src/lib/query/retained.ts");
    closeStore = closeMetadataDb; resetEngine = purgeQueryStores;
    const { insertAccount } = await import("../src/lib/metadata/accounts.ts");
    const { issueSession, authenticateSession } = await import("../src/lib/auth/credentials.ts");
    const { accountScope } = await import("../src/lib/auth/scope.ts");
    const { transferTemplateArchive } = await import("../src/lib/templates/download.ts");
    const { readTemplateArchive } = await import("../src/lib/templates/archive.ts");
    const { installTemplateArchive } = await import("../src/lib/templates/install.ts");
    const { readShippedIndex, checkShippedSet } = await import("../src/lib/templates/shipped.ts");
    const { TEMPLATE_ARCHIVE_MAX_BYTES } = await import("../src/lib/templates/format.ts");
    const { withTrustedMutation } = await import("../src/lib/trusted-mutation.ts");
    const { copyTemplateFile } = await import("../src/lib/templates/files.ts");
    await withTrustedMutation({ kind: "template-install", name: "Shipped template installation" }, async operation => {
      operation.defer(cleanup);
      if (size > TEMPLATE_ARCHIVE_MAX_BYTES) throw new Error("template_archive_too_large: The release exceeds the template archive bound.");
      const archive = path.join(scratch, "archive.zip");
      await transferTemplateArchive({ archive: remote ? input : path.resolve(input), size, sha256: values.sha256 },
        remote ? { kind: "address", address: input, source: "environment" } : { kind: "folder", folder: path.dirname(path.resolve(input)), source: "environment" }, archive);
      const { admitted: { facts } } = await readTemplateArchive(archive, path.join(scratch, "inspect"));
      const present = await stat(target).then(() => true, error => { if (error.code !== "ENOENT") throw error; return false; });
      const index = present ? await readShippedIndex(target) : { formatVersion: 1, templates: [] };
      const shipped = index.templates.find(entry => entry.id === facts.id);
      if (shipped?.version === facts.version) {
        throw new Error(`${facts.id} version ${facts.version} is already shipped. Released versions are immutable.`);
      }
      if (shipped && facts.version < shipped.version && !values["allow-downgrade"]) {
        throw new Error(`${facts.id} version ${facts.version} is older than shipped version ${shipped.version}. Use --allow-downgrade to replace it explicitly.`);
      }
      const db = metadataDb();
      const account = insertAccount({ id: "template-builder", name: "Template builder", email: "templates@example.invalid",
        passwordHash: null, status: "active", isAdmin: false, now: new Date().toISOString() }, db);
      const session = issueSession(account, db, Date.now());
      const scope = accountScope(authenticateSession(session.secret, db), db);
      const installed = await installTemplateArchive(scope, scratch, archive,
        { id: facts.id, version: facts.version, size, sha256: values.sha256 }, { kind: "shipped" });
      const staged = path.join(scratch, "shipped");
      const copyTree = async (source, destination) => {
        operation.enterStage("shipped template copy");
        const entry = await lstat(source);
        if (entry.isSymbolicLink()) throw new Error("The shipped target must not contain symbolic links.");
        if (entry.isDirectory()) {
          await mkdir(destination);
          for (const name of await readdir(source)) await copyTree(path.join(source, name), path.join(destination, name));
        } else await copyTemplateFile(source, destination);
      };
      if (present) await copyTree(target, staged);
      else await mkdir(staged);
      await rm(path.join(staged, facts.id), { recursive: true, force: true });
      await mkdir(path.join(staged, facts.id));
      await rename(installed.folder, path.join(staged, facts.id, String(facts.version)));
      const previous = index.templates.findIndex(entry => entry.id === facts.id);
      const entry = { id: facts.id, version: facts.version };
      if (previous < 0) index.templates.push(entry); else index.templates[previous] = entry;
      await writeFile(path.join(staged, "index.json"), JSON.stringify(index, null, 2) + "\n");
      const check = await checkShippedSet(scope, staged);
      if (check.problems.length) throw new Error(check.problems.join("\n"));
      const backup = path.join(scratch, "previous");
      operation.assertCanCommit();
      if (present) renameSync(target, backup);
      try { operation.assertCanCommit(); renameSync(staged, target); }
      catch (error) {
        if (present) {
          try { renameSync(backup, target); }
          catch (rollback) { preserveScratch = true; throw new AggregateError([error, rollback], `Restore the previous templates from ${backup}.`); }
        }
        throw error;
      }
      console.log(`Installed ${facts.id} version ${facts.version} into ${target}`);
    });
  } finally {
    await cleanup();
  }
}

// The command has no work after cleanup. Flush both streams before ending.
function finish(code) {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}
main().then(() => finish(0), error => {
  console.error(`${error.code ? `${error.code}: ` : ""}${error.message}`);
  finish(1);
});
