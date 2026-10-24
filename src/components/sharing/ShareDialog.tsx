"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { ErrorNote } from "../ui/ErrorNote";
import { CheckIcon, ChevronIcon, PlugIcon, XIcon } from "../ui/icons";
import { Menu, MenuItem } from "../ui/Menu";
import { Face } from "../people/Face";
import { initials, type PersonLabel, type ProjectPersonWire } from "./people";
import { findPeople, readPeople, removePerson, setRole, transferProject } from "./share-client";
import {
  connectionLines,
  everythingLine,
  listNames,
  missLine,
  orderedPeople,
  roleTitle,
  roleWithArticle,
  transferable,
  USERS_LINE,
  type ConnectionBound,
  type MemberRole,
} from "./share-model";
import { useSignedInSqlName } from "./signed-in";
import { invalidateProjectPeople } from "./use-project-people";
import styles from "./ShareDialog.module.css";

/**
 * The share dialog, one sheet: the people field with the Viewer or Editor
 * choice and Add on top, the directory searched behind it; the project's
 * people below, its owner pinned first, each with a role menu and a remove
 * revealed on hover or focus, a deactivated member dimmed and marked; the
 * hand-over revealed under the owner's row from its menu or a member's
 * "Make owner", with its one confirming sentence; and the quiet line naming
 * a dataset that refreshes through one of the owner's connections. Thin
 * over the API: every change is the API's, every refusal its words.
 */

const SEARCH_MS = 150;

interface Status {
  text: ReactNode;
  undo?: () => void;
}

export function ShareDialog({
  projectId,
  projectName,
  counts,
  tables,
  onClose,
  onTransferred,
}: {
  projectId: string;
  projectName: string;
  counts: { maps: number; workflows: number; datasets: number };
  /** The project's datasets: those of the owner's that refresh through a
   * connection get their line. */
  tables: readonly ConnectionBound[];
  onClose: () => void;
  /** The project now has another owner; the sentence says who. */
  onTransferred: (sentence: string) => void;
}) {
  const me = useSignedInSqlName();
  const [people, setPeople] = useState<ProjectPersonWire[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ for: string; people: PersonLabel[] } | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<PersonLabel[]>([]);
  const [role, setRoleChoice] = useState<MemberRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handOver, setHandOver] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const resultsId = useId();

  useEffect(() => {
    let cancelled = false;
    readPeople(projectId).then(
      (answer) => {
        if (!cancelled) setPeople(answer);
      },
      (e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);

  // The directory, behind the field: the newest query's answer only.
  const typed = query.trim();
  useEffect(() => {
    if (typed === "") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      findPeople(typed).then(
        (answer) => {
          if (!cancelled) setFound({ for: typed, people: answer });
        },
        (e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        },
      );
    }, SEARCH_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [typed]);

  const held = useMemo(() => new Map((people ?? []).map((p) => [p.sqlName, p])), [people]);
  const hits = found && found.for === typed ? found.people : null;
  const rows = (hits ?? []).map((person) => {
    const holder = held.get(person.sqlName);
    const state = holder
      ? holder.role === "owner"
        ? "Owner"
        : roleTitle(holder.role)
      : picked.some((p) => p.sqlName === person.sqlName)
        ? "On the list"
        : null;
    return { person, state };
  });
  const addable = rows.filter((r) => r.state === null);

  /** A change landed: the people as the API now answers them, and every
   * mark that counts them re-reads. */
  const landed = useCallback((next: ProjectPersonWire[], said: Status | null) => {
    setPeople(next);
    setStatus(said);
    setError(null);
    invalidateProjectPeople();
  }, []);

  const pick = (person: PersonLabel) => {
    setPicked((list) => (list.some((p) => p.sqlName === person.sqlName) ? list : [...list, person]));
    setQuery("");
    setFound(null);
    setResultsOpen(false);
    setActive(0);
    field.current?.focus();
  };

  const add = async () => {
    if (busy || picked.length === 0) return;
    setBusy(true);
    const added: string[] = [];
    let next: ProjectPersonWire[] | null = null;
    try {
      for (const person of picked) {
        next = await setRole(projectId, person.sqlName, role);
        added.push(person.name);
      }
      landed(next!, { text: <>Added <b>{listNames(added)}</b> as {roleTitle(role)}.</> });
      setPicked([]);
    } catch (e) {
      if (next) landed(next, added.length ? { text: <>Added <b>{listNames(added)}</b> as {roleTitle(role)}.</> } : null);
      setPicked((list) => list.filter((p) => !added.includes(p.name)));
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const change = async (person: ProjectPersonWire, to: MemberRole) => {
    if (busy || person.role === to) return;
    setBusy(true);
    try {
      landed(await setRole(projectId, person.sqlName, to), { text: <><b>{person.name}</b> is now {roleWithArticle(to)}.</> });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (person: ProjectPersonWire) => {
    if (busy || person.role === "owner") return;
    setBusy(true);
    const was = person.role;
    try {
      const next = await removePerson(projectId, person.sqlName);
      // Undo puts an active person back with the role they held; a
      // deactivated one could not be given a role again.
      const undo = person.deactivated ? undefined : () => void restore(person, was);
      landed(next, { text: <>Removed <b>{person.name}</b>.</>, undo });
      if (handOver === person.sqlName) setHandOver(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (person: PersonLabel, was: MemberRole) => {
    if (busy) return;
    setBusy(true);
    try {
      landed(await setRole(projectId, person.sqlName, was), null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handOverTo = async () => {
    const to = handOver ? held.get(handOver) : undefined;
    if (busy || !to) return;
    setBusy(true);
    try {
      await transferProject(projectId, to.sqlName);
      invalidateProjectPeople();
      onTransferred(`${to.name} owns ${projectName} now.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const ordered = people ? orderedPeople(people) : [];
  const eligible = people ? transferable(people) : [];
  const recipient = handOver ? held.get(handOver) : undefined;
  const lines = connectionLines(tables, me);
  const showResults = resultsOpen && typed !== "" && hits !== null;

  return (
    <Dialog label={`Share ${projectName}`} onClose={onClose} className={styles.dialog} data-share-dialog>
      <div className={styles.head}>
        <span className={styles.title}>
          Share <strong>{projectName}</strong>
        </span>
        <small>{everythingLine(counts)}</small>
      </div>
      <div className={styles.body}>
        <div className={styles.addRow}>
          <label className={styles.pick}>
            {picked.map((person) => (
              <span key={person.sqlName} className={styles.token} data-picked={person.sqlName}>
                <Face person={person} letters={initials(person.name)} className={styles.avatar} />
                {person.name}
                <button
                  type="button"
                  aria-label={`Take ${person.name} off the list`}
                  onClick={() => setPicked((list) => list.filter((p) => p.sqlName !== person.sqlName))}
                >
                  <XIcon />
                </button>
              </span>
            ))}
            <input
              ref={field}
              type="text"
              value={query}
              placeholder={picked.length ? "" : "Add people by name or email"}
              aria-label="Add people by name or email"
              autoComplete="off"
              role="combobox"
              aria-controls={resultsId}
              aria-expanded={showResults}
              onChange={(e) => {
                setQuery(e.target.value);
                setResultsOpen(true);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (addable.length === 0) return;
                  setActive((i) => (i + (e.key === "ArrowDown" ? 1 : addable.length - 1)) % addable.length);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (showResults && addable[active]) pick(addable[active].person);
                  else void add();
                } else if (e.key === "Backspace" && query === "" && picked.length > 0) {
                  setPicked((list) => list.slice(0, -1));
                } else if (e.key === "Escape" && showResults) {
                  // The results close; the dialog stays.
                  e.preventDefault();
                  e.stopPropagation();
                  setResultsOpen(false);
                }
              }}
            />
          </label>
          <span className={styles.roles} role="group" aria-label="Role">
            {(["viewer", "editor"] as const).map((r) => (
              <button key={r} type="button" aria-pressed={role === r} onClick={() => setRoleChoice(r)}>
                {roleTitle(r)}
              </button>
            ))}
          </span>
          <Button variant="primary" className={styles.addBtn} disabled={picked.length === 0} busy={busy && picked.length > 0} onClick={() => void add()}>
            Add
          </Button>
          {showResults && (
            <div id={resultsId} className={styles.results} data-share-results>
              {rows.length === 0 ? (
                <div className={styles.miss} role="status" data-share-miss>
                  <b>{missLine(typed)}</b>
                  <span>{USERS_LINE}</span>
                </div>
              ) : (
                <div role="listbox" aria-label="People">
                  {rows.map(({ person, state }) => (
                    <button
                      key={person.sqlName}
                      type="button"
                      role="option"
                      aria-selected={state === null && addable[active]?.person.sqlName === person.sqlName}
                      className={styles.result}
                      disabled={state !== null}
                      data-active={(state === null && addable[active]?.person.sqlName === person.sqlName) || undefined}
                      data-result={person.sqlName}
                      onClick={() => pick(person)}
                    >
                      <Who person={person} small />
                      {state && <span className={styles.resultTail}>{state}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
        {loadError && (
          <ErrorNote
            message={loadError}
            onRetry={() => {
              setLoadError(null);
              setAttempt((n) => n + 1);
            }}
          />
        )}

        {people && (
          <>
            <div className={styles.listHead}>
              People with access <small>{ordered.length}</small>
            </div>
            <div className={styles.members} data-share-members>
              {ordered.map((person) => (
                <MemberRow
                  key={person.sqlName}
                  person={person}
                  me={me}
                  canHandOver={eligible.length > 0}
                  busy={busy}
                  onRole={(to) => void change(person, to)}
                  onRemove={() => void remove(person)}
                  onHandOver={() => setHandOver(person.role === "owner" ? (eligible[0]?.sqlName ?? null) : person.sqlName)}
                >
                  {person.role === "owner" && recipient && (
                    <div className={styles.handOver} data-hand-over>
                      <div className={styles.handOverLine}>
                        Make
                        <select
                          className={styles.select}
                          aria-label="New owner"
                          value={recipient.sqlName}
                          onChange={(e) => setHandOver(e.target.value)}
                        >
                          {eligible.map((p) => (
                            <option key={p.sqlName} value={p.sqlName}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        the owner
                      </div>
                      <p>
                        {recipient.name.split(/\s+/)[0]} becomes the owner of {projectName}. You stay as Editor. Items keep their owners.
                      </p>
                      <div className={styles.handOverActs}>
                        <Button variant="quiet" onClick={() => setHandOver(null)} disabled={busy}>
                          Cancel
                        </Button>
                        <Button variant="primary" busy={busy} onClick={() => void handOverTo()} data-hand-over-confirm>
                          Transfer ownership
                        </Button>
                      </div>
                    </div>
                  )}
                </MemberRow>
              ))}
            </div>
            {lines.map((line) => (
              <p key={line.connection} className={styles.note} data-connection-line>
                <PlugIcon />
                <span>
                  <b>{listNames(line.datasets)}</b> {line.datasets.length === 1 ? "refreshes" : "refresh"} from your{" "}
                  <b>{line.connection}</b> connection. Only you can refresh {line.datasets.length === 1 ? "it" : "them"}.
                </span>
              </p>
            ))}
          </>
        )}
      </div>
      <div className={styles.foot}>
        <span className={styles.status} role="status">
          {status?.text}
          {status?.undo && (
            <button type="button" onClick={status.undo}>
              Undo
            </button>
          )}
        </span>
        <Button size="chrome" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}

/** A person as the Users ledger draws one: their face, the name, the SQL
 * name in mono beneath. */
function Who({
  person,
  you = false,
  deactivated = false,
  small = false,
}: {
  person: PersonLabel;
  you?: boolean;
  deactivated?: boolean;
  small?: boolean;
}) {
  return (
    <span className={styles.who} data-small={small || undefined}>
      <Face person={person} letters={initials(person.name)} className={styles.avatar} />
      <span className={styles.identity}>
        <b>
          <span className={styles.name}>{person.name}</span>
          {you && <span className={styles.you}>You</span>}
        </b>
        <small>
          <span className={styles.sqlName}>{person.sqlName}</span>
          {deactivated && <span>Deactivated</span>}
        </small>
      </span>
    </span>
  );
}

function MemberRow({
  person,
  me,
  canHandOver,
  busy,
  onRole,
  onRemove,
  onHandOver,
  children,
}: {
  person: ProjectPersonWire;
  me: string | null;
  canHandOver: boolean;
  busy: boolean;
  onRole: (role: MemberRole) => void;
  onRemove: () => void;
  onHandOver: () => void;
  children?: ReactNode;
}) {
  const owner = person.role === "owner";
  let roleCell: ReactNode;
  if (person.role === "owner") {
    roleCell = canHandOver ? (
      <RoleMenu person={person} current="Owner">
        <MenuItem onSelect={onHandOver}>
          <span className={styles.mark} />
          Transfer ownership…
        </MenuItem>
      </RoleMenu>
    ) : (
      <span className={styles.roleText}>Owner</span>
    );
  } else if (person.deactivated) {
    // A deactivated member's grant is inert and cannot be changed; their
    // row stays, marked, until the owner removes it.
    roleCell = <span className={styles.roleText}>{roleTitle(person.role)}</span>;
  } else {
    const role = person.role;
    roleCell = (
      <RoleMenu person={person} current={roleTitle(role)}>
        {(["viewer", "editor"] as const).map((r) => (
          <MenuItem key={r} onSelect={() => onRole(r)}>
            <span className={styles.mark}>{role === r ? <CheckIcon /> : null}</span>
            {roleTitle(r)}
          </MenuItem>
        ))}
        <hr className={styles.menuRule} />
        <MenuItem onSelect={onHandOver}>
          <span className={styles.mark} />
          Make owner
        </MenuItem>
      </RoleMenu>
    );
  }
  return (
    <>
      <div className={styles.row} data-off={person.deactivated || undefined} data-member={person.sqlName}>
        <Who person={person} you={person.sqlName === me} deactivated={person.deactivated} />
        <span className={styles.roleCell}>{roleCell}</span>
        {owner ? (
          <span className={styles.removeGap} />
        ) : (
          <button
            type="button"
            className={styles.remove}
            aria-label={`Remove ${person.name}`}
            disabled={busy}
            onClick={onRemove}
          >
            <XIcon />
          </button>
        )}
      </div>
      {children}
    </>
  );
}

function RoleMenu({ person, current, children }: { person: PersonLabel; current: string; children: ReactNode }) {
  return (
    <Menu
      label={`${person.name}'s role`}
      triggerLabel={`${person.name}, ${current}`}
      className={styles.roleWrap}
      triggerClassName={styles.roleBtn}
      menuClassName={styles.menu}
      trigger={
        <>
          {current}
          <ChevronIcon />
        </>
      }
    >
      {children}
    </Menu>
  );
}
