import { withSkips } from "./skipped-members";
import type { SettleReport } from "./upload-queue";
import type { NoticeTone } from "./use-transient-notice";

/** One settled file batch, told as one notice:
 * outcomes named by file, because outside a closed host this text is the
 * only account. Extracted unchanged from the Data Explorer host so the
 * connection page tells the same story.
 *
 * The tone is the batch's outcome: a batch that landed whole is a
 * success, one where nothing landed and a file failed is a failure, and
 * anything between (some landed, an answer lost, files stopped) is a
 * warning. */
export function uploadSettleNotice(report: SettleReport): {
  text: string | null;
  clean: boolean;
  tone: NoticeTone;
} {
  const clean =
    report.failed === 0 && report.unconfirmed === 0 && report.notStarted === 0;
  const tone: NoticeTone = clean
    ? "ok"
    : report.failed > 0 && report.imported === 0 && report.unconfirmed === 0
      ? "danger"
      : "warn";
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
  if (report.failed > 0) {
    // A lone failure carries its file's own refusal: the dialog showed it,
    // and once the dialog is closed this is the only place left to say it.
    const reason = report.entries.find((e) => e.state === "failed")?.error?.trim().replace(/\.$/, "");
    bits.push(
      report.failed === 1
        ? `${named("failed")} could not be imported${reason ? `: ${reason}` : ""}`
        : `${report.failed} files could not be imported (${named("failed")})`,
    );
  }
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
