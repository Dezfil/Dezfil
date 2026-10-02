"use client";
import { useEditorRequest } from "../../document-editor-context";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { useTheme } from "@/components/theme";
import { readApiError } from "../../api";
import { AsyncState, useAsync } from "@/components/ui/AsyncState";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Checkbox, Textarea } from "@/components/ui/Field";
import {
  CaretIcon,
  CheckIcon,
  CopyIcon,
  ExternalIcon,
  GlobeIcon,
} from "@/components/ui/icons";
import { timeSince } from "./elapsed";
import styles from "./PublishPopover.module.css";

interface PublishState {
  token: string;
  publishedAt: string;
}

interface ViewerControls {
  tilt: boolean;
  fit: boolean;
  theme: boolean;
  basemap: boolean;
  coords: boolean;
}

interface PublicationState extends PublishState {
  theme: "light" | "dark";
  viewerControls: ViewerControls;
}

/** The five optional controls — the four stack controls in the order
 * they appear, so the checklist reads down the map's own column, then
 * the attribution strip's coordinate readout. */
const CONTROL_ROWS: { key: keyof ViewerControls; label: string }[] = [
  { key: "tilt", label: "3D tilt" },
  { key: "fit", label: "Fit to data" },
  { key: "theme", label: "Light / dark" },
  { key: "basemap", label: "Basemap picker" },
  { key: "coords", label: "Cursor coordinates" },
];

/**
 * What readers can do with a published map, and which mode it opens in.
 * Both are publication state, so they update the live link in place — no
 * republish, no new token.
 *
 * Zoom and point north are deliberately absent: a map a reader cannot
 * navigate reads as broken, so they are not the author's to remove.
 */
function ReaderControls({
  mapId,
  publishedAt,
  onError,
}: {
  mapId: string;
  /** Changes when the map is published anew — refetches then. */
  publishedAt: string | null;
  onError: (message: string) => void;
}) {
  const request = useEditorRequest();
  const [state, setState] = useState<PublicationState | null>(null);
  const [busy, setBusy] = useState(false);
  // Publication writes are ordered, one at a time (the discipline). Each
  // one sends the whole setting, so two in flight can land in either
  // order and an older payload can undo a newer choice — and a write that
  // overtakes an Unpublish would republish the map under a fresh token.
  // The queue makes the last click the last write; the controls disable
  // while it drains, so the author never gets ahead of the record.
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/maps/${mapId}/publish`);
        if (!response.ok || response.status === 204) return;
        const data = (await response.json()) as PublicationState;
        if (!cancelled) setState(data);
      } catch {
        // A settings read that fails leaves the section absent rather
        // than showing controls whose state we cannot vouch for.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mapId, publishedAt]);

  const update = (body: Record<string, unknown>, previous: PublicationState) => {
    setBusy(true);
    queue.current = queue.current.then(async () => {
      try {
        const response = await request(`/api/maps/${mapId}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          // Reconcile to what the author had before this write, not to a
          // captured older image: the queue means nothing else moved.
          setState(previous);
          onError(await readApiError(response));
        }
      } catch {
        setState(previous);
        onError("The published map could not be updated.");
      } finally {
        setBusy(false);
      }
    });
  };

  if (!state) return null;

  const setTheme = (theme: "light" | "dark") => {
    setState({ ...state, theme });
    update({ theme }, state);
  };
  const setControl = (key: keyof ViewerControls, on: boolean) => {
    const viewerControls = { ...state.viewerControls, [key]: on };
    setState({ ...state, viewerControls });
    update({ viewerControls }, state);
  };

  return (
    <div className={styles.reader}>
      <div className={styles.readerRow}>
        <span className={styles.readerLabel}>Opens in</span>
        <div className={styles.modes} role="group" aria-label="Opens in">
          {(["light", "dark"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={styles.mode}
              aria-pressed={state.theme === mode}
              disabled={busy}
              onClick={() => setTheme(mode)}
            >
              {mode === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </div>
      <span className={styles.readerLabel}>Readers can</span>
      <div className={styles.controlList}>
        {/* Zoom and north are permanent viewer controls: the list
            carries the fact itself — checked, not disableable. */}
        {(["Zoom", "North"] as const).map((label) => (
          <Checkbox
            key={label}
            className={styles.controlRow}
            label={label}
            checked
            disabled
            title="Always available"
            onChange={() => {}}
          />
        ))}
        {CONTROL_ROWS.map(({ key, label }) => (
          <Checkbox
            key={key}
            className={styles.controlRow}
            label={label}
            checked={state.viewerControls[key]}
            disabled={busy}
            onChange={(e) => setControl(key, e.currentTarget.checked)}
          />
        ))}
      </div>
      <p className={styles.readerNote}>
        Changes reach the live link on the next load.
      </p>
    </div>
  );
}

interface LayerFieldsStatement {
  layerId: string;
  name: string;
  hidden?: boolean;
  mode?: "derived" | "list";
  fields?: { name: string; required: boolean }[];
  available?: string[];
  /** The author's raw explicit list; edits write against this, never
   * against the effective set, so a listed-and-currently-required field
   * survives unrelated toggles. */
  list?: string[] | null;
  error?: string;
}

/** The disclosure row's counts: published layers, and their fields. A
 * hidden layer appears in the detail and in neither number; when any
 * published layer's fields are unresolvable the field count is withheld
 * rather than understated. */
function summarize(layers: LayerFieldsStatement[]): string {
  const published = layers.filter((l) => !l.hidden);
  const layerCount = `${published.length} ${published.length === 1 ? "layer" : "layers"}`;
  if (published.some((l) => l.error)) return layerCount;
  const fields = published.reduce((n, l) => n + (l.fields?.length ?? 0), 0);
  return `${layerCount} · ${fields} ${fields === 1 ? "field" : "fields"}`;
}

/**
 * What each layer shares when this map is published — read from the API's
 * statement, never computed client-side, so the panel and the wire cannot
 * disagree. The editor writes the layer's published-field list through
 * the same PATCH lane every caller uses.
 *
 * Presentation is a quiet row: the statement loads when the popover
 * opens so the closed row can carry its counts, and a refresh keeps
 * showing the last statement while the next one loads — only the first
 * load and a failure render through the async contract.
 */
function SharedFields({
  mapId,
  revision,
  heading,
  onLayerChange,
}: {
  mapId: string;
  /** Changes whenever the map or its layers change — the statement
   * refreshes while the popover is open, so it keeps matching the
   * wire. */
  revision: string;
  /** "Shared fields" once published; the future tense before. */
  heading: string;
  onLayerChange: () => void;
}) {
  const request = useEditorRequest();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);

  const { state, retry } = useAsync<LayerFieldsStatement[]>(
    useCallback(async () => {
      let response: Response;
      try {
        response = await fetch(`/api/maps/${mapId}/published-fields`);
      } catch {
        // The voice rule (R10): a user sentence, not the engine's.
        throw new Error("The shared fields couldn't be loaded.");
      }
      if (!response.ok) throw new Error(await readApiError(response));
      const body = (await response.json()) as {
        layers: LayerFieldsStatement[];
      };
      return body.layers;
    }, [mapId]),
    `${mapId}|${revision}`,
  );

  // The last loaded statement, kept on screen while a refresh is in
  // flight — a checkbox toggle must not collapse the list into a spinner.
  // Adjusted during render behind a guard (React's documented pattern for
  // state derived from a changing value).
  const [lastReady, setLastReady] = useState<LayerFieldsStatement[] | null>(
    null,
  );
  if (state.status === "ready" && state.value !== lastReady) {
    setLastReady(state.value);
  }
  const shown = state.status === "ready" ? state.value : lastReady;
  // While the shown statement is the retained one, edits are locked: a
  // toggle derives the next list from `layer.list`, and deriving it from
  // a stale statement could resurrect the previous edit.
  const settling = state.status !== "ready";

  const patch = async (layerId: string, publishedFields: string[] | null) => {
    setBusy(true);
    try {
      const response = await request(`/api/layers/${layerId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publishedFields }),
      });
      if (!response.ok) {
        setPatchError(await readApiError(response));
        return;
      }
      setPatchError(null);
      retry();
      onLayerChange();
    } finally {
      setBusy(false);
    }
  };

  const toggleField = (layer: LayerFieldsStatement, field: string) => {
    // Edit the raw list, seeded from the effective set on the first
    // toggle out of derived mode. Membership is the author's — a listed
    // field the style currently requires stays listed.
    const current = layer.list ?? (layer.fields ?? []).map((f) => f.name);
    const next = current.includes(field)
      ? current.filter((f) => f !== field)
      : [...current, field];
    void patch(layer.layerId, next);
  };

  const detail = (layers: LayerFieldsStatement[]) => (
    <div className={styles.fieldsBody}>
      {layers.map((layer) => {
        const isOpen = editing === layer.layerId;
        return (
          <div key={layer.layerId} className={styles.fieldsLayer}>
            <div className={styles.layerLine}>
              <span className={styles.layerName}>{layer.name}</span>
              {layer.hidden ? (
                <span className={styles.layerNote}>hidden, not published</span>
              ) : layer.error ? (
                <span className={styles.layerNote}>fields unavailable</span>
              ) : (
                <>
                  <span className={styles.layerCount}>
                    {(layer.fields ?? []).length}{" "}
                    {(layer.fields ?? []).length === 1 ? "field" : "fields"}
                    {layer.mode === "list" ? " · custom" : ""}
                  </span>
                  <button
                    className={styles.layerEdit}
                    onClick={() => setEditing(isOpen ? null : layer.layerId)}
                  >
                    {isOpen ? "Done" : "Edit"}
                  </button>
                </>
              )}
            </div>
            {isOpen && !layer.hidden && !layer.error && (
              <div className={styles.editor}>
                {(layer.available ?? []).length === 0 ? (
                  <p className={styles.editorNote}>
                    Computed cells share only their aggregate values.
                  </p>
                ) : (
                  (layer.available ?? []).map((name) => {
                    const entry = (layer.fields ?? []).find(
                      (f) => f.name === name,
                    );
                    return (
                      <Checkbox
                        key={name}
                        className={styles.fieldOption}
                        checked={entry !== undefined}
                        disabled={busy || settling || entry?.required}
                        onChange={() => toggleField(layer, name)}
                        label={
                          <>
                            <span className={styles.fieldName}>{name}</span>
                            {entry?.required && (
                              <span className={styles.fieldRequired}>
                                needed to render
                              </span>
                            )}
                          </>
                        }
                      />
                    );
                  })
                )}
                {layer.mode === "list" && (
                  <Button
                    variant="quiet"
                    className={styles.resetBtn}
                    disabled={busy || settling}
                    onClick={() => void patch(layer.layerId, null)}
                  >
                    Reset to automatic
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className={styles.fields}>
      <button
        className={styles.fieldsRow}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.fieldsCaret} data-open={open || undefined}>
          <CaretIcon />
        </span>
        {heading}
        {shown !== null && (
          <span className={styles.fieldsCount}>{summarize(shown)}</span>
        )}
      </button>
      {open &&
        (shown === null ? (
          <AsyncState state={state} onRetry={retry}>
            {detail}
          </AsyncState>
        ) : (
          <>
            {state.status === "failed" && (
              <ErrorNote message={state.error} onRetry={retry} />
            )}
            {patchError && (
              <ErrorNote
                message={patchError}
                onDismiss={() => setPatchError(null)}
              />
            )}
            {detail(shown)}
          </>
        ))}
    </div>
  );
}

/** True only when the text actually reached the clipboard — a denied or
 * absent clipboard must not be confirmed as a copy. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A confirmation that shows, then withdraws itself (the feedback role). */
function useTransientFlag(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setOn(false), 2000);
    return () => clearTimeout(timer);
  }, [on]);
  return [on, useCallback(() => setOn(true), [])];
}

/** The embed view: the published link written out as an
 * iframe snippet — nothing the link does not already permit, and no new
 * server capability behind it. */
function EmbedView({
  url,
  mapName,
  onBack,
}: {
  url: string;
  mapName: string;
  onBack: () => void;
}) {
  const [copied, flagCopied] = useTransientFlag();
  // The embed marker: the same link, told it is embedded, so the marked
  // view renders the reduced control set. It is added here and not to
  // `url` — that value is also the copy-link hero, the Open link and the
  // published-url attribute, none of which are embeds.
  const embedUrl = `${url}?embed=1`;
  const snippet = `<iframe src="${embedUrl}" width="100%" height="480" style="border:0" title="${mapName.replace(/"/g, "&quot;")}" loading="lazy" allowfullscreen></iframe>`;

  return (
    <div className={styles.embed}>
      <button className={styles.backBtn} onClick={onBack} autoFocus>
        <span className={styles.backCaret} aria-hidden>
          <CaretIcon />
        </span>
        Back
      </button>
      <h2 className={styles.embedTitle}>Embed this map</h2>
      <p className={styles.embedText}>
        Paste this into any page. The map stays live at this link.
      </p>
      <Textarea
        className={styles.snippet}
        value={snippet}
        readOnly
        rows={5}
        aria-label="Embed code"
        onFocus={(e) => e.currentTarget.select()}
      />
      <Button
        variant="primary"
        className={styles.copyBtn}
        onClick={() => {
          void copyText(snippet).then((ok) => ok && flagCopied());
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Code copied" : "Copy code"}
      </Button>
    </div>
  );
}

/** The audience is a statement, not a control: there is one
 * answer until auth exists, and a picker would promise access rules the
 * product does not have. */
function Audience({ tense }: { tense: "present" | "future" }) {
  return (
    <p className={styles.audience}>
      <GlobeIcon />
      {tense === "present"
        ? "Anyone with the link can view"
        : "Anyone with the link will be able to view"}
    </p>
  );
}

/** The popover's content, rebuilt to the ratified direction: the
 * link is the hero, the audience lives inside it,
 * shared fields keep one quiet row, and the footer holds the
 * destructive exit. */
export function PublishPopover({
  map,
  onChange,
}: {
  map: MapWithLayers;
  onChange: () => void;
}) {
  const request = useEditorRequest();
  const [busy, setBusy] = useState(false);
  const [copied, flagCopied] = useTransientFlag();
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"main" | "embed">("main");
  const { theme } = useTheme();

  // Unpublishing while the embed view is up: there is nothing left to
  // frame, so the view falls back (render-phase adjust, guarded).
  if (view === "embed" && !map.publishToken) setView("main");

  // The elapsed label ticks while the popover stays open:
  // one re-render a minute, so "just now" does not outlive the minute.
  const [, setMinute] = useState(0);
  useEffect(() => {
    if (!map.published) return;
    const timer = setInterval(() => setMinute((m) => m + 1), 60_000);
    return () => clearInterval(timer);
  }, [map.published]);

  // Anything that can move the shared-field statement: map-level config
  // (timeline, widgets) and every layer's durable state and visibility.
  const revision = `${map.updatedAt}|${map.layers
    .map((l) => `${l.id}:${l.updatedAt}:${l.visible ? 1 : 0}`)
    .join(",")}`;

  // The link is the map owner's to hand out: only their reads carry the
  // token, so anyone else sees the publication live without its link.
  const url = map.publishToken
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/v/${map.publishToken}`
    : null;

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      // The publication captures the mode being composed in.
      const response = await request(`/api/maps/${map.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme }),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      const state = (await response.json()) as PublishState;
      const link = `${window.location.origin}/v/${state.token}`;
      if (await copyText(link)) flagCopied();
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await request(`/api/maps/${map.id}/publish`, {
        method: "DELETE",
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    if (await copyText(url)) flagCopied();
  };

  if (map.publishToken && view === "embed" && url) {
    return <EmbedView url={url} mapName={map.name} onBack={() => setView("main")} />;
  }

  return (
    <div className={styles.body}>
      {error && (
        <ErrorNote message={error} onDismiss={() => setError(null)} />
      )}
      {map.published ? (
        <>
          <div className={styles.top}>
            <span className={styles.live}>
              <span className={styles.liveDot} aria-hidden />
              Published
              {map.publishedAt && (
                <span className={styles.ago}>
                  {" "}
                  · {timeSince(map.publishedAt)}
                </span>
              )}
            </span>
            {url && (
              <a
                className={styles.openLink}
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                Open <ExternalIcon />
              </a>
            )}
          </div>
          <div className={styles.hero}>
            {url && (
              <>
                <div className={styles.url} data-publish-url={url}>
                  {url.replace(/^https?:\/\//, "")}
                </div>
                <Button
                  variant="primary"
                  className={styles.copyBtn}
                  onClick={() => void copy()}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Link copied" : "Copy link"}
                </Button>
              </>
            )}
            <Audience tense="present" />
          </div>
          <SharedFields
            mapId={map.id}
            revision={revision}
            heading="Shared fields"
            onLayerChange={onChange}
          />
          <div className={styles.rule} />
          <ReaderControls
            mapId={map.id}
            publishedAt={map.publishedAt}
            onError={setError}
          />
          <div className={styles.rule} />
          <div className={styles.foot}>
            {url && (
              <Button variant="quiet" onClick={() => setView("embed")}>
                Embed
              </Button>
            )}
            <Button
              variant="quiet"
              className={styles.unpublish}
              onClick={() => void unpublish()}
              busy={busy}
            >
              Unpublish
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className={styles.unpub}>
            <Button
              variant="primary"
              size="chrome"
              className={styles.publishBtn}
              onClick={() => void publish()}
              busy={busy}
            >
              {copied ? "Link copied" : "Publish map"}
            </Button>
            <Audience tense="future" />
          </div>
          <div className={styles.rule} />
          <SharedFields
            mapId={map.id}
            revision={revision}
            heading="Fields this will share"
            onLayerChange={onChange}
          />
        </>
      )}
    </div>
  );
}
