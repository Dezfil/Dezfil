"use client";
import { useEffect } from "react";
import { ACCOUNT_CHANGED_EVENT } from "./auth/private-state";

/** Native navigation owns the browser's unsaved-work warning, including Back.
 * Account retirement bypasses it: private workspace state is already gone. */
export function useUnsavedNavigation(unsaved: boolean) {
  useEffect(() => {
    if (!unsaved) return;
    let retired = false;
    const unload = (event: BeforeUnloadEvent) => {
      if (retired) return;
      event.preventDefault(); event.returnValue = "";
    };
    const account = () => { retired = true; };
    const click = (event: MouseEvent) => {
      if (retired || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download") || link.href === location.href) return;
      event.preventDefault(); event.stopImmediatePropagation();
      window.location.assign(link.href);
    };
    const pop = (event: PopStateEvent) => {
      if (retired) return;
      event.stopImmediatePropagation();
      window.location.reload();
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener(ACCOUNT_CHANGED_EVENT, account);
    window.addEventListener("popstate", pop, true);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, account);
      window.removeEventListener("popstate", pop, true);
      document.removeEventListener("click", click, true);
    };
  }, [unsaved]);
}
