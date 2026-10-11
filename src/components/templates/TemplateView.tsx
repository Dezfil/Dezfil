"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import type { AttributionLine, BasemapStyle } from "@/lib/basemap";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { TemplateDetail } from "@/lib/templates/card";
import type { TemplateContents } from "@/lib/templates/opened";
import { formatBytes, readApiError, readOperations } from "../api";
import { useOperations } from "../builder/drawer/use-operations";
import { serverUnreachable } from "../failure-copy";
import { loadReader, ReaderStage, type ReaderData } from "../reader/MapReader";
import { contributePath, releasePath } from "../shell/path-model";
import { PlainCrumbTail } from "../shell/PlainCrumbTail";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import { ChevronIcon, DuplicateIcon } from "../ui/icons";
import { WorkflowScreen } from "../WorkflowScreen";
import type { TemplateCanvasSeam } from "../workflow-canvas/template-canvas";
import { HowItsMade, type LayersFailure } from "./HowItsMade";
import { TemplateCopyDialog } from "./TemplateCopyDialog";
import { templatePage } from "./template-view-model";
import styles from "./TemplateView.module.css";

/**
 * A template opened: the version the page was served, read only, in the
 * workspace shell. A map template is the reader's map, as a map one may
 * only view opens, with How it's made where the builder's inspector would
 * stand; a workflow example is its canvas, view-only and with no run, the
 * panel in the pane's place. Make a copy, in the header where Publish
 * stands in the builder, is the only action: its dialog copies the version
 * this page opened.
 *
 * The page keeps the version it opened: nothing here reads the template's
 * newest again, so a newer version listed meanwhile changes nothing on it,
 * and a copy made from it is of this version. A version not on this server
 * yet is downloaded first (the one thing the page may cause to be written,
 * on the server's own templates folder), then that version is read again
 * by its number through the read of one, and opened. Every other read is a
 * read: the map and its layers' renders, and the operation catalog.
 */

interface BasemapProps {
  basemapUrl: string;
  basemapOverrideUrl: string | null;
  basemapOverrideAttribution: AttributionLine[];
  basemaps: BasemapStyle[];
}

const subscribeNever = () => () => {};

export function TemplateView({
  template: served,
  ...basemap
}: BasemapProps & {
  /** The read of one, as the page was served: the version it opens, with
   * what the version holds once it is installed. */
  template: TemplateDetail;
}) {
  // The version as served, until its download lands: then that version
  // read again by its number.
  const [read, setRead] = useState<{ of: TemplateDetail; detail: TemplateDetail } | null>(null);
  const template = read?.of === served ? read.detail : served;
  const opened = template.contents;
  const pathname = usePathname();
  const [copying, setCopying] = useState(false);
  const { operations } = useOperations();
  const groupOf = useCallback(
    (operation: string) => operations?.find((o) => o.id === operation)?.group ?? null,
    [operations],
  );
  const labelOf = useMemo(
    () => (operations ? (operation: string) => operations.find((o) => o.id === operation)?.label ?? operation : null),
    [operations],
  );

  // Beside a panel, the stage keeps the builder's edge and stands its
  // control stack on the right, as the reader does. Set before the first
  // paint, as the reader sets its own.
  useLayoutEffect(() => {
    document.body.setAttribute("data-template-view", "");
    return () => document.body.removeAttribute("data-template-view");
  }, []);
  // The shell's path names the template, filed nowhere.
  useEffect(() => {
    contributePath(pathname, { name: template.title, projectId: null });
    return () => releasePath(pathname);
  }, [pathname, template.title]);

  const mapPanel = useCallback(
    (layers: MapWithLayers["layers"] | null, renders?: ReaderData["renders"]) =>
      opened ? (
        <HowItsMade template={template} opened={opened} layers={layers} renders={renders} groupOf={groupOf} labelOf={labelOf} beside="map" />
      ) : null,
    [template, opened, groupOf, labelOf],
  );
  const canvasPanel = useCallback(
    (layers: MapWithLayers["layers"] | null, failure: LayersFailure | null) =>
      opened ? (
        <HowItsMade template={template} opened={opened} layers={layers} layersFailure={failure} groupOf={groupOf} labelOf={labelOf} beside="canvas" />
      ) : null,
    [template, opened, groupOf, labelOf],
  );

  return (
    <>
      <PlainCrumbTail name={template.title} />
      <CopyAction title={template.title} onCopy={() => setCopying(true)} />
      {copying ? <TemplateCopyDialog id={template.id} template={template} onClose={() => setCopying(false)} /> : null}
      {opened === null ? (
        template.present ? (
          <Fallback message={UNREAD} />
        ) : (
          <Download template={template} onDone={(detail) => setRead({ of: served, detail })} />
        )
      ) : template.kind === "map" ? (
        <TemplateMap opened={opened} panel={mapPanel} {...basemap} />
      ) : (
        <TemplateCanvas template={template} opened={opened} pane={canvasPanel} />
      )}
    </>
  );
}

/** Make a copy, in the header's right slot where Publish stands in the
 * builder: the page's one action. */
function CopyAction({ title, onCopy }: { title: string; onCopy: () => void }) {
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  if (!mounted) return null;
  const slot = document.getElementById("header-actions-right");
  if (!slot) return null;
  return createPortal(
    <Button
      variant="primary"
      size="chrome"
      className={styles.copyAction}
      onClick={onCopy}
      aria-label={`Make a copy of ${title}`}
      data-template-copy
    >
      <DuplicateIcon /> Make a copy
    </Button>,
    slot,
  );
}

/** What stands in for the template when it cannot open: the reason, and
 * the way back to the templates. */
function Fallback({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={styles.fallback} data-template-fallback>
      <Link href="/templates" className={styles.back}>
        <ChevronIcon /> Templates
      </Link>
      <ErrorNote message={message} onRetry={onRetry} />
    </div>
  );
}

const UNREAD = "This template's files could not be read on this server.";

type Downloaded = { detail: TemplateDetail; refused?: never } | { refused: string; detail?: never };

/** Download one version, then read that version again by its number, as
 * the read of one answers it: never the template's newest, which the
 * catalogue may have moved on to meanwhile. Else why not. */
async function download(id: string, version: number): Promise<Downloaded> {
  const address = `/api/templates/${encodeURIComponent(id)}`;
  let response: Response;
  try {
    response = await fetch(`${address}/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version }),
    });
  } catch {
    return { refused: serverUnreachable("download the template") };
  }
  if (!response.ok) return { refused: await readApiError(response) };
  try {
    response = await fetch(`${address}?version=${version}`, { cache: "no-store" });
  } catch {
    return { refused: serverUnreachable("read the template") };
  }
  if (!response.ok) return { refused: await readApiError(response) };
  const detail = (await response.json()) as TemplateDetail;
  return detail.present ? { detail } : { refused: UNREAD };
}

/** A listed version not on this server yet: downloaded once, as the card
 * said opening would, then read again by its number and handed over. One
 * download per attempt, however often the page renders or its effects
 * re-run. */
function Download({ template, onDone }: { template: TemplateDetail; onDone: (detail: TemplateDetail) => void }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  const asked = useRef<{ key: string; answer: Promise<Downloaded> } | null>(null);
  useEffect(() => {
    const key = `${template.id}@${template.version}#${attempt}`;
    if (asked.current?.key !== key) asked.current = { key, answer: download(template.id, template.version) };
    let cancelled = false;
    void asked.current.answer.then((answer) => {
      if (cancelled) return;
      if (answer.detail) done.current(answer.detail);
      else setFailure(answer.refused);
    });
    return () => {
      cancelled = true;
    };
  }, [template.id, template.version, attempt]);
  if (failure) {
    return (
      <Fallback
        message={failure}
        onRetry={() => {
          setFailure(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  return (
    <div className={styles.fallback} role="status" data-template-downloading>
      Downloading the template, {formatBytes(template.size)}…
    </div>
  );
}

type MapState = { status: "pending" } | { status: "failed"; message: string } | { status: "ready"; data: ReaderData };

/** A map template: the reader's map on the template map's id, the panel
 * beside it once its layers are read. */
function TemplateMap({
  opened,
  panel,
  ...basemap
}: BasemapProps & {
  opened: TemplateContents;
  panel: (layers: MapWithLayers["layers"] | null, renders?: ReaderData["renders"]) => React.ReactNode;
}) {
  const [state, setState] = useState<MapState>({ status: "pending" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    loadReader(opened.mapId).then(
      (data) => {
        if (!cancelled) setState({ status: "ready", data });
      },
      (e: unknown) => {
        if (!cancelled) setState({ status: "failed", message: e instanceof Error ? e.message : "The map could not be read." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [opened.mapId, attempt]);
  return (
    <>
      {panel(state.status === "ready" ? state.data.map.layers : null, state.status === "ready" ? state.data.renders : undefined)}
      {state.status === "ready" ? (
        <ReaderStage
          mapId={opened.mapId}
          map={state.data.map}
          projectId={null}
          renders={state.data.renders}
          besidePanel
          {...basemap}
        />
      ) : state.status === "failed" ? (
        <div className={styles.stageNote}>
          <ErrorNote
            message={state.message}
            onRetry={() => {
              setState({ status: "pending" });
              setAttempt((n) => n + 1);
            }}
          />
        </div>
      ) : (
        <div className={styles.stageNote} role="status">
          Loading map…
        </div>
      )}
    </>
  );
}

type LayersRead =
  | { status: "pending" }
  | { status: "failed"; message: string }
  | { status: "ready"; layers: MapWithLayers["layers"] };

/** A workflow example: its canvas view-only, through the read seam, with
 * the panel in the pane's place. The template map's layers are read for
 * the panel alone; a read that fails says why in the panel, with a retry. */
function TemplateCanvas({
  template,
  opened,
  pane,
}: {
  template: TemplateDetail;
  opened: TemplateContents;
  pane: (layers: MapWithLayers["layers"] | null, failure: LayersFailure | null) => React.ReactNode;
}) {
  const [read, setRead] = useState<LayersRead>({ status: "pending" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: LayersRead;
      try {
        const response = await fetch(`/api/maps/${encodeURIComponent(opened.mapId)}`);
        next = response.ok
          ? { status: "ready", layers: ((await response.json()) as MapWithLayers).layers }
          : { status: "failed", message: await readApiError(response) };
      } catch {
        next = { status: "failed", message: serverUnreachable("read the template's layers") };
      }
      if (!cancelled) setRead(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [opened.mapId, attempt]);
  const failure = useMemo<LayersFailure | null>(
    () =>
      read.status === "failed"
        ? {
            message: read.message,
            onRetry: () => {
              setRead({ status: "pending" });
              setAttempt((n) => n + 1);
            },
          }
        : null,
    [read],
  );
  const page = useMemo(() => templatePage(template, opened), [template, opened]);
  const seam = useMemo<TemplateCanvasSeam | null>(
    () =>
      page
        ? {
            read: async () => ({ ...page, operations: await readOperations() }),
            pane: pane(read.status === "ready" ? read.layers : null, failure),
          }
        : null,
    [page, pane, read, failure],
  );
  if (!seam || !page) return <Fallback message="This template's workflow could not be read on this server." />;
  return <WorkflowScreen id={page.recipe.id} viewOnly runs={false} template={seam} />;
}
