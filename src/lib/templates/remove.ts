import type { Database } from "better-sqlite3";
import { lstat, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { requireAdmin } from "@/lib/auth/admin";
import type { AuthContext } from "@/lib/auth/credentials";
import { dataDir } from "@/lib/config";
import { metadataDb } from "@/lib/metadata/db";
import { inflightSettled } from "@/lib/query/inflight";
import { forgetStorageRead } from "@/lib/system/storage";
import { artifactsOf, bytesUnder, downloadedFolders, recordAt, templateArtifactsInUse, type InstalledFolder } from "./artifacts";
import type { TemplateDownloads } from "./card";
import { inDownloadTurn } from "./download";
import { downloadedTemplatesDir, RECORD_FILE } from "./record";

/**
 * Remove all: the downloaded templates go, and nothing else.
 *
 * What goes is what was downloaded when it began: each version folder under
 * the data folder's `templates/`, with the engine's copies of its data that
 * no installed version needs any more. A shipped template is never touched,
 * and neither is a copy anyone made, whose datasets are files of their own.
 *
 * A version folder is retired as a table's file is retired. In the
 * downloads' own turn, so no download installs meanwhile: its record goes
 * first, which every reader asks for before anything else, so no open,
 * copy or render begun from then on finds the version; then the readers
 * already in flight, which may have bound its files, are waited for; and
 * only then are its files removed. A version another Remove all took
 * meanwhile is not counted twice; a download that lands while it waits for
 * its turn was not there when it began, and stays. A template removed this
 * way downloads again at its next open or copy, while the catalogue lists
 * it.
 */

interface Present extends InstalledFolder {
  /** The engine's copies its record names, and every file's bytes. */
  artifacts: string[];
  bytes: number;
}

/** The downloaded version folders now, each as it is. */
async function present(): Promise<Present[]> {
  const out: Present[] = [];
  for (const version of await downloadedFolders()) {
    const record = await recordAt(version.folder, version.id, version.version);
    out.push({ ...version, artifacts: record ? artifactsOf(record) : [], bytes: await bytesUnder(version.folder) });
  }
  return out;
}

/** Whether the folder is still there: another Remove all may have taken it. */
async function stillThere(version: Present): Promise<boolean> {
  return (await lstat(version.folder).catch(() => null))?.isDirectory() === true;
}

/** Remove every downloaded template, an admin's call. Answers how many
 * versions went and the bytes their folders took. */
export async function removeTemplateDownloads(context: AuthContext, db: Database = metadataDb()): Promise<TemplateDownloads> {
  requireAdmin(context, db, Date.now());
  const began = await present();
  return inDownloadTurn(async () => {
    const retiring: Present[] = [];
    for (const version of began) {
      if (!(await stillThere(version))) continue;
      await rm(path.join(version.folder, RECORD_FILE), { force: true });
      retiring.push(version);
    }
    // Readers in flight may have bound these versions' files before their
    // records went: they finish first.
    await inflightSettled();
    const freed = new Set<string>();
    let bytes = 0;
    for (const version of retiring) {
      await rm(version.folder, { recursive: true, force: true });
      bytes += version.bytes;
      for (const name of version.artifacts) freed.add(name);
    }
    for (const id of new Set(retiring.map((version) => version.id))) {
      await rmdir(path.join(downloadedTemplatesDir(), id)).catch(() => {});
    }
    // The engine's copies only the removed versions needed: a shipped
    // version, or a download left in place, holding the same data keeps
    // its copy.
    const needed = await templateArtifactsInUse();
    for (const name of freed) {
      if (!needed.has(name)) await rm(path.join(dataDir(), "tables", name), { force: true });
    }
    if (retiring.length > 0) forgetStorageRead();
    return { versions: retiring.length, bytes };
  });
}
