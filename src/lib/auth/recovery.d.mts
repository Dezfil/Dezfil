export const RECOVERY_LIFETIME_MS: number;
export function recoverAdmin(input: { dataDir: string; origin: string; email?: string }, now?: number): {
  account: { id: string; email: string }; expiresAt: number; url: string;
};
