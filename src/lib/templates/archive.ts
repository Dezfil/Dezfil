import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import { expandedSize, extractArchive, listArchive } from "@/lib/ingest/container";
import { limits } from "@/lib/limits";
import { admitTemplateFolder, type AdmittedTemplate } from "./admission";
import { TEMPLATE_ARCHIVE_MAX_BYTES } from "./format";
import { refuse, TemplateRefusal } from "./refusals";

/**
 * Reading a template archive: the only place that opens one.
 *
 * The container module's safety does the unpacking (names sanitized,
 * extraction confined, the unpacked size bounded from the archive's own
 * directory before a byte inflates, every member's length and CRC checked
 * as it lands); this reader adds the template's own bounds and shape
 * before it does, then the first stage of the admission over what landed.
 * Every refusal is coded, and a refused archive leaves nothing: the folder
 * it unpacked into is removed whole.
 *
 * An archive holds one root folder, `<name>.dezfil/`, as the project
 * export writes it, and the version is that folder's contents.
 */

export interface ReadTemplate {
  /** The unpacked version folder, inside the destination. */
  folder: string;
  admitted: AdmittedTemplate;
  /** The archive's size as transferred, and its declared unpacked size. */
  archiveBytes: number;
  unpackedBytes: number;
}

const ROOT = /^[^/]+\.dezfil$/;

/**
 * Unpack and admit an archive into `destination`, a folder the caller owns
 * that must not exist yet. On a refusal the destination is gone; on success
 * it holds the version folder the answer names.
 */
export async function readTemplateArchive(
  archive: string,
  destination: string,
  displayName = path.basename(archive),
): Promise<ReadTemplate> {
  // Never someone else's folder: the destination is created here, so a
  // refusal may remove it whole.
  await stat(destination).then(
    () => { throw new Error("The destination of a template archive must not exist yet."); },
    (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
  );
  try {
    const { size } = await stat(archive);
    if (size > TEMPLATE_ARCHIVE_MAX_BYTES) {
      refuse("template_archive_too_large", `The archive is ${megabytes(size)} MB; a template archive is at most ${megabytes(TEMPLATE_ARCHIVE_MAX_BYTES)} MB.`);
    }

    let listing: Awaited<ReturnType<typeof listArchive>>;
    try {
      listing = await listArchive(archive, displayName);
    } catch (error) {
      if (error instanceof ApiError) refuse("template_malformed", error.message);
      throw error;
    }
    if (listing.rejectedNames.length > 0) {
      refuse("template_entry_escapes", `The archive's member "${listing.rejectedNames[0]}" leaves its folder.`);
    }
    if (listing.entries.length === 0) refuse("template_malformed", "The archive holds nothing.");
    const roots = new Set(listing.entries.map((e) => e.name.split("/")[0]));
    const root = [...roots][0];
    if (roots.size !== 1 || !ROOT.test(root) || listing.entries.some((e) => e.name === root)) {
      refuse("template_malformed", "The archive must hold one folder named <name>.dezfil, as a project export does.");
    }
    // Two members landing on one file (or one file on a case-insensitive
    // disk) would let the second replace the first unseen.
    const seen = new Set<string>();
    for (const entry of listing.entries) {
      const key = entry.name.toLowerCase();
      if (seen.has(key)) refuse("template_malformed", `The archive holds "${entry.name}" twice.`);
      seen.add(key);
    }
    const unpackedBytes = expandedSize(listing.entries);
    const cap = limits.uploadMaxBytes;
    if (unpackedBytes > cap) {
      refuse("template_unpacked_too_large", `The archive unpacks to ${megabytes(unpackedBytes)} MB; this instance's upload cap is ${megabytes(cap)} MB.`);
    }

    await mkdir(destination, { recursive: true });
    try {
      await extractArchive(archive, destination, displayName, cap);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "archive_too_large") refuse("template_unpacked_too_large", error.message);
        refuse("template_malformed", error.message);
      }
      throw error;
    }
    // Only the one root can have landed, but the folder is read, not
    // trusted: anything beside it is a member nothing names.
    const landed = await readdir(destination);
    if (landed.length !== 1 || landed[0] !== root) {
      refuse("template_malformed", "The archive must hold one folder named <name>.dezfil, as a project export does.");
    }
    const folder = path.join(destination, root);
    const admitted = await admitTemplateFolder(folder);
    return { folder, admitted, archiveBytes: size, unpackedBytes };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
}

export { TemplateRefusal };
