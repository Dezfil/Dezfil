const ownedTables = ["maps", "data_tables", "recipes", "pg_connections", "projects", "operation_jobs"];
const originalOwner = "(SELECT account_id FROM original_account WHERE singleton = 1)";
const stampOwners = ownedTables.map(table =>
  `UPDATE ${table} SET owner_id = ${originalOwner} WHERE owner_id IS NULL;`).join("\n");

/** Rebuild with foreign keys enabled. Save memberships before DROP cascades,
 * then restore them inside the same migration transaction. */
export const OWNERSHIP_MIGRATION = `
  CREATE TEMP TABLE ownership_guard (
    valid INTEGER CONSTRAINT "The original account is missing" CHECK (valid = 1)
  );
  INSERT INTO ownership_guard SELECT
    CASE WHEN NOT EXISTS (SELECT 1 FROM accounts) OR ${originalOwner} IS NOT NULL THEN 1 ELSE 0 END;
  DROP TABLE ownership_guard;

  CREATE TEMP TABLE ownership_memberships AS SELECT * FROM project_datasets;
  CREATE TABLE data_tables_owned (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
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
    imported_at TEXT,
    header_suspect INTEGER NOT NULL DEFAULT 0,
    geometry_recognition TEXT,
    owner_id TEXT REFERENCES accounts(id),
    UNIQUE (owner_id, name)
  );
  INSERT INTO data_tables_owned SELECT *, ${originalOwner} FROM data_tables;
  DROP TABLE data_tables;
  ALTER TABLE data_tables_owned RENAME TO data_tables;
  INSERT INTO project_datasets SELECT * FROM ownership_memberships;
  DROP TABLE ownership_memberships;

  CREATE TABLE pg_connections_owned (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    database TEXT NOT NULL,
    username TEXT NOT NULL,
    password_encrypted TEXT NOT NULL,
    ssl INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_checked_at TEXT,
    last_check_outcome TEXT,
    last_check_error TEXT,
    server_version TEXT,
    postgis_version TEXT,
    owner_id TEXT REFERENCES accounts(id),
    UNIQUE (owner_id, name)
  );
  INSERT INTO pg_connections_owned SELECT *, ${originalOwner} FROM pg_connections;
  DROP TABLE pg_connections;
  ALTER TABLE pg_connections_owned RENAME TO pg_connections;

  -- Keep global uniqueness until name-addressed callers accept account scope.
  CREATE UNIQUE INDEX idx_data_tables_name_transition ON data_tables(name);
  CREATE UNIQUE INDEX idx_pg_connections_name_transition ON pg_connections(name);
  ${["maps", "recipes", "projects", "operation_jobs"].map(table =>
    `ALTER TABLE ${table} ADD COLUMN owner_id TEXT REFERENCES accounts(id);`).join("\n")}
  ${stampOwners}
  ${ownedTables.map(table => `
    CREATE INDEX idx_${table}_owner ON ${table}(owner_id);
    CREATE TRIGGER ${table}_owner_required_insert BEFORE INSERT ON ${table}
      WHEN NEW.owner_id IS NULL AND EXISTS (SELECT 1 FROM original_account)
      BEGIN SELECT RAISE(ABORT, 'An owner is required'); END;
    CREATE TRIGGER ${table}_owner_active_insert BEFORE INSERT ON ${table}
      WHEN NEW.owner_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM accounts WHERE id = NEW.owner_id AND status != 'active'
      )
      BEGIN SELECT RAISE(ABORT, 'The owner must be active'); END;
    CREATE TRIGGER ${table}_owner_immutable BEFORE UPDATE OF owner_id ON ${table}
      WHEN (OLD.owner_id IS NOT NULL AND NEW.owner_id IS NOT OLD.owner_id)
        OR (NEW.owner_id IS NULL AND EXISTS (SELECT 1 FROM original_account))
        OR (OLD.owner_id IS NULL AND NEW.owner_id IS NOT ${originalOwner})
      BEGIN SELECT RAISE(ABORT, 'Ownership cannot change'); END;
  `).join("\n")}
  -- Setup already inserts this marker in its account/preferences/session
  -- transaction. A failure anywhere rolls back every owner stamp as well.
  CREATE TRIGGER original_account_adopt_ownership AFTER INSERT ON original_account
    BEGIN ${stampOwners} END;
`;

/** Name-addressed dataset services now select an explicit owner. */
export const DATASET_NAMES_MIGRATION = `DROP INDEX idx_data_tables_name_transition;`;
