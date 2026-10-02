import type { Database } from "better-sqlite3";
export const RECOVERY_SCHEMA_VERSION: number;
export const RECOVERY_BUSY_TIMEOUT_MS: number;
export function recoveryWaitRemaining(deadline: number): number;
export class RecoveryError extends Error {}
export function recoveryFailure(error: unknown): RecoveryError;
export function recoveryOrigin(value: string): string;
export function validateRecoveryStore(db: Database): void;
export function openRecoveryStore(directory: string, deadline?: number): Database;
export function selectRecoveryAdmin(db: Database, email?: string): { id: string; email: string };
