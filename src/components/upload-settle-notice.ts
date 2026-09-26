import { withSkips } from "./skipped-members";
import type { SettleReport } from "./upload-queue";

/** One settled file batch, told as one notice:
 * outcomes named by file, because outside a closed host this text is the
 * only account. Extracted unchanged from the Data Explorer host so the
 * connection page tells the same story. */
export function uploadSettleNotice(report: SettleReport): {
  text: string | null;
  clean: boolean;
} {
  const clean =
    report.failed === 0 && report.unconfirmed === 0 && report.notStarted === 0;
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
    bits.push(
      report.failed === 1
        ? `${named("failed")} failed`
        : `${report.failed} files failed (${named("failed")})`,
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
  return { text, clean };
}
