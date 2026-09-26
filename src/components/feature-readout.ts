import type { TableFeaturesResult } from "@/lib/table-service";
import { formatCount } from "./api";

/**
 * The count sentence of a features readout, in the words the read
 * warrants: a sampled read draws the first cap-many features while its
 * total counts the table's rows, geometry or none, so the sentence says
 * features drawn, of rows. The results band, the Data Explorer's
 * preview and the SQL workspace's table preview share it, so the three
 * cannot drift apart again.
 */
export function featureCountReadout(r: Pick<TableFeaturesResult, "featureCount" | "sampled" | "totalCount">): string {
  const drawn = formatCount(r.featureCount ?? 0);
  return r.sampled ? `${drawn} features drawn, of ${formatCount(r.totalCount ?? 0)} rows` : `${drawn} features`;
}
