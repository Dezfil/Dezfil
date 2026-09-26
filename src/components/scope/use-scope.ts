"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { parseScope, scopeParam, type ProjectScope } from "./model";

/**
 * The scope's one home is the list address: the control renders the URL
 * and writes only the project value, so links, reloads and back/forward
 * can never disagree with it, and unrelated address state (the Data
 * screen's import door) survives untouched.
 */
export function useProjectScope(): {
  scope: ProjectScope;
  setScope: (next: ProjectScope) => void;
} {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const scope = parseScope(params.get("project"));

  const setScope = useCallback(
    (next: ProjectScope) => {
      const qs = new URLSearchParams(params);
      const value = scopeParam(next);
      if (value === null) qs.delete("project");
      else qs.set("project", value);
      const suffix = qs.toString();
      router.replace(suffix ? `${pathname}?${suffix}` : pathname, {
        scroll: false,
      });
    },
    [params, pathname, router],
  );

  return { scope, setScope };
}
