/** Additive document facts. Older writers may omit these nullable columns;
 * insert defaults also cover identities created while running older code.
 * Existing actors stay unknown, independent of ownership or SQL home.
 * The final addition keeps all initialization inside one migration entry. */
export const REVISIONS_MIGRATION = `
  ALTER TABLE maps ADD COLUMN edit_revision TEXT;
  ALTER TABLE maps ADD COLUMN last_changed_at TEXT;
  ALTER TABLE maps ADD COLUMN last_changed_by TEXT REFERENCES accounts(id);
  UPDATE maps SET edit_revision = lower(hex(randomblob(16))), last_changed_at = updated_at;

  ALTER TABLE recipes ADD COLUMN edit_revision TEXT;
  ALTER TABLE recipes ADD COLUMN last_changed_at TEXT;
  ALTER TABLE recipes ADD COLUMN last_changed_by TEXT REFERENCES accounts(id);
  ALTER TABLE recipes ADD COLUMN executable_revision TEXT;
  UPDATE recipes SET edit_revision = lower(hex(randomblob(16))), last_changed_at = updated_at,
    executable_revision = lower(hex(randomblob(16)));

  CREATE TRIGGER maps_revision_default AFTER INSERT ON maps
    WHEN NEW.edit_revision IS NULL
    BEGIN
      UPDATE maps SET edit_revision = lower(hex(randomblob(16))),
        last_changed_at = COALESCE(last_changed_at, updated_at) WHERE id = NEW.id;
    END;
  CREATE TRIGGER recipes_revision_default AFTER INSERT ON recipes
    WHEN NEW.edit_revision IS NULL OR NEW.executable_revision IS NULL
    BEGIN
      UPDATE recipes SET edit_revision = COALESCE(edit_revision, lower(hex(randomblob(16)))),
        last_changed_at = COALESCE(last_changed_at, updated_at),
        executable_revision = COALESCE(executable_revision, lower(hex(randomblob(16)))) WHERE id = NEW.id;
    END;

  ALTER TABLE map_history ADD COLUMN author_id TEXT REFERENCES accounts(id);
  ALTER TABLE cascade_runs ADD COLUMN admitted_executable_revision TEXT;
`;
