"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { sectionFor } from "@/components/NavLinks";
import {
  browserTitle,
  useInstanceName,
  usePathObject,
} from "./path-model";
import { useProjectName } from "./use-project-name";

/**
 * The one owner of the browser title inside the workspace. Renders
 * nothing; the published viewer never mounts it, so its title stays the
 * root's.
 */
export function ShellTitle() {
  const pathname = usePathname();
  const object = usePathObject(pathname);
  const projectName = useProjectName(object?.projectId ?? null);
  const instance = useInstanceName();
  const section = sectionFor(pathname).label;

  useEffect(() => {
    const wanted = browserTitle({
      name: object?.name ?? null,
      project: projectName,
      section,
      instance,
    });
    document.title = wanted;
    // Next stamps the route's static metadata title AFTER hydration
    // effects (and again on navigation), so setting once loses the race.
    // Ownership means re-asserting: the observer settles because a write
    // that already matches provokes no further mutation.
    const observer = new MutationObserver(() => {
      if (document.title !== wanted) document.title = wanted;
    });
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [object?.name, projectName, section, instance]);

  return null;
}
