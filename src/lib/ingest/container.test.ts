import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildZip } from "../../../test-support/zip";
import { ApiError } from "@/lib/api/errors";
import { expandedSize, extractArchive, listArchive } from "./container";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "dezfil-zip-"));
  delete process.env.DEZFIL_UPLOAD_MAX_MB;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.DEZFIL_UPLOAD_MAX_MB;
});

async function writeZip(
  name: string,
  members: Parameters<typeof buildZip>[0],
): Promise<string> {
  const zipPath = path.join(dir, name);
  await writeFile(zipPath, buildZip(members));
  return zipPath;
}

describe("listArchive", () => {
  it("reads names and sizes from the central directory", async () => {
    const zipPath = await writeZip("a.zip", [
      { name: "roads.shp", data: Buffer.alloc(300, 7) },
      { name: "nested/roads.dbf", data: "attributes", method: 0 },
    ]);
    const { entries, rejectedNames } = await listArchive(zipPath, "a.zip");
    expect(entries.map((e) => e.name)).toEqual([
      "roads.shp",
      "nested/roads.dbf",
    ]);
    expect(entries[0].uncompressedSize).toBe(300);
    expect(entries[1].method).toBe(0);
    expect(rejectedNames).toEqual([]);
    expect(expandedSize(entries)).toBe(300 + "attributes".length);
  });

  it("skips directory entries and records hostile names", async () => {
    const zipPath = await writeZip("b.zip", [
      { name: "folder/", data: "" },
      { name: "../escape.txt", data: "evil" },
      { name: "a/../../escape2.txt", data: "evil" },
      { name: "C:\\windows\\evil.txt", data: "evil" },
      { name: "ok.txt", data: "fine" },
    ]);
    const { entries, rejectedNames } = await listArchive(zipPath, "b.zip");
    expect(entries.map((e) => e.name)).toEqual(["ok.txt"]);
    expect(rejectedNames).toHaveLength(3);
  });

  it("refuses non-zip bytes as malformed", async () => {
    const notZip = path.join(dir, "not.zip");
    await writeFile(notZip, Buffer.alloc(100, 1));
    await expect(listArchive(notZip, "not.zip")).rejects.toMatchObject({
      code: "malformed_file",
    });
  });

  it("refuses a truncated archive as malformed", async () => {
    const whole = buildZip([{ name: "x.shp", data: Buffer.alloc(5000, 3) }]);
    const cut = path.join(dir, "cut.zip");
    // Keep the tail (EOCD survives) but cut the front where data lives.
    await writeFile(cut, whole.subarray(2000));
    await expect(
      extractArchive(cut, path.join(dir, "out"), "cut.zip"),
    ).rejects.toMatchObject({ code: "malformed_file" });
  });

  it("refuses encrypted entries as malformed", async () => {
    const zipPath = await writeZip("enc.zip", [
      { name: "secret.shp", data: "data", flags: 0x1 },
    ]);
    await expect(listArchive(zipPath, "enc.zip")).rejects.toMatchObject({
      code: "malformed_file",
    });
  });
});

describe("extractArchive", () => {
  it("round-trips deflated, stored, empty, and nested members", async () => {
    const big = Buffer.alloc(100_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const zipPath = await writeZip("mix.zip", [
      { name: "roads.shp", data: big },
      { name: "roads.dbf", data: "stored bytes", method: 0 },
      { name: "empty.cpg", data: "" },
      { name: "sub/dir/readme.txt", data: "hello" },
    ]);
    const out = path.join(dir, "out");
    const { files } = await extractArchive(zipPath, out, "mix.zip");
    expect(files).toEqual([
      "roads.shp",
      "roads.dbf",
      "empty.cpg",
      "sub/dir/readme.txt",
    ]);
    expect(await readFile(path.join(out, "roads.shp"))).toEqual(big);
    expect(await readFile(path.join(out, "roads.dbf"), "utf8")).toBe(
      "stored bytes",
    );
    expect((await readFile(path.join(out, "empty.cpg"))).length).toBe(0);
    expect(await readFile(path.join(out, "sub/dir/readme.txt"), "utf8")).toBe(
      "hello",
    );
  });

  it("refuses an over-cap declared expansion before extracting anything", async () => {
    process.env.DEZFIL_UPLOAD_MAX_MB = "1";
    const zipPath = await writeZip("bomb.zip", [
      { name: "zeros.shp", data: Buffer.alloc(2 * 1024 * 1024) },
    ]);
    const out = path.join(dir, "out");
    const error = await extractArchive(zipPath, out, "bomb.zip").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("archive_too_large");
    expect((error as ApiError).status).toBe(413);
    // Nothing was written — the refusal happened before extraction.
    expect(existsSync(out)).toBe(false);
  });

  it("cuts off an entry that inflates beyond its declared size", async () => {
    // Declares 10 bytes but inflates to 100k — the lying-header bomb.
    const zipPath = await writeZip("liar.zip", [
      {
        name: "liar.shp",
        data: Buffer.alloc(100_000, 9),
        declaredUncompressedSize: 10,
      },
    ]);
    await expect(
      extractArchive(zipPath, path.join(dir, "out"), "liar.zip"),
    ).rejects.toMatchObject({ code: "malformed_file" });
  });

  // Cross-validation against an archive this repo's own writer did not
  // produce: Info-ZIP, where installed (dev machines, CI runners); a
  // visible skip elsewhere — the test-support writer shares no code with
  // the reader's parser, but a second producer is still worth the check.
  it("extracts an Info-ZIP-produced archive byte-for-byte", async (ctx) => {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("zip", ["-v"], { stdio: "ignore" });
    } catch {
      ctx.skip(); // zip CLI not installed — cross-check skipped, visibly
      return;
    }
    const src = path.join(dir, "src");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(path.join(src, "sub"), { recursive: true }),
    );
    const payload = Buffer.alloc(50_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 256;
    await writeFile(path.join(src, "roads.shp"), payload);
    await writeFile(path.join(src, "sub", "roads.dbf"), "attributes");
    execFileSync("zip", ["-q", "-r", path.join(dir, "real.zip"), "."], {
      cwd: src,
    });
    const out = path.join(dir, "real-out");
    const { files } = await extractArchive(
      path.join(dir, "real.zip"),
      out,
      "real.zip",
    );
    expect(files.sort()).toEqual(["roads.shp", "sub/roads.dbf"]);
    expect(await readFile(path.join(out, "roads.shp"))).toEqual(payload);
    expect(await readFile(path.join(out, "sub/roads.dbf"), "utf8")).toBe(
      "attributes",
    );
  });

  it("refuses a member corrupted in place — CRC mismatch, directory intact", async () => {
    // A stored member's bytes flip after the archive was written; the
    // central directory still declares the original CRC: altered
    // attributes must refuse, not land.
    const payload = Buffer.from("attribute bytes that must stay intact");
    const zip = buildZip([
      { name: "roads.dbf", data: payload, method: 0 },
      { name: "roads.shp", data: Buffer.alloc(64, 5) },
    ]);
    const index = zip.indexOf(payload);
    expect(index).toBeGreaterThan(0);
    zip[index + 4] ^= 0xff; // flip one payload byte, nothing else
    const zipPath = path.join(dir, "flipped.zip");
    await writeFile(zipPath, zip);
    await expect(
      extractArchive(zipPath, path.join(dir, "out"), "flipped.zip"),
    ).rejects.toMatchObject({
      code: "malformed_file",
      message: expect.stringContaining("CRC-32"),
    });
  });

  it("refuses an archive whose members try to escape — nothing extracts", async () => {
    // silently dropping a hostile member could lose a
    // sidecar as easily as block an attack — the archive refuses whole.
    const zipPath = await writeZip("esc.zip", [
      { name: "../outside.txt", data: "evil" },
      { name: "inside.txt", data: "fine" },
    ]);
    const out = path.join(dir, "out");
    await expect(extractArchive(zipPath, out, "esc.zip")).rejects.toMatchObject(
      { code: "malformed_file", message: expect.stringContaining("hostile") },
    );
    expect(existsSync(path.join(dir, "outside.txt"))).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("finds the real end record when the archive comment embeds its signature", async () => {
    // signature bytes inside the comment, with 22+
    // bytes after them, must not shadow the real record.
    const decoy = Buffer.concat([
      Buffer.from("prefix "),
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      Buffer.alloc(30, 0x41),
    ]);
    const zipPath = path.join(dir, "commented.zip");
    await writeFile(
      zipPath,
      buildZip([{ name: "roads.shp", data: "real content" }], {
        comment: decoy,
      }),
    );
    const out = path.join(dir, "out");
    const { files } = await extractArchive(zipPath, out, "commented.zip");
    expect(files).toEqual(["roads.shp"]);
    expect(await readFile(path.join(out, "roads.shp"), "utf8")).toBe(
      "real content",
    );
  });

  it("refuses a truncated ZIP64 extra field as malformed, not a crash", async () => {
    // Sizes carry the ZIP64 sentinel but the 0x0001 extra holds only
    // four bytes — the read must refuse, never throw a range error.
    const shortExtra = Buffer.alloc(8);
    shortExtra.writeUInt16LE(0x0001, 0);
    shortExtra.writeUInt16LE(4, 2);
    shortExtra.writeUInt32LE(99, 4);
    const zipPath = await writeZip("z64cut.zip", [
      {
        name: "roads.shp",
        data: "bytes",
        declaredUncompressedSize: 0xffffffff,
        centralExtra: shortExtra,
      },
    ]);
    await expect(
      extractArchive(zipPath, path.join(dir, "out"), "z64cut.zip"),
    ).rejects.toMatchObject({
      code: "malformed_file",
      message: expect.stringContaining("ZIP64"),
    });
  });
});
