/** Historical resource SQL; the catalogue preserves the migration order. */
export const DATASET_CONNECTION_MIGRATIONS = {
  // v1 — uploaded tables registry
  v1: `CREATE TABLE data_tables (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     source_filename TEXT NOT NULL,
     format TEXT NOT NULL,
     file TEXT NOT NULL,
     geometry_column TEXT,
     geometry_type TEXT,
     crs_assumed INTEGER NOT NULL DEFAULT 0,
     row_count INTEGER NOT NULL,
     created_at TEXT NOT NULL
   )`,
  // v13 — data hub: table provenance. Which source created the table, the
  // JSON parameters that can re-run the import, and when it last ran. Every
  // earlier row is an upload, which has no re-run recipe.
  v13: `ALTER TABLE data_tables ADD COLUMN source TEXT NOT NULL DEFAULT 'upload';
   ALTER TABLE data_tables ADD COLUMN source_params TEXT;
   ALTER TABLE data_tables ADD COLUMN imported_at TEXT;`,
  // v14 — PostGIS connections: the first stored credential. The password
  // column holds an AES-256-GCM envelope, never plaintext, and no
  // repository read ever returns it.
  v14: `CREATE TABLE pg_connections (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     host TEXT NOT NULL,
     port INTEGER NOT NULL,
     database TEXT NOT NULL,
     username TEXT NOT NULL,
     password_encrypted TEXT NOT NULL,
     ssl INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL
   )`,
  // v25 — a derived table has no source filename. Every registration road
  // until now was an import, so the column was NOT NULL and every caller had
  // a real filename to give. An operation's output never arrived as a file,
  // and the gate refused filler: a field that states something untrue about
  // how a dataset came to exist is worse than an absent one. SQLite cannot
  // drop a NOT NULL in place, so the table is rebuilt — the only structural
  // change is that one column becoming nullable.
  v25: `CREATE TABLE data_tables_v25 (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     source_filename TEXT,
     format TEXT NOT NULL,
     file TEXT NOT NULL,
     geometry_column TEXT,
     geometry_type TEXT,
     crs_assumed INTEGER NOT NULL DEFAULT 0,
     row_count INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT 'upload',
     source_params TEXT,
     imported_at TEXT
   );
   INSERT INTO data_tables_v25
     (id, name, source_filename, format, file, geometry_column, geometry_type,
      crs_assumed, row_count, created_at, source, source_params, imported_at)
   SELECT
      id, name, source_filename, format, file, geometry_column, geometry_type,
      crs_assumed, row_count, created_at, source, source_params, imported_at
   FROM data_tables;
   DROP TABLE data_tables;
   ALTER TABLE data_tables_v25 RENAME TO data_tables;`,
  // The suspect-header warning: advisory, computed on the CSV road at
  // import/refresh time. Default 0 — existing tables stay unwarned
  // until a refresh re-reads their source.
  v32: `ALTER TABLE data_tables ADD COLUMN header_suspect INTEGER NOT NULL DEFAULT 0;`,
  // v36 — durable PostGIS connection status: the last real source use is
  // remembered without credentials. Legacy connections have never been
  // checked as far as the durable record can honestly say.
  v36: `ALTER TABLE pg_connections ADD COLUMN last_checked_at TEXT;
   ALTER TABLE pg_connections ADD COLUMN last_check_outcome TEXT;
   ALTER TABLE pg_connections ADD COLUMN last_check_error TEXT;
   ALTER TABLE pg_connections ADD COLUMN server_version TEXT;
   ALTER TABLE pg_connections ADD COLUMN postgis_version TEXT;`,
  // v39 — CSV recognition evidence, swapped with each artifact. No
  // backfill: legacy rows carry no invented recognition provenance.
  v39: `ALTER TABLE data_tables ADD COLUMN geometry_recognition TEXT;`,
};
