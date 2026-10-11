"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { TemplateList } from "@/lib/templates/card";
import { readApiError } from "../api";
import { useOperations } from "../builder/drawer/use-operations";
import { serverUnreachable } from "../failure-copy";
import gallery from "../gallery.module.css";
import { ListHeading } from "../ListHeading";
import { useTheme } from "../theme";
import { AsyncState, useAsync } from "../ui/AsyncState";
import { InfoIcon } from "../ui/icons";
import { TemplateCard } from "./TemplateCard";
import styles from "./Templates.module.css";
import { catalogueLine, READING_LINE, refreshes, templateAddress } from "./template-model";

/**
 * The Templates page: one card per template, in the list's order (the
 * shipped ones first, then the catalogue's), maps and workflow examples
 * in one grid. The page draws from what the server holds at once and asks
 * it to read the catalogue after, so it never waits on the catalogue;
 * while the catalogue lists nothing here, one line says why.
 */

async function readTemplates(): Promise<TemplateList> {
  let response: Response;
  try {
    response = await fetch("/api/templates", { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("load the templates"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as TemplateList;
}

async function refreshTemplates(): Promise<TemplateList> {
  let response: Response;
  try {
    response = await fetch("/api/templates/refresh", { method: "POST", cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("read the template catalogue"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as TemplateList;
}

/** The refresh's answer, with the list it refreshed: a retried list asks
 * again, and an answer never lands on a list it was not asked for. */
interface Refreshed {
  of: TemplateList;
  list: TemplateList | null;
  error: string | null;
}

export function TemplatesScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const { operations } = useOperations();
  const { state, retry } = useAsync(readTemplates, "templates");
  const first = state.status === "ready" ? state.value : null;
  const [refreshed, setRefreshed] = useState<Refreshed | null>(null);

  useEffect(() => {
    if (!first || !refreshes(first.catalogue)) return;
    let cancelled = false;
    refreshTemplates().then(
      (list) => {
        if (!cancelled) setRefreshed({ of: first, list, error: null });
      },
      (cause: unknown) => {
        if (!cancelled) {
          setRefreshed({
            of: first,
            list: null,
            error: cause instanceof Error ? cause.message : "The template catalogue could not be read.",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [first]);

  const answer = refreshed && refreshed.of === first ? refreshed : null;
  const list = answer?.list ?? first;
  const reading = first !== null && refreshes(first.catalogue) && answer === null;
  const line =
    list === null
      ? null
      : (answer?.error ??
        (reading && list.catalogue.state === "not_read" ? READING_LINE : catalogueLine(list.catalogue)));

  const groupOf = useCallback(
    (operation: string) => operations?.find((o) => o.id === operation)?.group ?? null,
    [operations],
  );
  const labelOf = useMemo(
    () =>
      operations
        ? (operation: string) => operations.find((o) => o.id === operation)?.label ?? operation
        : null,
    [operations],
  );

  return (
    <div className={styles.screen}>
      <ListHeading
        title="Templates"
        line="Finished maps and workflows on open data. Open one to see how it is made, or make a copy to work on."
      />
      {line && (
        <p className={styles.catalogueLine} role="status" data-catalogue-line>
          <InfoIcon />
          <span>{line}</span>
        </p>
      )}
      <div className={gallery.scroller}>
        <AsyncState state={state} onRetry={retry} pendingLabel="Reading the templates…">
          {() =>
            list && list.templates.length > 0 ? (
              <div className={gallery.grid}>
                {list.templates.map((card, i) => (
                  <TemplateCard
                    key={card.id}
                    card={card}
                    index={i}
                    theme={theme}
                    groupOf={groupOf}
                    labelOf={labelOf}
                    onOpen={() => router.push(templateAddress(card.id))}
                    onCopy={() => router.push(templateAddress(card.id))}
                  />
                ))}
              </div>
            ) : line ? null : (
              <p className={gallery.empty}>No templates on this server yet.</p>
            )
          }
        </AsyncState>
      </div>
    </div>
  );
}
