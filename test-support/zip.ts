import { deflateRawSync, crc32 } from "node:zlib";

/**
 * Minimal zip writer for test fixtures (0063). Writes spec-correct
 * archives — real CRCs, real central directory — plus knobs for the
 * hostile shapes the container module must refuse: lying size fields,
 * path-traversal names, encryption flags. Test-support only; the product
 * never writes zips.
 */

export interface ZipMember {
  name: string;
  data: Buffer | string;
  /** 0 = stored, 8 = deflate (default). */
  method?: 0 | 8;
  /** Override the declared uncompressed size (bomb-with-lying-header). */
  declaredUncompressedSize?: number;
  /** Override the general-purpose flags (bit 0 marks encryption). */
  flags?: number;
  /** Raw central-directory extra field bytes (hostile ZIP64 shapes). */
  centralExtra?: Buffer;
}

export interface ZipOptions {
  /** Archive comment appended after the end record. */
  comment?: Buffer | string;
}

export function buildZip(members: ZipMember[], options: ZipOptions = {}): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const data =
      typeof member.data === "string"
        ? Buffer.from(member.data, "utf8")
        : member.data;
    const method = member.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const name = Buffer.from(member.name, "utf8");
    const uncompressedSize = member.declaredUncompressedSize ?? data.length;
    const flags = member.flags ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const extra = member.centralExtra ?? Buffer.alloc(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12); // time/date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, compressed);
    centralParts.push(central, name, extra);
    offset += 30 + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const comment =
    typeof options.comment === "string"
      ? Buffer.from(options.comment, "utf8")
      : (options.comment ?? Buffer.alloc(0));
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd, comment]);
}
