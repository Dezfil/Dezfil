"use client";

import { LastChanged } from "./sharing/LastChanged";
import { editHeaders } from "@/lib/edit-basis";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MapOverview } from "./api";
import { readApiError } from "./api";
import {
  IconDuplicate,
  IconFolderPlus,
  IconGrid,
  IconLink,
  IconList,
  IconOpen,
  IconPublish,
  IconSearch,
  IconTrash,
} from "./gallery-icons";
import { MapStrip } from "./MapStrip";
import { AddToProjectDialog } from "./projects/AddToProjectDialog";
import { actionLabel } from "./projects/add-model";
import { useTheme } from "@/components/theme";
import { useViewPrefs } from "./use-view-prefs";
import { ListHeading } from "./ListHeading";
import { ScopeFilter } from "./scope/ScopeFilter";
import { headingLine, scopeRows, tileSubLine, unreachedProjects } from "./scope/model";
import { useProjectScope } from "./scope/use-scope";
import { useScopeWorld } from "./scope/use-scope-world";
import { AsyncState } from "./ui/AsyncState";
import { ErrorNote } from "./ui/ErrorNote";
import { CheckIcon, PlusIcon } from "./ui/icons";
import { OwnerPill } from "./sharing/PeopleMarks";
import { ownedByOther } from "./sharing/people";
import { useSignedInSqlName } from "./sharing/signed-in";
import { useRuleRefusal } from "./use-instance-rules";
import gallery from "./gallery.module.css";
import styles from "./MapsScreen.module.css";
import { serverUnreachable } from "./failure-copy";

type Filter = "all" | "published" | "drafts";
export type MapsSort = "edited" | "created" | "name";
const MAPS_SORTS = ["edited", "created", "name"] as const;

const MAX_LAYER_DOTS = 6;

/** The listing load, as a user sentence when the network itself fails —
 * server answers already carry documented sentences via the API error
 * contract. */
async function fetchMaps(scope?: string): Promise<MapOverview[]> {
  let response: Response;
  // An empty scope value is NOT the unscoped road: it rides through and
  // the server refuses it.
  const path =
    scope !== undefined
      ? `/api/maps?project=${encodeURIComponent(scope)}`
      : "/api/maps";
  try {
    response = await fetch(path, { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("load the maps"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as MapOverview[];
}

function LayerDots({ colors }: { colors: string[] }) {
  if (colors.length === 0) return null;
  return (
    <span className={gallery.layerDots} aria-hidden>
      {colors.slice(0, MAX_LAYER_DOTS).map((c, i) => (
        <i key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

function StateChip({ live }: { live: boolean }) {
  return (
    <span className={gallery.chip} data-live={live || undefined}>
      <i />
      {live ? "Published" : "Draft"}
    </span>
  );
}

/** The passive project fact: text, never a
 * control, never an id. One's own work can stay filed in a project one was
 * removed from: the directory has no name for it, and it is said as such
 * rather than as in no project. */
export function ProjectTag({
  projectId,
  projects,
}: {
  projectId: string | null;
  projects: { id: string; name: string }[];
}) {
  if (!projectId) {
    return (
      <span className={gallery.projTag} data-none>
        not in a project
      </span>
    );
  }
  const name = projects.find((p) => p.id === projectId)?.name;
  return name ? (
    <span className={gallery.projTag}>{name}</span>
  ) : (
    <span className={gallery.projTag} data-unreached>
      {unreachedProjects(1)}
    </span>
  );
}

export function MapsScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  // Someone else's map is marked with its owner and keeps only what reads
  // it among its quick actions.
  const me = useSignedInSqlName();
  const othersOwner = (m: MapOverview) =>
    ownedByOther(m.owner, me) ? m.owner : null;
  // Who may publish: when the instance's rule holds the person back, a
  // draft's Publish is drawn disabled with the rule's sentence as its hint.
  const publishRefusal = useRuleRefusal("publishing.publish");
  // The listing load runs through the shared async contract; the
  // scaffolding's edits overlay keeps mutations updating the list in
  // place, and a retry's fresh answer discards them.
  const { scope, setScope } = useProjectScope();
  const {
    state: listState,
    retry,
    mutate,
    refresh,
  } = useScopeWorld<MapOverview>({
    kind: "maps",
    scope,
    fetchUnscoped: fetchMaps,
    fetchScoped: (param) => fetchMaps(param),
  });
  const world = listState.status === "ready" ? listState.value : null;
  const maps = world?.scoped ?? null;
  // Mutation failures are their own dismissible note, separate from the
  // load state — one banner no longer serves six different failures.
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const { view, sort, setView, setSort } = useViewPrefs<MapsSort>(
    "maps",
    "edited",
    MAPS_SORTS,
  );
  // Per-card delete: first click arms, second deletes.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // The 14-A dialog's subject and the stated outcome.
  const [filing, setFiling] = useState<MapOverview | null>(null);
  const [filedNote, setFiledNote] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search — unless the user is already typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const createMap = useCallback(async () => {
    setCreating(true);
    try {
      const response = await fetch("/api/maps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Untitled map",
          // The provisional default: a named scope files at birth;
          // All and Not-in-a-project keep today's unfiled creation.
          ...(scope.kind === "project" ? { projectId: scope.id } : {}),
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const map = (await response.json()) as MapOverview;
      router.push(`/maps/${map.id}`);
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "The map couldn't be created.",
      );
      setCreating(false);
    }
  }, [router, scope]);

  const deleteMap = useCallback(async (item: MapOverview) => {
    const { id } = item;
    setDeletingId(id);
    try {
      const response = await fetch(`/api/maps/${id}`, { method: "DELETE", headers: editHeaders(item) });
      if (!response.ok) throw new Error(await readApiError(response));
      mutate((w) => ({
        ...w,
        all: w.all.filter((m) => m.id !== id),
        scoped: w.scoped.filter((m) => m.id !== id),
      }));
      setActionError(null);
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "The map couldn't be deleted.",
      );
    } finally {
      setDeletingId(null);
      setConfirmId(null);
    }
  }, [mutate]);

  const publishMap = useCallback(
    async (item: MapOverview) => {
    const { id } = item;
    setBusyId(id);
    try {
      // The publication captures the current workspace mode.
      const response = await fetch(`/api/maps/${id}/publish`, {
        method: "POST",
        headers: editHeaders(item, { "Content-Type": "application/json" }),
        body: JSON.stringify({ theme }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const body = (await response.json()) as {
        token: string;
        publishedAt: string;
        editRevision: string;
      };
      const publish = (m: MapOverview) =>
        m.id === id
          ? { ...m, publishToken: body.token, publishedAt: body.publishedAt, published: true, editRevision: body.editRevision }
          : m;
      mutate((w) => ({ ...w, all: w.all.map(publish), scoped: w.scoped.map(publish) }));
      setActionError(null);
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "The map couldn't be published.",
      );
    } finally {
      setBusyId(null);
    }
    },
    [theme, mutate],
  );

  const duplicateMap = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      const response = await fetch(`/api/maps/${id}/duplicate`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await readApiError(response));
      // The copy needs its overview (layer colors) — the scope-aware
      // quiet re-read keeps results AND filter counts coherent.
      await refresh();
      setActionError(null);
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "The map couldn't be duplicated.",
      );
    } finally {
      setBusyId(null);
    }
  }, [refresh]);

  const copyShareLink = useCallback(async (map: MapOverview) => {
    if (!map.publishToken) return;
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/v/${map.publishToken}`,
      );
      setCopiedId(map.id);
      setTimeout(() => setCopiedId((c) => (c === map.id ? null : c)), 1600);
      setActionError(null);
    } catch {
      setActionError(
        "Could not copy the link. Copy it from the builder instead.",
      );
    }
  }, []);

  const shown = useMemo(() => {
    if (!maps) return null;
    const q = query.trim().toLowerCase();
    const filtered = maps.filter((m) => {
      if (filter === "published" && !m.published) return false;
      if (filter === "drafts" && m.published) return false;
      return !q || m.name.toLowerCase().includes(q);
    });
    return [...filtered].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "created") return b.createdAt.localeCompare(a.createdAt);
      return (b.lastChangedAt ?? "").localeCompare(a.lastChangedAt ?? "");
    });
  }, [maps, query, filter, sort]);

  const counts = useMemo(() => {
    const published = maps?.filter((m) => m.published).length ?? 0;
    return {
      all: maps?.length ?? 0,
      published,
      drafts: (maps?.length ?? 0) - published,
    };
  }, [maps]);


  // A map one may only view opens in the reader, not the builder: someone
  // else's map in a project where one is a Viewer.
  const viewOnly = (m: MapOverview) =>
    othersOwner(m) !== null &&
    world?.projects.find((p) => p.id === m.projectId)?.role === "viewer";

  const quickActions = (m: MapOverview, rowStyle: string) => {
    const mine = othersOwner(m) === null;
    const opens = viewOnly(m) ? "Open" : "Open in builder";
    return (
    <span className={rowStyle}>
      {mine && (
        <button
          data-hint={actionLabel("map", !!m.projectId)}
          aria-label={`${actionLabel("map", !!m.projectId)}: ${m.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setFiling(m);
          }}
        >
          <IconFolderPlus />
        </button>
      )}
      <button
        data-hint={opens}
        aria-label={viewOnly(m) ? `Open ${m.name}` : `Open ${m.name} in the builder`}
        onClick={(e) => {
          e.stopPropagation();
          router.push(`/maps/${m.id}`);
        }}
      >
        <IconOpen />
      </button>
      <button
        data-hint="Duplicate map"
        aria-label={`Duplicate ${m.name}`}
        disabled={busyId === m.id}
        onClick={(e) => {
          e.stopPropagation();
          void duplicateMap(m.id);
        }}
      >
        <IconDuplicate />
      </button>
      {m.publishToken ? (
        <button
          data-hint={copiedId === m.id ? "Copied!" : "Copy share link"}
          aria-label={`Copy share link for ${m.name}`}
          onClick={(e) => {
            e.stopPropagation();
            void copyShareLink(m);
          }}
        >
          {copiedId === m.id ? <CheckIcon /> : <IconLink />}
        </button>
      ) : mine ? (
        <button
          data-hint={publishRefusal ?? "Publish map"}
          aria-label={`Publish ${m.name}`}
          disabled={busyId === m.id || publishRefusal !== null}
          onClick={(e) => {
            e.stopPropagation();
            void publishMap(m);
          }}
        >
          <IconPublish />
        </button>
      ) : null}
      {mine && (
        <button
          className={gallery.deleteAct}
          data-confirm={confirmId === m.id || undefined}
          disabled={deletingId === m.id}
          data-hint={
            confirmId === m.id ? "Click again to delete permanently" : "Delete map"
          }
          aria-label={
            confirmId === m.id
              ? `Confirm deleting ${m.name}`
              : `Delete ${m.name}`
          }
          onClick={(e) => {
            e.stopPropagation();
            if (confirmId === m.id) void deleteMap(m);
            else setConfirmId(m.id);
          }}
          onBlur={() => setConfirmId(null)}
        >
          {confirmId === m.id ? "Delete?" : <IconTrash />}
        </button>
      )}
    </span>
    );
  };

  return (
    <div className={styles.screen}>
      {/* The one heading: the count is the scope's, before any narrowing;
          until the world resolves nothing is asserted. A
          pending or refused scope (an invalid address included) must not
          quietly create unfiled: creation waits for a ready world. */}
      <ListHeading
        title="Maps"
        line={
          world
            ? headingLine({
                scopedTotal: world.scoped.length,
                scope,
                scopeName:
                  scope.kind === "project"
                    ? (world.projects.find((x) => x.id === scope.id)?.name ??
                      null)
                    : null,
                shownCount: shown?.length ?? world.scoped.length,
              })
            : null
        }
        action={{
          label: creating ? "Creating…" : "New map",
          onClick: () => void createMap(),
          disabled: creating || !world,
        }}
      />

      {actionError && (
        <ErrorNote
          message={actionError}
          onDismiss={() => setActionError(null)}
        />
      )}
      {filedNote && (
        <p className={styles.filedNote} role="status">
          {filedNote}
        </p>
      )}

      <div className={gallery.toolbar}>
        <ScopeFilter
          rows={
            world
              ? scopeRows(world.all, world.projects, (m) =>
                  m.projectId ? [m.projectId] : [],
                )
              : []
          }
          scope={scope}
          onPick={(id) =>
            setScope(
              id === "all"
                ? { kind: "all" }
                : id === "none"
                  ? { kind: "none" }
                  : { kind: "project", id },
            )
          }
        />
        <label className={gallery.search}>
          <IconSearch />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search maps…"
            aria-label="Search maps"
          />
          <kbd>/</kbd>
        </label>
        <div className={gallery.chips} role="group" aria-label="Filter maps">
          <button
            className={gallery.filterChip}
            data-on={filter === "all" || undefined}
            onClick={() => setFilter("all")}
          >
            {/* Counts appear only once the listing has resolved — a chip
                asserting "0" mid-flight is that lie in miniature. */}
            {maps ? (
              <>
                All
                <span className={gallery.chipCount}> · {counts.all}</span>
              </>
            ) : (
              "All"
            )}
          </button>
          <button
            className={gallery.filterChip}
            data-on={filter === "published" || undefined}
            onClick={() => setFilter("published")}
          >
            {maps ? (
              <>
                Published
                <span className={gallery.chipCount}> · {counts.published}</span>
              </>
            ) : (
              "Published"
            )}
          </button>
          <button
            className={gallery.filterChip}
            data-on={filter === "drafts" || undefined}
            onClick={() => setFilter("drafts")}
          >
            {maps ? (
              <>
                Drafts
                <span className={gallery.chipCount}> · {counts.drafts}</span>
              </>
            ) : (
              "Drafts"
            )}
          </button>
        </div>
        <div className={gallery.tail}>
          <label className={gallery.sort}>
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as MapsSort)}
              aria-label="Sort maps"
            >
              <option value="edited">Recently edited</option>
              <option value="created">Recently created</option>
              <option value="name">Name A–Z</option>
            </select>
          </label>
          <div className={gallery.viewToggle} role="group" aria-label="View">
            <button
              data-on={view === "grid" || undefined}
              data-hint="Grid view"
              aria-label="Grid view"
              onClick={() => setView("grid")}
            >
              <IconGrid />
            </button>
            <button
              data-on={view === "list" || undefined}
              data-hint="List view"
              aria-label="List view"
              onClick={() => setView("list")}
            >
              <IconList />
            </button>
          </div>
        </div>
      </div>

      <div className={gallery.scroller}>
      <AsyncState
        state={listState}
        onRetry={retry}
        pendingLabel="Reading your maps…"
      >
      {() => (
      <>
      {shown && view === "grid" && (
        <div className={gallery.grid}>
          <button
            className={gallery.ghost}
            onClick={() => void createMap()}
            disabled={creating}
          >
            <span className={gallery.plus}>
              <PlusIcon />
            </span>
            <b>New map</b>
            <small>
              {tileSubLine(
                "map",
                scope,
                scope.kind === "project"
                  ? (world?.projects.find((x) => x.id === scope.id)?.name ?? null)
                  : null,
              )}
            </small>
          </button>
          {shown.map((m, i) => (
            <article
              key={m.id}
              className={gallery.card}
              style={{ animationDelay: `${Math.min(45 + i * 45, 380)}ms` }}
            >
              <div
                role="link"
                tabIndex={0}
                aria-label={`Open ${m.name}`}
                className={gallery.cardLink}
                onClick={() => router.push(`/maps/${m.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") router.push(`/maps/${m.id}`);
                }}
              >
                <div className={gallery.strip} style={{ height: 148 }}>
                  <MapStrip map={m} />
                  <span className={gallery.overlay}>
                    <LayerDots colors={m.layerColors} />
                    <b>
                      <span className={gallery.num}>{m.layerCount}</span> layer
                      {m.layerCount === 1 ? "" : "s"}
                    </b>
                  </span>
                </div>
                <div className={gallery.cardBody}>
                  <div className={gallery.cardTop}>
                    <span className={gallery.cardName}>{m.name}</span>
                    <span className={gallery.cardWhen}>
                      <LastChanged value={m} />
                    </span>
                  </div>
                  <div className={gallery.cardChips}>
                    <StateChip live={m.published} />
                    <ProjectTag
                      projectId={m.projectId}
                      projects={world?.projects ?? []}
                    />
                  </div>
                </div>
              </div>
              {othersOwner(m) && (
                <OwnerPill owner={othersOwner(m)!} placement="corner" />
              )}
              {quickActions(m, gallery.acts)}
            </article>
          ))}
        </div>
      )}

      {shown && view === "list" && shown.length > 0 && (
        <div className={gallery.listCard}>
          <div className={gallery.listHead} aria-hidden>
            <span className={gallery.colThumb} />
            <span className={gallery.colName}>Map name</span>
            <span className={gallery.colMeta}>Layers</span>
            <span className={gallery.colState}>Status</span>
            <span className={gallery.colWhen}>Last edited</span>
            <span className={gallery.colActs} />
          </div>
          {shown.map((m) => (
            <div key={m.id} className={styles.listRowWrap}>
              <button
                className={gallery.listRow}
                onClick={() => router.push(`/maps/${m.id}`)}
                aria-label={`Open ${m.name}`}
              >
                <span className={`${gallery.colThumb} ${gallery.rowThumb}`}>
                  <MapStrip map={m} />
                </span>
                <span className={gallery.colName}>
                  <span className={gallery.rowName}>{m.name}</span>
                  {othersOwner(m) && (
                    <OwnerPill owner={othersOwner(m)!} placement="inline" />
                  )}
                </span>
                <span className={gallery.colMeta}>
                  <LayerDots colors={m.layerColors} />
                  <span className={gallery.num}>{m.layerCount}</span>{" "}
                  layer{m.layerCount === 1 ? "" : "s"}
                </span>
                <span className={gallery.colState}>
                  <StateChip live={m.published} />
                </span>
                <span className={`${gallery.colWhen} ${gallery.num}`}>
                  <LastChanged value={m} />
                </span>
                <span className={gallery.colActs} />
              </button>
              <span className={styles.listRowActs}>
                {quickActions(m, gallery.rowActs)}
              </span>
            </div>
          ))}
        </div>
      )}

      {shown && shown.length === 0 && (maps?.length ?? 0) > 0 && (
        <p className={gallery.empty}>No maps match. Clear the search or filters.</p>
      )}

      {maps && maps.length === 0 && view === "list" && (
        // Resolved-empty in list view is the same actionable state as the
        // grid's tile — the first action, not a prose shrug.
        <div className={gallery.emptyAction}>
          <button
            className={gallery.ghost}
            onClick={() => void createMap()}
            disabled={creating}
          >
            <span className={gallery.plus}>
              <PlusIcon />
            </span>
            <b>New map</b>
            <small>
              {tileSubLine(
                "map",
                scope,
                scope.kind === "project"
                  ? (world?.projects.find((x) => x.id === scope.id)?.name ?? null)
                  : null,
              )}
            </small>
          </button>
        </div>
      )}
      </>
      )}
      </AsyncState>
      </div>

      {filing && (
        <AddToProjectDialog
          subject={{
            kind: "map",
            id: filing.id,
            name: filing.name,
            projectId: filing.projectId,
            editRevision: filing.editRevision,
          }}
          onClose={() => setFiling(null)}
          onWithdrawn={({ projectIds, refusal }) => {
            const mapId = filing.id;
            setFiling(null);
            // Out of a project one no longer reaches: in no project now,
            // before the reconciling read answers and whether or not it does.
            const out = (x: MapOverview) =>
              x.id === mapId && x.projectId !== null && projectIds.includes(x.projectId)
                ? { ...x, projectId: null }
                : x;
            mutate((w) => ({ ...w, all: w.all.map(out), scoped: w.scoped.map(out) }));
            if (refusal) setActionError(refusal);
            else setFiledNote(`${filing.name} taken out of ${unreachedProjects(projectIds.length)}.`);
            void refresh().catch(() => {});
          }}
          onDone={({ projectId, projectName }) => {
            const mapId = filing.id;
            const moved = !!filing.projectId;
            setFiling(null);
            // The immediate truth (the mutation succeeded even if the
            // reconciling read fails): the map's own fact changes, and
            // a scope that no longer holds the map loses it.
            mutate((w) => ({
              ...w,
              // A NEW destination joins the directory too, so the tag
              // and the filter can name it even if the reconciling
              // read fails.
              projects: w.projects.some((p) => p.id === projectId)
                ? w.projects
                : [{ id: projectId, name: projectName }, ...w.projects],
              all: w.all.map((x) =>
                x.id === mapId ? { ...x, projectId } : x,
              ),
              scoped:
                scope.kind === "all"
                  ? w.scoped.map((x) =>
                      x.id === mapId ? { ...x, projectId } : x,
                    )
                  : w.scoped.filter((x) => x.id !== mapId),
            }));
            setFiledNote(
              `${filing.name} ${moved ? "moved" : "added"} to ${projectName}.`,
            );
            // Reconcile counts, memberships and the directory quietly.
            void refresh().catch(() => {});
          }}
        />
      )}
    </div>
  );
}
