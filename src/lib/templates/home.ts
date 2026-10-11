import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AccountScope } from "@/lib/auth/scope";
import { dataDir } from "@/lib/config";
import { templateEvaluation, type EvaluationContext, type TemplateHome, type TemplateMount } from "@/lib/query/context";
import type { AdmittedTemplate } from "./admission";
import { templateDocumentId } from "./ids";
import type { InstalledRecord } from "./installed";
import { refuse } from "./refusals";

/**
 * A template's home: where its SQL binds its names.
 *
 * A template's datasets and bundled results stay in its version folder,
 * and the query engine that runs people's SQL reads only the data folder's
 * artifact directory: it is fenced there, and the fence is never widened
 * for a feature. So each dataset and result the home mounts is first made
 * present in that directory as an artifact of its own: a hard link to the
 * version's file where the two share a disk (a download, or an install in
 * progress), a copy where they do not (a template shipped in the image).
 * Such an artifact is registered as no one's table: nothing lists it, no
 * person's SQL names it, and the boot sweep removes it with every other
 * unregistered artifact.
 *
 * Two ways to stage. Kept, for reading an installed version: named by its
 * content, so one file serves every reader and every version holding the
 * same bytes, made present again by the first home prepared after a
 * restart, and never half written under its name. Own, for an admission:
 * named for this preparation alone and removed when it is released, so a
 * version that is refused, or admitted and then moved into place, leaves
 * nothing in the artifact directory.
 *
 * The home's namespace is the version's datasets under their names and its
 * bundled results under the output names their steps declare, and nothing
 * else, the caller's own datasets included.
 */

const SHA256 = /^[0-9a-f]{64}$/;

async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The artifact of a template's file, relative to the data folder. */
export function templateArtifactName(sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error("A template artifact is named by its SHA-256.");
  return `tables/template-${sha256}.parquet`;
}

/** Make a template's file present in the engine's artifact directory under
 * its content's name; answers that name, relative to the data folder. The
 * caller vouches that the file's content has that checksum (it read the
 * version against its record, or wrote the record itself), or asks for it
 * to be held to it here, before it is made present: a file of other bytes
 * is then refused as differing from its record, and nothing is staged. */
export async function stageTemplateArtifact(file: string, sha256: string, { verify = false }: { verify?: boolean } = {}): Promise<string> {
  const relative = templateArtifactName(sha256);
  const target = path.join(dataDir(), relative);
  try {
    await stat(target);
    return relative;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (verify && (await fileDigest(file)) !== sha256) {
    refuse("template_record_mismatch", `The member "${path.basename(file)}" differs from its record.`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  const partial = path.join(dataDir(), `tables/template-${sha256}-${randomUUID()}.partial`);
  try {
    try {
      await link(file, partial);
    } catch {
      await copyFile(file, partial);
    }
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
  return relative;
}

/** A version as a home is made from: its admitted documents and the record
 * that gives each member's checksum and what the reader measured. */
export interface HomeSource {
  admitted: AdmittedTemplate;
  record: Pick<InstalledRecord, "files" | "measured">;
}

/** A home ready for the engine, and the release of what was staged for it
 * alone (nothing, for a kept staging). */
export interface PreparedHome {
  home: TemplateHome;
  release(): Promise<void>;
}

/** Stage a file for this preparation alone; answers its name, relative to
 * the data folder. */
async function stageOwn(file: string): Promise<string> {
  const relative = `tables/template-${randomUUID()}.parquet`;
  const target = path.join(dataDir(), relative);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await link(file, target);
  } catch {
    await copyFile(file, target);
  }
  return relative;
}

/** Prepare a version's home: every dataset and bundled result made present
 * for the engine, in the manifest's and the steps' order; `own` stages them
 * for this preparation alone. */
export async function prepareTemplateHome(source: HomeSource, { own = false }: { own?: boolean } = {}): Promise<PreparedHome> {
  const { facts, datasets, workflow } = source.admitted;
  const staged: string[] = [];
  const release = async () => {
    for (const relative of staged.splice(0)) await rm(path.join(dataDir(), relative), { force: true });
  };
  const mount = async (member: string, kind: "dataset" | "result", part: string, name: string): Promise<TemplateMount> => {
    const file = source.record.files[member];
    const measured = source.record.measured[member];
    if (!file || !measured) throw new Error(`The version's record does not give "${member}".`);
    const where = path.join(source.admitted.folder, member);
    let relative: string;
    if (own) {
      relative = await stageOwn(where);
      staged.push(relative);
    } else {
      relative = await stageTemplateArtifact(where, file.sha256);
    }
    return {
      id: templateDocumentId({ template: facts.id, version: facts.version, kind, part }),
      name,
      file: relative,
      geometryColumn: measured.geometryColumn,
      geometryType: measured.geometryType,
      rowCount: measured.rowCount,
      crsAssumed: measured.crsAssumed,
    };
  };
  try {
    const mounts: TemplateMount[] = [];
    for (const dataset of datasets) mounts.push(await mount(dataset.file, "dataset", dataset.name, dataset.name));
    const outputs: TemplateMount[] = [];
    for (const step of workflow?.steps ?? []) outputs.push(await mount(step.result, "result", step.id, step.output));
    return { home: { template: facts.id, version: facts.version, datasets: mounts, outputs }, release };
  } catch (error) {
    await release();
    throw error;
  }
}

/** The evaluation a template's map is read in: every dataset and every
 * bundled result. */
export function templateMapEvaluation(scope: AccountScope, home: TemplateHome): EvaluationContext {
  return templateEvaluation(scope, home);
}

/** The evaluation one step of a template's workflow is read in: the
 * datasets and the results of the steps before it, so a step reads only
 * what a run would have made by its turn. */
export function templateStepEvaluation(scope: AccountScope, home: TemplateHome, ordinal: number): EvaluationContext {
  return templateEvaluation(scope, { ...home, outputs: home.outputs.slice(0, ordinal) });
}
