import { renameSync } from "node:fs";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { withTrustedMutation } from "@/lib/trusted-mutation";
import { copyTemplateFile } from "./files";
import { mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import type { AccountScope } from "@/lib/auth/scope";
import { buildArtifact } from "@/lib/ingest/ingest";
import { admitTemplateFolder } from "./admission";
import { readTemplateArchive } from "./archive";
import { admitTemplateBindings } from "./bindings";
import { prepareTemplateHome } from "./home";
import {
  downloadedTemplatesDir,
  readInstalledVersion,
  writeInstalledRecord,
  type DatasetMeasurement,
  type InstalledOrigin,
  type InstalledVersion,
} from "./installed";
import { preserveTemplateResourceRefusal, refuse } from "./refusals";

/**
 * Installing a template's archive once its bytes are on this server and
 * are the ones the catalogue's index declares.
 *
 * In order, each step reading only what the one before it passed: the
 * archive through the template reader (its directory before a byte
 * inflates, then the first stage over its documents); every dataset and
 * bundled result through the upload's reader, the archive's file its
 * source and the reader's artifact what is installed, with what the reader
 * measured recorded; the first stage again over the version as it will be
 * installed; its record; the second stage, over that folder; and only then
 * the folder moved into place in one rename. Everything before the move
 * happens in the caller's scratch folder, so a refusal at any step leaves
 * nothing under the downloads' folder.
 */

export interface ExpectedVersion {
  id: string;
  version: number;
  /** The archive's size as transferred, and its SHA-256. */
  size: number;
  sha256: string;
}

/** Each dataset and bundled result through the upload's reader, written
 * into the version folder; answers what it measured, by member. */
async function readDatasets(
  unpacked: string,
  version: string,
  members: { member: string; label: string }[],
): Promise<Record<string, DatasetMeasurement>> {
  const measured: Record<string, DatasetMeasurement> = {};
  for (const { member, label } of members) {
    currentTrustedOperation()?.enterStage("template dataset");
    let meta;
    try {
      meta = await buildArtifact(path.join(unpacked, member), path.basename(member), path.join(version, member));
    } catch (error) {
      preserveTemplateResourceRefusal(error);
      // The reader's own message may quote the file it read, which is a
      // path on this server: the refusal names the member instead.
      if (error instanceof ApiError) refuse("template_malformed", `${label} could not be read as GeoParquet.`);
      throw error;
    }
    measured[member] = {
      rowCount: meta.rowCount,
      geometryColumn: meta.geometryColumn,
      geometryType: meta.geometryType,
      crsAssumed: meta.crsAssumed,
    };
  }
  return measured;
}

/**
 * Install the archive at `archive` (inside `scratch`, a folder the caller
 * owns and removes) as `expected`'s version, from `origin`. Answers the
 * installed version, read back whole against its record.
 */
export async function installTemplateArchive(
  scope: AccountScope,
  scratch: string,
  archive: string,
  expected: ExpectedVersion,
  origin: InstalledOrigin,
  signal?: AbortSignal,
): Promise<InstalledVersion> {
  return withTrustedMutation({ kind: "template-install", name: "Template installation", signal }, async operation => {
    const read = await readTemplateArchive(archive, path.join(scratch, "unpacked"), `${expected.id}-${expected.version}.zip`);
    const { facts } = read.admitted;
    if (facts.id !== expected.id || facts.version !== expected.version) {
      refuse("template_invalid", `The archive holds ${facts.id} version ${facts.version}, and the catalogue lists it as ${expected.id} version ${expected.version}.`);
    }

    // The version as it will be installed: the documents and pictures as the
    // archive holds them, every dataset and result as the reader wrote it.
    const version = path.join(scratch, "version");
    const data = [
      ...read.admitted.datasets.map((d) => ({ member: d.file, label: `The dataset "${d.name}"` })),
      ...(read.admitted.workflow?.steps ?? []).map((s) => ({ member: s.result, label: `The result of the step "${s.id}"` })),
    ];
    const isData = new Set(data.map((d) => d.member));
    for (const member of read.admitted.members.keys()) {
      if (isData.has(member)) continue;
      await mkdir(path.dirname(path.join(version, member)), { recursive: true });
      await copyTemplateFile(path.join(read.folder, member), path.join(version, member));
    }
    const measured = await readDatasets(read.folder, version, data);
    const admitted = await admitTemplateFolder(version);
    const record = await writeInstalledRecord(admitted, { archive: { sha256: expected.sha256, size: expected.size }, origin, measured });
    const prepared = await prepareTemplateHome({ admitted, record }, { own: true });
    try {
      await admitTemplateBindings(scope, admitted, prepared.home);
    } finally {
      await prepared.release();
    }

    const checked = await readInstalledVersion(version);

    // Into place in one rename. A folder already there is one the caller
    // found not to be an installed version (no record, or not this one's):
    // it is moved aside into the scratch, and the scratch goes with it.
    const target = path.join(downloadedTemplatesDir(), facts.id, String(facts.version));
    const parent = path.dirname(target);
    operation.assertCanCommit();
    await mkdir(parent, { recursive: true });
    const replaced = path.join(scratch, "replaced");
    let moved = false;
    try {
      operation.assertCanCommit();
      try {
        renameSync(target, replaced);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      operation.assertCanCommit();
      renameSync(version, target);
    } catch (error) {
      if (moved) renameSync(replaced, target);
      await rmdir(parent).catch(() => {});
      throw error;
    }
    return { ...checked, folder: target, admitted: { ...checked.admitted, folder: target } };
  });
}
