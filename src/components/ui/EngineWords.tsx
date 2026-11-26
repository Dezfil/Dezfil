import { splitEngineWords } from "@/lib/query/engine-words";
import styles from "./EngineWords.module.css";

/** A failure message as the app says it, with the engine's own words,
 * when it carries any, in the code face: they are shown as the engine
 * wrote them. The app's sentence around them keeps the reading face. */
export function EngineWords({ text }: { text: string }) {
  const { lead, engine } = splitEngineWords(text);
  return (
    <>
      {lead}
      {engine === null ? null : <span className={styles.engine}>{engine}</span>}
    </>
  );
}
