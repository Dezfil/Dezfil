import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { crc32, createInflateRaw } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import { limits } from "@/lib/limits";

/**
 * Zip container handling for the container formats: Shapefile zips
 * and.kmz. Read-only, hand-rolled on the zip spec rather than a
 * dependency, because the safety properties are the point: entry names are
 * sanitized, extraction is confined to the destination directory, and the
 * expanded-size bound is enforced from the archive's own central directory
 * *before* any byte is inflated — a zip bomb is refused unextracted. An
 * entry that inflates past its declared size is cut off mid-stream, so a
 * lying header cannot get past the bound either.
 */

/** Ceilings against hostile directories, far above any real shapefile zip:
 * a central directory bigger than this (or holding more entries) is
 * refused before it is parsed, so it can never be inflated into memory. */
const MAX_ENTRIES = 10_000;
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export interface ArchiveEntry {
  /** Entry path inside the archive, forward-slash separated, sanitized. */
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate — anything else refuses as malformed. */
  method: number;
  localHeaderOffset: number;
  /** CRC-32 from the central directory — verified against the extracted
   * bytes, so a member corrupted in place refuses instead of landing
   * altered data. */
  crc32: number;
}

function malformed(filename: string, detail: string): ApiError {
  return new ApiError(
    "malformed_file",
    `The file could not be read as a zip archive ("${filename}"): ${detail}`,
    422,
  );
}

/** Reject path tricks; return the safe relative path or null for entries
 * that produce no file (directories, empty names). */
function sanitizeEntryName(raw: string): string | null {
  if (raw.includes("\0")) return null;
  // Old Windows tools wrote backslash separators.
  const segments = raw.replace(/\\/g, "/").split("/");
  if (segments[segments.length - 1] === "") return null; // directory entry
  const safe: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." || segment.includes(":")) return null;
    safe.push(segment);
  }
  return safe.length > 0 ? safe.join("/") : null;
}

interface Directory {
  entries: ArchiveEntry[];
  /** Entries whose names failed sanitization — listed so callers can refuse
   * archives that try to escape rather than silently dropping members. */
  rejectedNames: string[];
}

/** Parse the end-of-central-directory record (with ZIP64 forms) and the
 * central directory. Sizes come from here — authoritative even for entries
 * written with data descriptors. */
export async function listArchive(
  zipPath: string,
  displayName: string,
): Promise<Directory> {
  const { size: fileSize } = await stat(zipPath);
  if (fileSize < 22) throw malformed(displayName, "too small to be a zip");

  const handle = await open(zipPath, "r");
  try {
    const tailLength = Math.min(fileSize, 22 + 65_535 + 20);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, fileSize - tailLength);

    // A candidate signature only counts when its declared comment length
    // reaches exactly to end-of-file — otherwise signature bytes embedded
    // in a real record's comment would shadow the record itself (review
    // round two).
    let eocdInTail = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
      const commentLength = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLength === tailLength) {
        eocdInTail = i;
        break;
      }
    }
    if (eocdInTail < 0) {
      throw malformed(displayName, "no end-of-central-directory record");
    }

    let entryCount: number = tail.readUInt16LE(eocdInTail + 10);
    let directorySize: number = tail.readUInt32LE(eocdInTail + 12);
    let directoryOffset: number = tail.readUInt32LE(eocdInTail + 16);

    const needsZip64 =
      entryCount === 0xffff ||
      directorySize === 0xffffffff ||
      directoryOffset === 0xffffffff;
    if (needsZip64) {
      const eocdPos = fileSize - tailLength + eocdInTail;
      const locator = Buffer.alloc(20);
      if (eocdPos < 20) throw malformed(displayName, "truncated ZIP64 record");
      await handle.read(locator, 0, 20, eocdPos - 20);
      if (locator.readUInt32LE(0) !== EOCD64_LOCATOR_SIG) {
        throw malformed(displayName, "missing ZIP64 locator");
      }
      const eocd64Pos = Number(locator.readBigUInt64LE(8));
      const eocd64 = Buffer.alloc(56);
      await handle.read(eocd64, 0, 56, eocd64Pos);
      if (eocd64.readUInt32LE(0) !== EOCD64_SIG) {
        throw malformed(displayName, "missing ZIP64 end record");
      }
      entryCount = Number(eocd64.readBigUInt64LE(32));
      directorySize = Number(eocd64.readBigUInt64LE(40));
      directoryOffset = Number(eocd64.readBigUInt64LE(48));
    }

    if (entryCount > MAX_ENTRIES) {
      throw malformed(displayName, `more than ${MAX_ENTRIES} entries`);
    }
    if (
      directorySize > MAX_DIRECTORY_BYTES ||
      directoryOffset + directorySize > fileSize
    ) {
      throw malformed(displayName, "central directory out of bounds");
    }

    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);

    const entries: ArchiveEntry[] = [];
    const rejectedNames: string[] = [];
    let cursor = 0;
    for (let i = 0; i < entryCount; i++) {
      if (cursor + 46 > directorySize) {
        throw malformed(displayName, "truncated central directory");
      }
      if (directory.readUInt32LE(cursor) !== CENTRAL_SIG) {
        throw malformed(displayName, "bad central directory signature");
      }
      const flags = directory.readUInt16LE(cursor + 8);
      const method = directory.readUInt16LE(cursor + 10);
      const entryCrc = directory.readUInt32LE(cursor + 16);
      let compressedSize: number = directory.readUInt32LE(cursor + 20);
      let uncompressedSize: number = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      let localHeaderOffset: number = directory.readUInt32LE(cursor + 42);
      const rawName = directory
        .subarray(cursor + 46, cursor + 46 + nameLength)
        .toString("utf8");

      // ZIP64 extended field: only the masked values are present, in order.
      if (
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      ) {
        const extra = directory.subarray(
          cursor + 46 + nameLength,
          cursor + 46 + nameLength + extraLength,
        );
        let p = 0;
        let found = false;
        while (p + 4 <= extra.length) {
          const id = extra.readUInt16LE(p);
          const size = extra.readUInt16LE(p + 2);
          if (id === 0x0001) {
            const end = Math.min(p + 4 + size, extra.length);
            let q = p + 4;
            // Each needed value must actually fit inside the field — a
            // truncated ZIP64 extra refuses as malformed rather than
            // throwing a range error into a 500.
            const take = (): number => {
              if (q + 8 > end) {
                throw malformed(displayName, "truncated ZIP64 entry sizes");
              }
              const value = Number(extra.readBigUInt64LE(q));
              q += 8;
              return value;
            };
            if (uncompressedSize === 0xffffffff) uncompressedSize = take();
            if (compressedSize === 0xffffffff) compressedSize = take();
            if (localHeaderOffset === 0xffffffff) localHeaderOffset = take();
            found = true;
            break;
          }
          p += 4 + size;
        }
        if (!found) throw malformed(displayName, "missing ZIP64 entry sizes");
      }

      cursor += 46 + nameLength + extraLength + commentLength;

      if (flags & 0x1) {
        throw malformed(displayName, "encrypted entries are not supported");
      }
      const name = sanitizeEntryName(rawName);
      if (name === null) {
        // Directory entries are normal; hostile names are recorded.
        if (!rawName.endsWith("/") && rawName !== "") {
          rejectedNames.push(rawName);
        }
        continue;
      }
      if (method !== 0 && method !== 8) {
        throw malformed(
          displayName,
          `entry "${name}" uses an unsupported compression method`,
        );
      }
      entries.push({
        name,
        compressedSize,
        uncompressedSize,
        method,
        localHeaderOffset,
        crc32: entryCrc,
      });
    }
    return { entries, rejectedNames };
  } finally {
    await handle.close();
  }
}

/** The declared expanded size of the whole archive. */
export function expandedSize(entries: ArchiveEntry[]): number {
  return entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
}

/** A transform that verifies the extracted bytes against the central
 * directory: fails once more bytes pass than declared (the lying-header
 * half of the bomb guard), and at the end fails on a short stream or a
 * CRC-32 mismatch — a member corrupted in place without touching the
 * directory refuses instead of landing altered data. */
function verifyingCounter(
  entry: ArchiveEntry,
  onBad: (detail: string) => Error,
): Transform {
  let seen = 0;
  let crc = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > entry.uncompressedSize) {
        cb(onBad("inflates beyond its declared size"));
        return;
      }
      crc = crc32(chunk, crc);
      cb(null, chunk);
    },
    flush(cb) {
      if (seen !== entry.uncompressedSize) {
        cb(onBad("is shorter than its declared size"));
      } else if ((crc >>> 0) !== (entry.crc32 >>> 0)) {
        cb(onBad("failed its CRC-32 check"));
      } else {
        cb();
      }
    },
  });
}

export interface ExtractedArchive {
  /** Extracted file paths relative to the destination directory. */
  files: string[];
}

/**
 * Extract an archive into a directory the caller owns (inside the ingest
 * scratch area). The expanded-size cap — the upload cap, — is checked
 * against the declared sizes before extraction begins.
 */
export async function extractArchive(
  zipPath: string,
  destDir: string,
  displayName: string,
): Promise<ExtractedArchive> {
  const { entries, rejectedNames } = await listArchive(zipPath, displayName);
  // An archive carrying members that try to escape is refused whole —
  // silently dropping a member could as easily lose a sidecar as block
  // an attack.
  if (rejectedNames.length > 0) {
    throw malformed(
      displayName,
      `entry "${rejectedNames[0]}" has a hostile or unusable path`,
    );
  }
  const cap = limits.uploadMaxBytes;
  const declared = expandedSize(entries);
  if (declared > cap) {
    throw new ApiError(
      "archive_too_large",
      `The archive "${displayName}" unpacks to ${Math.round(
        declared / (1024 * 1024),
      )} MB; the cap is ${Math.round(cap / (1024 * 1024))} MB. Raise DEZFIL_UPLOAD_MAX_MB to change it.`,
      413,
    );
  }

  await mkdir(destDir, { recursive: true });
  const files: string[] = [];
  const handle = await open(zipPath, "r");
  try {
    for (const entry of entries) {
      // The local header's own name/extra lengths decide where data starts.
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, entry.localHeaderOffset);
      if (local.readUInt32LE(0) !== LOCAL_SIG) {
        throw malformed(displayName, `bad local header for "${entry.name}"`);
      }
      const dataStart =
        entry.localHeaderOffset +
        30 +
        local.readUInt16LE(26) +
        local.readUInt16LE(28);

      const target = path.join(destDir, entry.name);
      if (!path.resolve(target).startsWith(path.resolve(destDir) + path.sep)) {
        throw malformed(displayName, `entry "${entry.name}" escapes the archive`);
      }
      await mkdir(path.dirname(target), { recursive: true });

      if (entry.compressedSize === 0) {
        if (entry.uncompressedSize !== 0) {
          throw malformed(
            displayName,
            `entry "${entry.name}" declares content but stores none`,
          );
        }
        await pipeline([], createWriteStream(target));
        files.push(entry.name);
        continue;
      }
      const compressed = createReadStream(zipPath, {
        start: dataStart,
        end: dataStart + entry.compressedSize - 1,
      });
      const verifier = verifyingCounter(entry, (detail) =>
        malformed(displayName, `entry "${entry.name}" ${detail}`),
      );
      if (entry.method === 8) {
        await pipeline(
          compressed,
          createInflateRaw(),
          verifier,
          createWriteStream(target),
        );
      } else {
        if (entry.compressedSize !== entry.uncompressedSize) {
          throw malformed(
            displayName,
            `entry "${entry.name}" has inconsistent stored sizes`,
          );
        }
        await pipeline(compressed, verifier, createWriteStream(target));
      }
      files.push(entry.name);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw malformed(
      displayName,
      error instanceof Error ? error.message : "unreadable archive",
    );
  } finally {
    await handle.close();
  }
  return { files };
}
