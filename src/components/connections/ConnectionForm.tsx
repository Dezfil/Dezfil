"use client";

import { useState } from "react";
import type { PgConnection } from "@/lib/metadata/connections";
import {
  connectionEndpointsEqual,
  ConnectionInputError,
  parseConnectionUrl,
  resolveCreateConnectionInput,
  resolveUpdateConnectionInput,
} from "@/lib/postgis/connection-input";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { readApiError } from "@/components/api";
import { shortServerVersion } from "./connection-view";
import { serverUnreachable } from "@/components/failure-copy";
import { CheckIcon, WarnIcon } from "@/components/ui/icons";
import styles from "./ConnectionForm.module.css";

export interface ConnectionFormFields {
  name: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

type Phase =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "error"; message: string }
  | { kind: "saved"; connection: PgConnection };

const EMPTY: ConnectionFormFields = {
  name: "",
  host: "",
  port: "5432",
  database: "",
  username: "",
  password: "",
  ssl: true,
};

function fieldsOf(connection?: PgConnection): ConnectionFormFields {
  return connection
    ? {
        name: connection.name,
        host: connection.host,
        port: String(connection.port),
        database: connection.database,
        username: connection.username,
        password: "",
        ssl: connection.ssl,
      }
    : EMPTY;
}

export function repointPasswordRequirement(
  mode: "add" | "edit",
  fields: ConnectionFormFields,
  connection?: PgConnection,
): { required: boolean; placeholder?: string } {
  if (
    mode === "edit" &&
    connection &&
    (
      !connectionEndpointsEqual(
        { host: fields.host, port: Number(fields.port) },
        connection,
      ) ||
      (connection.ssl && !fields.ssl)
    )
  ) {
    return {
      required: true,
      placeholder: ERROR_CATALOGUE.connection_password_required,
    };
  }
  return {
    required: false,
    placeholder:
      mode === "edit" ? "Leave blank to keep the stored one" : undefined,
  };
}

class ConnectionFormResponseError extends Error {}

/** Validate locally, then begin the one API request used by both placements. */
export function beginConnectionFormRequest(
  mode: "add" | "edit",
  fields: ConnectionFormFields,
  connection?: PgConnection,
  send: typeof fetch = fetch,
): Promise<PgConnection> {
  const body = {
    name: fields.name,
    host: fields.host,
    port: fields.port,
    database: fields.database,
    username: fields.username,
    password: fields.password,
    ssl: fields.ssl,
  };
  if (mode === "add") {
    resolveCreateConnectionInput(body);
  } else if (connection) {
    const resolved = resolveUpdateConnectionInput(body, {
      ...fieldsOf(connection),
      port: connection.port,
      password: "stored-password",
    });
    if (resolved.passwordReentryRequired) {
      throw new ConnectionInputError(
        ERROR_CATALOGUE.connection_password_required,
      );
    }
  } else {
    throw new ConnectionInputError("The connection details are invalid.");
  }

  const endpoint =
    mode === "edit" && connection
      ? `/api/connections/postgis/${connection.id}`
      : "/api/connections/postgis";
  return send(endpoint, {
    method: mode === "edit" ? "PATCH" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => {
    if (!response.ok) {
      throw new ConnectionFormResponseError(await readApiError(response));
    }
    return (await response.json()) as PgConnection;
  });
}

export function ConnectionForm({
  mode,
  connection,
  layout = "grid",
  title = true,
  cancelLabel = "Cancel",
  refusal = null,
  onCancel,
  onSaved,
}: {
  mode: "add" | "edit";
  connection?: PgConnection;
  layout?: "grid" | "stacked";
  title?: boolean;
  cancelLabel?: string;
  /** The instance rule's sentence while it holds back adding a connection:
   * a new one is drawn disabled, and a saved one keeps everything but
   * what would point it at another host, port or database. */
  refusal?: string | null;
  onCancel?: () => void;
  onSaved: (connection: PgConnection) => void;
}) {
  const initial = fieldsOf(connection);
  const [fields, setFields] = useState<ConnectionFormFields>(() => initial);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [urlOpen, setUrlOpen] = useState(mode === "add");
  const [url, setUrl] = useState("");
  const [urlMessage, setUrlMessage] = useState("");
  const [urlInvalid, setUrlInvalid] = useState(false);

  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  const busy = phase.kind === "testing";
  const saved = phase.kind === "saved";
  const held = refusal !== null;
  const heldNew = held && mode === "add";

  const change = <K extends keyof ConnectionFormFields>(field: K, value: ConnectionFormFields[K]) => {
    setFields((current) => ({ ...current, [field]: value }));
    if (phase.kind === "error" || phase.kind === "saved") {
      setPhase({ kind: "idle" });
    }
  };

  const fillUrl = (value: string) => {
    setUrl(value);
    if (!value.trim()) {
      setUrlMessage("");
      setUrlInvalid(false);
      return;
    }
    try {
      const parsed = parseConnectionUrl(value);
      const filled = ["host", "database", "username", "password"].filter(
        (field) => parsed[field as keyof typeof parsed],
      ).length + (parsed.port ? 1 : 0);
      setFields((current) => {
        const next = { ...current };
        for (const field of ["host", "database", "username", "password"] as const) {
          if (parsed[field] !== undefined && parsed[field] !== "") {
            next[field] = parsed[field] as string;
          }
        }
        if (parsed.port) {
          next.port = parsed.port;
        }
        if (parsed.ssl !== undefined) next.ssl = parsed.ssl;
        return next;
      });
      setUrlInvalid(false);
      const sslMessage = parsed.ssl === undefined
        ? ""
        : parsed.ssl
          ? ", SSL required"
          : ", SSL not required";
      setUrlMessage(
        `Filled ${filled} field${filled === 1 ? "" : "s"} from the URL${sslMessage}. Check them, then test.`,
      );
      setPhase({ kind: "idle" });
    } catch (error) {
      setUrlInvalid(true);
      setUrlMessage(
        error instanceof ConnectionInputError
          ? error.message
          : "That does not look like a Postgres URL.",
      );
    }
  };

  const submit = async () => {
    let pending: Promise<PgConnection>;
    try {
      pending = beginConnectionFormRequest(mode, fields, connection);
    } catch (error) {
      setPhase({
        kind: "error",
        message:
          error instanceof Error ? error.message : "The connection details are invalid.",
      });
      return;
    }

    setPhase({ kind: "testing" });
    try {
      const created = await pending;
      setFields((current) => ({ ...current, password: "" }));
      setUrl("");
      setPhase({ kind: "saved", connection: created });
      window.setTimeout(
        () => onSaved(created),
        created.status === "no_postgis" ? 900 : 500,
      );
    } catch (error) {
      setPhase({
        kind: "error",
        message:
          error instanceof ConnectionFormResponseError
            ? error.message
            : serverUnreachable("save the connection"),
      });
    }
  };

  const result = phase.kind === "saved" ? phase.connection : null;
  const passwordRequirement = repointPasswordRequirement(
    mode,
    fields,
    connection,
  );

  return (
    <div className={styles.form} data-layout={layout}>
      {title ? (
        <h2>{mode === "edit" ? `Edit ${connection?.name ?? "connection"}` : "Connect a PostGIS database"}</h2>
      ) : null}

      {urlOpen ? (
        <div className={styles.urlBox}>
          <label className={styles.field}>
            <span>
              Paste a connection URL <em>optional</em>
            </span>
            <input
              className={styles.mono}
              value={url}
              disabled={held}
              onChange={(event) => fillUrl(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="postgres://user:password@host:5432/database?sslmode=require"
            />
          </label>
          {urlMessage ? (
            <div className={styles.urlMessage} data-invalid={urlInvalid || undefined}>
              {!urlInvalid ? <CheckIcon /> : null}
              {urlMessage}
            </div>
          ) : null}
        </div>
      ) : (
        <button className={styles.urlLink} type="button" disabled={held} onClick={() => setUrlOpen(true)}>
          Paste a new connection URL
        </button>
      )}

      <div className={styles.grid}>
        <Field label="Connection name" wide>
          <input value={fields.name} disabled={heldNew} onChange={(event) => change("name", event.target.value)} placeholder="City geodata" />
        </Field>
        <Field label="Host" wide>
          <input className={styles.mono} value={fields.host} disabled={held} onChange={(event) => change("host", event.target.value)} spellCheck={false} placeholder="db.example.org" />
        </Field>
        <Field label="Port">
          <input className={styles.mono} value={fields.port} disabled={held} onChange={(event) => change("port", event.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Database">
          <input className={styles.mono} value={fields.database} disabled={held} onChange={(event) => change("database", event.target.value)} spellCheck={false} />
        </Field>
        <Field label="Username">
          <input className={styles.mono} value={fields.username} disabled={heldNew} onChange={(event) => change("username", event.target.value)} spellCheck={false} />
        </Field>
        <Field label="Password">
          <input type="password" value={fields.password} disabled={heldNew} onChange={(event) => change("password", event.target.value)} placeholder={passwordRequirement.placeholder} required={passwordRequirement.required} autoComplete="new-password" />
        </Field>
      </div>

      <label className={styles.check}>
        <input type="checkbox" checked={fields.ssl} disabled={heldNew} onChange={(event) => change("ssl", event.target.checked)} />
        Require SSL for this connection
      </label>
      {!fields.ssl ? <p className={styles.sslNote}>SSL is not required. The server may still encrypt the connection.</p> : null}
      <p className={styles.note}>Use a read-only database user. The password is stored encrypted and never shown again.</p>
      {refusal ? <p className={styles.note}>{refusal}</p> : null}

      {phase.kind === "error" ? (
        <div className={styles.error} role="alert"><WarnIcon /> <span>{phase.message}</span></div>
      ) : null}

      <div className={styles.actions}>
        <button className={styles.primary} type="button" onClick={() => void submit()} disabled={busy || saved || heldNew || (mode === "edit" && !dirty)}>
          {busy ? "Testing…" : saved ? "Saved" : mode === "edit" ? "Test & save changes" : "Test & save connection"}
        </button>
        {onCancel ? <button className={styles.secondary} type="button" onClick={onCancel}>{cancelLabel}</button> : null}
        <div className={styles.result} aria-live="polite">
          {busy ? <><span className={styles.spinner} /> Connecting to {fields.host || "the server"}…</> : null}
          {result?.status === "connected" ? <span data-state="ok"><CheckIcon /> Connected · {shortServerVersion(result.serverVersion)} · PostGIS {result.postgisVersion}</span> : null}
          {result?.status === "no_postgis" ? <span data-state="warn"><WarnIcon /> Connected · {shortServerVersion(result.serverVersion)} · PostGIS not installed: only attribute tables can be imported</span> : null}
        </div>
      </div>
    </div>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={styles.field} data-wide={wide || undefined}>
      <span>{label}</span>
      {children}
    </label>
  );
}
