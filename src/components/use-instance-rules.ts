"use client";

import { useEffect, useState } from "react";
import { ruleRefusal, type RuleKey, type WhoMayRule } from "@/lib/settings/instance-rules";

/** What a screen knows of one instance rule and of the person reading it:
 * each null until its read answers, and null for good when it fails. */
interface RuleReads {
  readonly value: unknown;
  readonly admin: boolean | null;
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(url);
  return response.json();
}

/**
 * The sentence a screen shows beside an action one of the "who may" rules
 * holds back for the signed-in person, or null when the rule lets them
 * through. The rule comes from the runtime read and the person's role from
 * their account, each read once per mount. Until both answer, or when
 * either fails, the screen draws as it always has: the server refuses
 * what the rule refuses either way.
 */
export function useRuleRefusal(key: WhoMayRule): string | null {
  const [reads, setReads] = useState<RuleReads>({ value: null, admin: null });
  useEffect(() => {
    let cancelled = false;
    readJson("/api/config").then(config => {
      const rules = (config as { rules?: Record<string, unknown> }).rules;
      if (!cancelled && rules && typeof rules === "object") setReads(current => ({ ...current, value: rules[key] ?? null }));
    }).catch(() => { /* without the rule the screen draws as it always has */ });
    readJson("/api/account").then(body => {
      const admin = (body as { account?: { isAdmin?: unknown } }).account?.isAdmin;
      if (!cancelled && typeof admin === "boolean") setReads(current => ({ ...current, admin }));
    }).catch(() => { /* without the account the screen draws as it always has */ });
    return () => { cancelled = true; };
  }, [key]);
  return reads.value === null || reads.admin === null ? null : ruleRefusal(key, reads.value, reads.admin);
}

/**
 * One of the instance's rules as the runtime read reports it to the
 * signed-in person, or null until the read answers and for good when it
 * fails, read once per mount. A screen that follows it draws as it always
 * has while it is null.
 */
export function useInstanceRule(key: RuleKey): unknown {
  const [value, setValue] = useState<unknown>(null);
  useEffect(() => {
    let cancelled = false;
    readJson("/api/config").then(config => {
      const rules = (config as { rules?: Record<string, unknown> }).rules;
      if (!cancelled && rules && typeof rules === "object") setValue(rules[key] ?? null);
    }).catch(() => { /* without the rule the screen draws as it always has */ });
    return () => { cancelled = true; };
  }, [key]);
  return value;
}
