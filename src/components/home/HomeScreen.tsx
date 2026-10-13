"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useOperations } from "../builder/drawer/use-operations";
import gallery from "../gallery.module.css";
import { useSignedInLabel } from "../sharing/signed-in";
import { TemplateCopyDialog } from "../templates/TemplateCopyDialog";
import { templateAddress } from "../templates/template-model";
import { ErrorNote } from "../ui/ErrorNote";
import { useTransientNotice } from "../use-transient-notice";
import { homeView } from "./home-model";
import { useHomeReads, useLeadHistory } from "./home-reads";
import { LeadPlace } from "./HomeLead";
import { HomeStart } from "./HomeStart";
import styles from "./Home.module.css";

/**
 * Home: the signed-in person's own page, read as them and stored nowhere.
 * Every part comes from Home's model over the reads' answers, so the page
 * shows what an agent calling the same reads would work out: the welcome,
 * then the lead beside Start, or Start alone in one row when nothing
 * leads.
 */
export function HomeScreen() {
  const router = useRouter();
  const label = useSignedInLabel();
  const { reads, retry, reload } = useHomeReads();
  const { operations } = useOperations();
  const groupOf = useCallback(
    (operation: string) => operations?.find((o) => o.id === operation)?.group ?? null,
    [operations],
  );
  const view = useMemo(
    () => homeView(reads, { name: label?.name ?? null, sqlName: label?.sqlName ?? null }),
    [reads, label],
  );
  const { lead } = view;
  const lastRun = useLeadHistory(lead.kind === "continue" && lead.item.kind === "workflow" ? lead.item.id : null);
  const { notice, show: showNotice } = useTransientNotice();
  const [actionError, setActionError] = useState<string | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  // Beside a lead, or one still being worked out, Start stands two by two;
  // with no lead at all, in one row under the welcome.
  const form = lead.kind === "none" ? "row" : "pair";

  return (
    <div className={styles.screen} data-home>
      <h1 className={styles.welcome} data-welcome>
        {view.welcome}
      </h1>
      {actionError && <ErrorNote message={actionError} onDismiss={() => setActionError(null)} />}
      {notice && (
        <div className={gallery.notice} role="status">
          {notice}
        </div>
      )}
      <div className={styles.leadRow} data-form={form} data-beside={lead.kind}>
        <LeadPlace
          lead={lead}
          lastRun={lastRun}
          groupOf={groupOf}
          onRetry={() => {
            if (lead.kind === "failed") for (const read of lead.reads) retry[read]();
          }}
          onOpenTemplate={(id) => router.push(templateAddress(id))}
          onCopyTemplate={setCopying}
        />
        <HomeStart
          heading={lead.kind === "template" ? "Or start your own" : "Start"}
          form={form}
          onDatasetsChanged={reload.tables}
          onNotice={showNotice}
          onError={setActionError}
        />
      </div>
      {copying ? <TemplateCopyDialog key={copying} id={copying} onClose={() => setCopying(null)} /> : null}
    </div>
  );
}
