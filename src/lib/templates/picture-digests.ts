import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { downloadedTemplatesDir, RECORD_FILE } from "./record";
import { shippedTemplatesDir } from "./shipped-index";

/**
 * The SHA-256 of every card picture the template versions on this
 * instance carry, shipped in the image and downloaded alike, as each
 * version's record gives them. A template copy saves those bytes as they
 * came, so a published picture with one of these checksums is a
 * template's own. A folder whose documents cannot be read adds nothing.
 */
export async function installedTemplatePictureDigests(): Promise<Set<string>> {
  const digests = new Set<string>();
  for (const root of [shippedTemplatesDir(), downloadedTemplatesDir()]) {
    for (const id of await folders(root)) {
      for (const version of await folders(path.join(root, id))) {
        const folder = path.join(root, id, version);
        try {
          const facts = JSON.parse(await readFile(path.join(folder, "template.json"), "utf8")) as { pictures?: Record<string, unknown> };
          const record = JSON.parse(await readFile(path.join(folder, RECORD_FILE), "utf8")) as { files?: Record<string, { sha256?: unknown }> };
          for (const member of Object.values(facts.pictures ?? {})) {
            const sha256 = typeof member === "string" ? record.files?.[member]?.sha256 : undefined;
            if (typeof sha256 === "string") digests.add(sha256);
          }
        } catch {
          // Not a readable version folder: it carries no picture to know.
        }
      }
    }
  }
  return digests;
}

async function folders(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
