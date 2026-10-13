"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useOperations } from "../builder/drawer/use-operations";
import gallery from "../gallery.module.css";
import { AttentionArea, type AttentionRowView } from "../projects/AttentionArea";
import { useSignedInLabel } from "../sharing/signed-in";
import { useInstanceName } from "../shell/path-model";
import { TemplateCopyDialog } from "../templates/TemplateCopyDialog";
import { templateAddress } from "../templates/template-model";
import { useTheme } from "../theme";
import { ErrorNote } from "../ui/ErrorNote";
import { useTransientNotice } from "../use-transient-notice";
import { homeView, type HomeRunRow } from "./home-model";
import { useHomeReads, useLeadHistory, useRereadAfterRun } from "./home-reads";
import { LeadPlace } from "./HomeLead";
import { HomeRecentSection } from "./HomeRecent";
import { HomeShelfSection } from "./HomeShelf";
import { HomeStart } from "./HomeStart";
import styles from "./Home.module.css";

/**
 * Home: the signed-in person's own page, read as them and stored nowhere.
 * Every part comes from Home's model over the reads' answers, so the page
 * shows what an agent calling the same reads would work out: the welcome,
 * then the lead beside Start (or Start alone in one row when nothing
 * leads), the rows to run again the person may run, Recent, and the
 * templates below.
 */
export function HomeScreen() {
  const router = useRouter();
  const label = useSignedInLabel();
  const instanceName = useInstanceName();
  const { reads, retry, reload } = useHomeReads();
  const { operations } = useOperations();
  const groupOf = useCallback(
    (operation: string) => operations?.find((o) => o.id === operation)?.group ?? null,
    [operations],
  );
  const opLabel = useCallback(
    (operation: string) => operations?.find((o) => o.id === operation)?.label ?? operation,
    [operations],
  );
  // A workflow example's tools are named once the operations are read.
  const labelOf = operations ? opLabel : null;
  const { theme } = useTheme();
  const view = useMemo(
    () => homeView(reads, { name: label?.name ?? null, sqlName: label?.sqlName ?? null }),
    [reads, label],
  );
  const { lead } = view;
  const history = useLeadHistory(lead.kind === "continue" && lead.item.kind === "workflow" ? lead.item.id : null);
  const { reload: reloadHistory } = history;

  // A run started from a row: the lists and the leading workflow's
  // history are read again after the run's notifications, once per turn.
  const rereadAfterRun = useCallback(async () => {
    reloadHistory();
    const landed = await Promise.all([reload.maps(), reload.workflows(), reload.tables()]);
    return landed.every(Boolean);
  }, [reload, reloadHistory]);
  const onRunChanged = useRereadAfterRun(rereadAfterRun);

  // The projects read's failure is said once: at Recent's head when Recent
  // stands, else on the first row it withholds Run from.
  const projectsFailure =
    reads.projects.status === "failed" ? { error: reads.projects.error, retry: retry.projects } : null;
  const headSaysIt = projectsFailure !== null && view.recent.state === "shown";
  const runRows = useMemo(
    () => runRowViews(view.runRows, retry.projects, headSaysIt),
    [view.runRows, retry.projects, headSaysIt],
  );
  const workflows = useMemo(
    () => (reads.workflows.status === "ready" ? [...reads.workflows.value] : []),
    [reads.workflows],
  );
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
          lastRun={history.lastRun}
          groupOf={groupOf}
          onRetry={() => {
            if (lead.kind === "failed") for (const read of lead.reads) retry[read]();
          }}
          onRetryHistory={history.retry}
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
      <AttentionArea rows={runRows} workflows={workflows} opLabel={opLabel} onChanged={onRunChanged} quiet />
      <HomeRecentSection
        recent={view.recent}
        instanceName={instanceName}
        groupOf={groupOf}
        projectsFailure={projectsFailure}
        retry={retry}
        announcedElsewhere={lead.kind === "failed" ? lead.reads[0] : null}
      />
      <HomeShelfSection
        shelf={view.shelf}
        theme={theme}
        groupOf={groupOf}
        labelOf={labelOf}
        onRetry={retry.templates}
        onOpen={(id) => router.push(templateAddress(id))}
        onCopy={setCopying}
      />
      {copying ? <TemplateCopyDialog key={copying} id={copying} onClose={() => setCopying(null)} /> : null}
    </div>
  );
}

/** The model's rows as the shared row draws them: Run withheld with the
 * pending line, or with the projects read's failure and its Try again,
 * announced on the first such row only when no note at Recent's head
 * says it. */
function runRowViews(rows: HomeRunRow[], retryProjects: () => void, headSaysIt: boolean): AttentionRowView[] {
  const first = rows.findIndex((row) => row.withheld?.status === "failed");
  return rows.map((row, i) => ({
    ...row,
    withheld:
      row.withheld === null
        ? null
        : row.withheld.status === "pending"
          ? { status: "pending" }
          : { status: "failed", error: row.withheld.error, retry: retryProjects, announce: !headSaysIt && i === first },
  }));
}
