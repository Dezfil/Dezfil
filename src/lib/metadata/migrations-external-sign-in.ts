/** Bound identities are profile data; ticket ids and generations are instance
 * revocation state and deliberately have no account foreign key. */
export const EXTERNAL_SIGN_IN_MIGRATION = `
  ALTER TABLE accounts ADD COLUMN external_identity TEXT CHECK (external_identity IS NULL OR status <> 'deleted');
  CREATE UNIQUE INDEX idx_accounts_external_identity ON accounts(external_identity);
  ALTER TABLE auth_sessions ADD COLUMN sign_out_generation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE auth_sessions ADD COLUMN door_generation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE auth_tokens ADD COLUMN sign_out_generation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE auth_tokens ADD COLUMN door_generation INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE auth_ticket_ids (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_auth_ticket_ids_expiry ON auth_ticket_ids(expires_at);
  CREATE TABLE auth_generations (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    sign_out_generation INTEGER NOT NULL DEFAULT 0 CHECK (sign_out_generation >= 0),
    door_generation INTEGER NOT NULL DEFAULT 0 CHECK (door_generation >= 0)
  );
  INSERT INTO auth_generations (singleton) VALUES (1);
`;
