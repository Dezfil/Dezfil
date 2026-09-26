/** Test-only independent observer/fixture connection. Product operations in the
 * live tests still use the production parser, egress and attachment path. */
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";

export const pgLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;
const pqLiteral = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
export function fixtureUrl(base: string, mode: string): string {
  const url = new URL(base);
  url.searchParams.delete("sslmode");
  url.searchParams.set("sslmode", mode);
  return url.toString();
}

export async function openSource(base: string) {
  const url = new URL(base);
  const alias = `fixture_${randomUUID().replace(/-/g, "")}`;
  // Independently controlled setup/observer transport, never evidence of the
  // tested operation's TLS request. Prefer works on both fixtures.
  const dsn = [
    `host=${pqLiteral(url.hostname)}`, `port=${url.port || 5432}`,
    `dbname=${pqLiteral(decodeURIComponent(url.pathname.slice(1)) || "postgres")}`,
    `user=${pqLiteral(decodeURIComponent(url.username))}`,
    `password=${pqLiteral(decodeURIComponent(url.password))}`,
    "sslmode=prefer connect_timeout=10 options='-c statement_timeout=10000'",
  ].join(" ");
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await conn.run("INSTALL postgres; LOAD postgres;");
    await conn.run(`ATTACH ${pgLiteral(dsn)} AS ${alias} (TYPE postgres)`);
  } catch (error) { conn.disconnectSync(); instance.closeSync(); throw error; }
  return {
    conn,
    async query(sql: string): Promise<Record<string, unknown>[]> {
      const read = await conn.runAndReadAll(`SELECT * FROM postgres_query(${pgLiteral(alias)}, ${pgLiteral(sql)})`);
      return read.getRowObjectsJson();
    },
    async exec(sql: string) { await conn.run(`CALL postgres_execute(${pgLiteral(alias)}, ${pgLiteral(sql)})`); },
    async close() {
      try { await conn.run(`DETACH ${alias}`); }
      finally { conn.disconnectSync(); instance.closeSync(); }
    },
  };
}
export type SourceFixture = Awaited<ReturnType<typeof openSource>>;
export interface AttachmentObservation {
  conn: DuckDBConnection;
  mode: string | undefined;
  identity: string | undefined;
  timeout: string | undefined;
  released: boolean;
}

/** Observe only whitelisted options from the actual native ATTACH call.
 * Neither observations nor assertion messages contain a DSN or password. */
export function watchAttachments() {
  const attempts: AttachmentObservation[] = [];
  const originalRun = DuckDBConnection.prototype.run;
  const originalDisconnect = DuckDBConnection.prototype.disconnectSync;
  const run = vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(function (this: DuckDBConnection, sql, ...args) {
    if (/^ATTACH .* AS pg_[a-f0-9]+ \(TYPE postgres, READ_ONLY\)$/.test(sql)) {
      attempts.push({
        conn: this, mode: sql.match(/\bsslmode=(\w+)/)?.[1],
        identity: sql.match(/application_name=''([a-z0-9_]+)''/)?.[1],
        timeout: sql.match(/statement_timeout=(\d+)/)?.[1], released: false,
      });
    }
    return originalRun.call(this, sql, ...args);
  });
  const disconnect = vi.spyOn(DuckDBConnection.prototype, "disconnectSync").mockImplementation(function (this: DuckDBConnection) {
    for (const attempt of attempts) if (attempt.conn === this) attempt.released = true;
    return originalDisconnect.call(this);
  });
  return { attempts, restore() { run.mockRestore(); disconnect.mockRestore(); } };
}
