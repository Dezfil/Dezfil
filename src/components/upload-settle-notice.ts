import { withSkips } from "./skipped-members";
import type { SettleReport } from "./upload-queue";
import type { NoticeTone } from "./use-transient-notice";

/** A settled batch's outcome: a batch that landed whole is a success, one
 * where nothing landed and a file failed is a failure, and anything between
 * (some landed, an answer lost, files stopped) is a warning. */
export function settleTone(report: SettleReport): NoticeTone {
  if (report.failed === 0 && report.unconfirmed === 0 && report.notStarted === 0) return "ok";
  return report.failed > 0 && report.imported === 0 && report.unconfirmed === 0 ? "danger" : "warn";
}

/** The batch's failed files in one clause, or null when none failed. A lone
 * failure carries its file's own refusal: the dialog showed it, and once the
 * dialog is closed this is the only place left to say it. */
export function failedFilesClause(report: SettleReport): string | null {
  const failed = report.entries.filter((e) => e.state === "failed");
  if (report.failed === 0) return null;
  if (report.failed > 1) {
    return `${report.failed} files could not be imported (${failed.map((e) => e.name).join(", ")})`;
  }
  const reason = failed[0]?.error?.trim().replace(/\.$/, "");
  return `${failed.map((e) => e.name).join(", ")} could not be imported${reason ? `: ${reason}` : ""}`;
}

/** One settled file batch, told as one notice:
 * outcomes named by file, because outside a closed host this text is the
 * only account. Extracted unchanged from the Data Explorer host so the
 * connection page tells the same story, in the tone of its outcome. */
export function uploadSettleNotice(report: SettleReport): {
  text: string | null;
  clean: boolean;
  tone: NoticeTone;
} {
  const tone = settleTone(report);
  const clean = tone === "ok";
  const bits: string[] = [];
  if (report.tables.length === 1 && report.files === 1) {
    bits.push(`${report.tables[0].name} is ready.`);
  } else if (report.tables.length > 0) {
    bits.push(
      report.tables.length === 1
        ? "1 table ready."
        : `${report.tables.length} tables ready.`,
    );
  }
  const named = (state: string) =>
    report.entries
      .filter((e) => e.state === state)
      .map((e) => e.name)
      .join(", ");
  const failed = failedFilesClause(report);
  if (failed !== null) bits.push(failed);
  if (report.unconfirmed > 0) {
    bits.push(`${named("unconfirmed")} unconfirmed, check the listing`);
  }
  if (report.notStarted > 0) {
    bits.push(`${report.notStarted} not started`);
  }
  const text = withSkips(
    bits.join(" · "),
    report.skips.length
      ? report.skips.map(({ source, layer, reason }) => ({
          layer: `${source}: ${layer}`,
          reason,
        }))
      : null,
  );
  return { text, clean, tone };
}
