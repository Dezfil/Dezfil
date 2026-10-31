"use client";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { useInstanceRead } from "./instance-read";
import { RuleCardView } from "./RuleCard";
import { SECURITY_CARDS } from "./security-table";
import { useDrawn } from "./settings-land";
import { SignEveryoneOutCard } from "./SignEveryoneOutCard";
import cardStyles from "./SettingsCard.module.css";

/** Security: how long sign-ins and links last, when failed sign-ins pause,
 * the shortest password, who may create API tokens and how long a new one
 * lasts, as the configuration read reports them. Each choice is kept as it
 * is made and each count when it is entered; a save signs no one out and
 * changes no token or link already made. Below them, Sign everyone out does. */
export function SecurityTab() {
  const { read, error, retry } = useInstanceRead();
  useDrawn(!!read);
  if (error) return <ErrorNote message={error} onRetry={retry} />;
  if (!read) return <p role="status" className={cardStyles.loading}>Loading settings…</p>;
  return <>{SECURITY_CARDS.map(card => <RuleCardView key={card.id} card={card} settings={read.settings} />)}<SignEveryoneOutCard /></>;
}
