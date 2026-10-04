import type { DeletionPreview } from "./deletion-client";
import { IconMap, IconData, IconWorkflow, IconFolder, IconLink } from "../gallery-icons";
import { PlugIcon } from "../ui/icons";
import home from "../projects/ProjectHome.module.css";
import styles from "./DeleteAccountDialog.module.css";

const kinds = [
  ["maps", "map", IconMap], ["datasets", "dataset", IconData], ["workflows", "workflow", IconWorkflow],
  ["projects", "project", IconFolder], ["connections", "connection", PlugIcon], ["publishedLinks", "published link", IconLink],
] as const;
export function DeletionTotals({ totals }: { totals: DeletionPreview["totals"] }) {
  return <div className={`${home.stats} ${styles.totals}`} data-deletion-totals>
    {kinds.filter(([key]) => totals[key] > 0).map(([key, word, Icon], index) => <span className={home.factWrap} key={key}>
      {index > 0 && <i aria-hidden />}<span><span className={home.factGlyph}><Icon /></span>
        <b>{totals[key]}</b>{` ${word}${totals[key] === 1 ? "" : "s"}`}</span>
    </span>)}
  </div>;
}
