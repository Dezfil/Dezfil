"use client";
import { useEffect, useState } from "react";
import type { ApiToken } from "@/lib/metadata/auth-credentials";
import type { CustomPalette } from "@/lib/metadata/palettes";
import { readExternalMode } from "@/components/auth/external-mode";
import { normalizeLook } from "@/lib/look";
import { accountRequest } from "./api";
import { INSTANCE_SETTINGS, type InstanceRead } from "./instance-read";
import type { EntryValues, IndexSources } from "./settings-index";

export type SearchSources = Partial<Omit<IndexSources, "account">>;

/** The reads a search draws on beyond the account: the person's tokens
 * and look, the sign-in mode, and the configuration, health and palette reads
 * for an admin or the entry read for a member. Never a read this person may not
 * make. */
function readsFor(admin: boolean): [keyof SearchSources, () => Promise<unknown>][] {
  const tokens: [keyof SearchSources, () => Promise<unknown>] = ["tokens", () => accountRequest<{ tokens: ApiToken[] }>("/api/account/tokens").then(body => body.tokens)];
  const look: [keyof SearchSources, () => Promise<unknown>] = ["look", () => accountRequest<{ look?: unknown }>("/api/settings").then(body => normalizeLook(body.look))];
  const external: [keyof SearchSources, () => Promise<unknown>] = ["external", readExternalMode];
  if (!admin) return [tokens, look, external, ["entry", () => accountRequest<EntryValues>("/api/auth/entry")]];
  return [
    tokens,
    look,
    external,
    ["instance", () => accountRequest<InstanceRead>(INSTANCE_SETTINGS)],
    ["health", () => fetch("/api/health", { cache: "no-store" }).then(response => response.ok ? "ready" : "unready", () => "unready")],
    ["palettes", () => accountRequest<{ custom: CustomPalette[] }>("/api/palettes").then(body => body.custom)],
  ];
}

interface Found { readonly session: number; readonly sources: SearchSources; readonly settled: number }

/**
 * What one search reads, afresh each time a search starts (`session`
 * counts the searches; 0 is none), so it finds what the tabs hold now.
 * A read that fails leaves its tab's rows out; the rest still answer.
 */
export function useSearchSources(session: number, admin: boolean): { sources: SearchSources; loading: boolean } {
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const settle = (key: keyof SearchSources, value?: unknown) => {
      if (cancelled) return;
      setFound(current => {
        const base = current?.session === session ? current : { session, sources: {}, settled: 0 };
        return { session, sources: value === undefined ? base.sources : { ...base.sources, [key]: value }, settled: base.settled + 1 };
      });
    };
    for (const [key, read] of readsFor(admin)) read().then(value => settle(key, value), () => settle(key));
    return () => { cancelled = true; };
  }, [session, admin]);
  const current = found?.session === session ? found : null;
  return { sources: current?.sources ?? {}, loading: !!session && (current?.settled ?? 0) < readsFor(admin).length };
}
