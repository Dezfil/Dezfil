import type { Database } from "better-sqlite3";
export function compactMetadataStore(db: Database): { elapsedMs: number; walBytes: number };
