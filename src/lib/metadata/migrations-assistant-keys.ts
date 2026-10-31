/** One key per account. The text is an encrypted envelope; the last four
 * characters and the time it was saved are the only readable facts. */
export const ASSISTANT_KEYS_MIGRATION = `
  CREATE TABLE assistant_keys (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
    key_encrypted TEXT NOT NULL,
    last_four TEXT NOT NULL,
    saved_at INTEGER NOT NULL
  );
`;
