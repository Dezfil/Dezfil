import { describe, expect, it } from "vitest";
import type { DataTable } from "./api";
import type { SettleReport, UploadEntry } from "./upload-queue";
import { uploadSettleNotice } from "./upload-settle-notice";

const entry = (name: string, state: UploadEntry["state"], error: string | null = null): UploadEntry =>
  ({ id: 0, name, state, progress: 1, error });
const table = (name: string) => ({ name }) as DataTable;
function report(entries: UploadEntry[], tables: DataTable[] = []): SettleReport {
  const count = (state: UploadEntry["state"]) => entries.filter((e) => e.state === state).length;
  return {
    files: entries.length, imported: count("imported"), failed: count("failed"), unconfirmed: count("unconfirmed"),
    notStarted: count("not-started"), entries, tables, skips: [], dismissed: false, batch: 1,
  };
}

describe("a settled upload batch, told as one notice in the look of its outcome", () => {
  it("an all-done batch takes the success look", () => {
    expect(uploadSettleNotice(report([entry("wells.csv", "imported")], [table("wells")]))).toEqual({ text: "wells is ready.", clean: true, tone: "ok" });
    expect(uploadSettleNotice(report([entry("a.csv", "imported"), entry("b.csv", "imported")], [table("a"), table("b")])).tone).toBe("ok");
  });

  it("an all-failed batch takes the failure look and says what failed, a lone file with its reason", () => {
    expect(uploadSettleNotice(report([entry("roads.csv", "failed", "The file is empty.")]))).toEqual({
      text: "roads.csv could not be imported: The file is empty", clean: false, tone: "danger",
    });
    expect(uploadSettleNotice(report([entry("roads.csv", "failed", "The file is empty."), entry("rivers.csv", "failed", "No rows.")]))).toEqual({
      text: "2 files could not be imported (roads.csv, rivers.csv)", clean: false, tone: "danger",
    });
    // Nothing landed: a failure, even beside files the person stopped.
    expect(uploadSettleNotice(report([entry("roads.csv", "failed", null), entry("rivers.csv", "not-started")])).tone).toBe("danger");
  });

  it("a batch with some files done and some failed takes the warning look and says both", () => {
    expect(uploadSettleNotice(report([entry("wells.csv", "imported"), entry("roads.csv", "failed", "The file is empty.")], [table("wells")]))).toEqual({
      text: "1 table ready. · roads.csv could not be imported: The file is empty", clean: false, tone: "warn",
    });
  });

  it("a file whose answer was lost is a warning, never a failure or a success", () => {
    expect(uploadSettleNotice(report([entry("rivers.zip", "unconfirmed", "The answer was lost.")])).tone).toBe("warn");
    expect(uploadSettleNotice(report([entry("roads.csv", "failed", "No rows."), entry("rivers.zip", "unconfirmed", "Lost.")])).tone).toBe("warn");
  });
});
