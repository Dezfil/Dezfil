import { observeDeletionCleanup } from "@/lib/auth/account-deletion-work";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/config";
interface OwnedFile { accountId: string; file: string; directory: boolean }
const folder = () => path.join(dataDir(), "file-owners");
function relative(file: string): string {
  const rel = path.relative(dataDir(), path.resolve(dataDir(), file));
  if (!/^(tables|tmp|exports|tiles\/scratch)\/.+/.test(rel) || rel.split(path.sep).includes("..")) throw new Error("Invalid owned file location.");
  return rel;
}
const recordPath = (file: string) => path.join(folder(), `${createHash("sha256").update(file).digest("hex")}.json`);
/** Record before writing bytes. Generations keep their owner after row swaps,
 * and failed unlink obligations survive restart without guessing UUID owners. */
export function registerAccountFile(accountId: string, file: string, directory = false): void {
  const rel = relative(file); mkdirSync(folder(), { recursive: true });
  const record: OwnedFile = { accountId, file: rel, directory };
  try { writeFileSync(recordPath(rel), JSON.stringify(record), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = JSON.parse(readFileSync(recordPath(rel), "utf8")) as OwnedFile;
    if (previous.accountId !== accountId || previous.directory !== directory) throw new Error("Conflicting file ownership.");
  }
}
export function ownedFileRecords(): OwnedFile[] {
  let names: string[];
  try { names = readdirSync(folder()); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.map(name => {
    const record = JSON.parse(readFileSync(path.join(folder(), name), "utf8")) as OwnedFile;
    if (typeof record.accountId !== "string" || relative(record.file) !== record.file || recordPath(record.file) !== path.join(folder(), name)) throw new Error("Invalid file ownership record.");
    return record;
  });
}
export function accountFiles(accountId: string): string[] { return ownedFileRecords().filter(r => r.accountId === accountId).map(r => r.file).sort(); }
/** The ledger is forgotten only after the operating system confirms removal. */
export async function removeAccountFile(file: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
  return observeDeletionCleanup(async () => {
  await rm(file, { ...options, force: true });
  let rel: string;
  try { rel = relative(file); } catch { return; }
  rmSync(recordPath(rel), { force: true });
  });
}

export function fileAccountId(file: string): string | undefined {
  let rel: string;
  try { rel = relative(file); } catch { return undefined; }
  try { return (JSON.parse(readFileSync(recordPath(rel), "utf8")) as OwnedFile).accountId; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function registerExistingAccountFile(accountId: string, file: string): void {
  if (existsSync(path.resolve(dataDir(), file))) registerAccountFile(accountId, file);
}
