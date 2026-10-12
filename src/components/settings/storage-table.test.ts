import { describe, expect, it } from "vitest";
import { STORAGE_KINDS } from "@/lib/system/storage-answer";
import { storageReadFixture } from "./read-fixture";
import { amountWords, cachesCleared, filesWords, FREE_ROW, freeWords, LEFTOVER_NOTE, shareOf, STORAGE_CARD, STORAGE_ROWS, TEMPLATES_NOTE } from "./storage-table";

/**
 * Storage's rows in words: each kind of file with its size, its share of
 * what the data folder holds and how many files, a kind the read did not
 * finish as at least what it counted, Free on the disk, and what Clear
 * all leaves. Nothing here names a file, a path or anyone's content: the
 * read has no place for one.
 */

const MIB = 1024 * 1024;

describe("the Storage rows' words", () => {
  it("lists the kinds in the read's order, each at its own address, then Free on the disk", () => {
    expect(STORAGE_CARD).toMatchObject({ id: "system-storage", title: "Storage" });
    expect(STORAGE_KINDS.map(kind => [STORAGE_ROWS[kind].id, STORAGE_ROWS[kind].label])).toEqual([
      ["sys-tables", "Tables"], ["sys-tiles", "Tile archives"], ["sys-caches", "Service caches"], ["sys-thumbnails", "Thumbnails"],
      ["sys-templates", "Templates"], ["sys-metadata-size", "Metadata database"], ["sys-leftovers", "Leftover files"], ["sys-other", "Other"],
    ]);
    expect([FREE_ROW.id, FREE_ROW.label]).toEqual(["sys-free", "Free on the disk"]);
  });

  it("notes Leftover files with what it holds and when it goes, Templates with what it counts, and no other row", () => {
    expect(LEFTOVER_NOTE).toBe("Includes work in progress. What is left goes at the next restart.");
    // More than the Templates card's Downloaded row: the query engine's
    // copies of the installed templates' data, shipped ones included.
    expect(TEMPLATES_NOTE).toBe("Counts the downloads and the query engine’s copies of installed templates’ data.");
    expect(STORAGE_KINDS.filter(kind => STORAGE_ROWS[kind].meta)).toEqual(["templates", "leftover_files"]);
    expect(STORAGE_ROWS.leftover_files.meta).toBe(LEFTOVER_NOTE);
    expect(STORAGE_ROWS.templates.meta).toBe(TEMPLATES_NOTE);
  });

  it("says a kind's size in the largest readable unit and its files, None for nothing", () => {
    expect(amountWords({ bytes: 12_698 * MIB, files: 412, finished: true })).toBe("12.4 GB");
    expect(amountWords({ bytes: 212 * MIB, files: 14, finished: true })).toBe("212 MB");
    expect(amountWords({ bytes: 40 * 1024, files: 2, finished: true })).toBe("40 KB");
    expect(amountWords({ bytes: 0, files: 0, finished: true })).toBe("None");
    // Empty files take no room, and are still files.
    expect(amountWords({ bytes: 0, files: 3, finished: true })).toBe("0 KB");
    expect(filesWords({ bytes: 212 * MIB, files: 1_412, finished: true })).toBe("1,412 files");
    expect(filesWords({ bytes: 40, files: 1, finished: true })).toBe("1 file");
    expect(filesWords({ bytes: 0, files: 0, finished: true })).toBe("");
  });

  it("gives a kind the walk did not finish as at least what it counted, and Not counted when it counted nothing", () => {
    expect(amountWords({ bytes: 12_698 * MIB, files: 412, finished: false })).toBe("At least 12.4 GB");
    expect(filesWords({ bytes: 12_698 * MIB, files: 412, finished: false })).toBe("At least 412 files");
    expect(filesWords({ bytes: 40, files: 1, finished: false })).toBe("At least 1 file");
    expect(amountWords({ bytes: 0, files: 0, finished: false })).toBe("Not counted");
    expect(filesWords({ bytes: 0, files: 0, finished: false })).toBe("");
  });

  it("gives a kind's share of what the data folder holds in whole percent", () => {
    const read = storageReadFixture();
    expect(STORAGE_KINDS.map(kind => shareOf(read.kinds[kind], read.total))).toEqual([78, 20, 0, 1, 0, 0, 1, 0]);
    expect(shareOf({ bytes: 0, files: 0, finished: true }, { bytes: 0, files: 0, finished: true })).toBe(0);
  });

  it("says the free space of the total on the disk, or Unknown when the system would not say", () => {
    expect(freeWords(storageReadFixture().disk)).toBe("182 GB of 250 GB");
    expect(freeWords(null)).toBe("Unknown");
  });

  it("leaves the caches empty after Clear all, the total what the other kinds hold and the disk as read", () => {
    const read = storageReadFixture({ tables: { bytes: 12_698 * MIB, files: 412, finished: false } });
    const after = cachesCleared(read);
    expect(after.kinds.service_caches).toEqual({ bytes: 0, files: 0, finished: true });
    expect(after.total).toEqual({ bytes: read.total.bytes - read.kinds.service_caches.bytes, files: read.total.files - 120, finished: false });
    expect(after.disk).toEqual(read.disk);
    for (const kind of STORAGE_KINDS.filter(kind => kind !== "service_caches")) expect(after.kinds[kind], kind).toEqual(read.kinds[kind]);
    // An unfinished count of the caches is gone with them.
    const unfinished = storageReadFixture({ service_caches: { bytes: 6 * MIB, files: 9, finished: false } });
    expect(cachesCleared(unfinished).total.finished).toBe(true);
  });
});
