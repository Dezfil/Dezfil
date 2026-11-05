/** Instance recovery history survives account deletion. BIGINT keeps the
 * insertion rowid separate from the value, including for lower resets. */
export const DOOR_GENERATION_RESET_MIGRATION = `
  CREATE TABLE auth_door_generation_resets (
    value BIGINT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL
  );
`;
