import { withTrustedMutation } from "@/lib/trusted-mutation";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AccountScope } from "@/lib/auth/scope";
import { admitTemplateBindings } from "./bindings";
import { SHIPPED_TEMPLATES_MAX_BYTES, TEMPLATE_DOCUMENT_MAX_BYTES } from "./format";
import { prepareTemplateHome } from "./home";
import { readInstalledVersion, type InstalledVersion } from "./installed";
import { preserveTemplateResourceRefusal, TemplateRefusal } from "./refusals";
import { SHIPPED_INDEX_FILE, shippedIndexProblem, shippedTemplatesDir, type ShippedIndex } from "./shipped-index";

export {
  SHIPPED_INDEX_FILE,
  SHIPPED_INDEX_FORMAT_VERSION,
  shippedTemplatesDir,
  type ShippedIndex,
} from "./shipped-index";

/**
 * The shipped set: the templates the image carries, installed in the
 * repository's top-level `templates/` folder and copied into the image
 * beside the application. The folder holds an index and one installed
 * version folder per listed version, `<id>/<version>/`; the index lists
 * the versions the release ships, and nothing else is in the folder.
 *
 * The set changes only with a release, and the shipped versions work with
 * no network: their data, facts and pictures are all on disk.
 */

export interface ShippedSetCheck {
  /** Every listed version that passed, in the index's order. */
  versions: InstalledVersion[];
  /** Every member of the listed versions together, records included. */
  bytes: number;
  /** One line per fault, naming the version and its refusal. */
  problems: string[];
}

/** Read the shipped index; a missing or malformed one is a fault of the
 * release, named. */
export async function readShippedIndex(dir: string): Promise<ShippedIndex> {
  const text = await readFile(path.join(dir, SHIPPED_INDEX_FILE), { encoding: "utf8", signal: currentTrustedOperation()?.signal });
  if (Buffer.byteLength(text) > TEMPLATE_DOCUMENT_MAX_BYTES) throw new Error("The shipped index is larger than a document may be.");
  const raw: unknown = JSON.parse(text);
  const problem = shippedIndexProblem(raw);
  if (problem) throw new Error(problem);
  return raw as ShippedIndex;
}

/**
 * Hold a shipped folder to the rules every template must meet: the index
 * well formed, each listed version installed at `<id>/<version>/` and read
 * back whole against its record (the first stage, the licence and credit
 * rules among it), its documents bound to its own data (the second stage,
 * the reference rule among it, read as `scope`), nothing in the folder the
 * index does not list, and every listed version together within the
 * shipped bound. Answers every fault, not only the first, so a release
 * sees all it must fix.
 */
export async function checkShippedSet(
  scope: AccountScope,
  dir: string = shippedTemplatesDir(),
  { maxBytes = SHIPPED_TEMPLATES_MAX_BYTES, signal }: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<ShippedSetCheck> {
  return withTrustedMutation({ kind: "template-install", name: "Shipped template validation", signal }, async () => {
    const problems: string[] = [];
    let index: ShippedIndex;
    try {
      index = await readShippedIndex(dir);
    } catch (error) {
      preserveTemplateResourceRefusal(error);
      return { versions: [], bytes: 0, problems: [error instanceof Error ? error.message : String(error)] };
    }
    const versions: InstalledVersion[] = [];
    let bytes = 0;
    for (const entry of index.templates) {
      currentTrustedOperation()?.enterStage("shipped template validation");
      const label = `${entry.id} version ${entry.version}`;
      try {
        const version = await readInstalledVersion(path.join(dir, entry.id, String(entry.version)));
        if (version.record.origin.kind !== "shipped") problems.push(`${label}: its record does not say it is shipped.`);
        const prepared = await prepareTemplateHome(version, { own: true });
        try {
          await admitTemplateBindings(scope, version.admitted, prepared.home);
        } finally {
          await prepared.release();
        }
        bytes += [...version.admitted.members.values()].reduce((sum, b) => sum + b, 0);
        versions.push(version);
      } catch (error) {
        preserveTemplateResourceRefusal(error);
        if (error instanceof TemplateRefusal) problems.push(`${label}: ${error.code}: ${error.message}`);
        else problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const listed = new Map(index.templates.map((t) => [t.id, String(t.version)]));
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === SHIPPED_INDEX_FILE) continue;
      if (!entry.isDirectory() || !listed.has(entry.name)) {
        problems.push(`The shipped folder holds "${entry.name}", which its index does not list.`);
        continue;
      }
      for (const version of await readdir(path.join(dir, entry.name))) {
        if (version !== listed.get(entry.name)) problems.push(`The shipped folder holds "${entry.name}/${version}", which its index does not list.`);
      }
    }
    if (bytes > maxBytes) {
      problems.push(`The shipped templates together are ${(bytes / (1024 * 1024)).toFixed(1)} MB; the image carries at most ${(maxBytes / (1024 * 1024)).toFixed(1)} MB of them.`);
    }
    return { versions, bytes, problems };
  });
}
