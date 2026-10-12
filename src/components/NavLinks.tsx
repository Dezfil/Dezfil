"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "@/app/(workspace)/layout.module.css";
import { usePathObject } from "@/components/shell/path-model";
import { useProjectFact } from "@/components/shell/use-project-name";
import { PeopleChip } from "@/components/sharing/PeopleMarks";
import { peopleMark } from "@/components/sharing/people";
import { useProjectPeople } from "@/components/sharing/use-project-people";
import { railHint, useRailItemMode } from "./rail-mode";

/* The workspace's sections, shared by the icon rail and the
   breadcrumb. Icon strokes follow the Wheelhouse reference mockup. */
const LINKS = [
  {
    href: "/",
    label: "Home",
    match: (p: string) => p === "/",
    icon: <path d="m3 10.5 9-7.5 9 7.5M5 8.8V21h14V8.8M9.5 21v-5.5h5V21" />,
  },
  {
    href: "/projects",
    label: "Projects",
    match: (p: string) => p.startsWith("/projects"),
    icon: (
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.9l2 2.4h8.1A1.5 1.5 0 0 1 21 8.9v9.6a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12Z" />
    ),
  },
  {
    href: "/maps",
    label: "Maps",
    match: (p: string) => p.startsWith("/maps"),
    icon: <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6ZM9 3v15M15 6v15" />,
  },
  {
    href: "/workflows",
    label: "Workflows",
    match: (p: string) => p.startsWith("/workflows"),
    icon: (
      <>
        <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5" />
        <rect x="14" y="14" width="6.5" height="6.5" rx="1.5" />
        <path d="M10 6.75h4.75a2 2 0 0 1 2 2V14M14 17.25H9.25a2 2 0 0 1-2-2V10" />
      </>
    ),
  },
  {
    href: "/data",
    label: "Data",
    match: (p: string) => p.startsWith("/data") || p.startsWith("/tables"),
    icon: (
      <>
        <ellipse cx="12" cy="5" rx="7" ry="3" />
        <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
      </>
    ),
  },
  {
    href: "/connections",
    label: "Connections",
    match: (p: string) => p.startsWith("/connections"),
    icon: <path d="M9 3v4M15 3v4M7 7h10v3.5a5 5 0 0 1-10 0V7ZM12 15.5V21" />,
  },
  {
    href: "/sql",
    label: "SQL",
    match: (p: string) => p.startsWith("/sql"),
    icon: <path d="m8 9-4 3 4 3M16 9l4 3-4 3M13 6l-2 12" />,
  },
  {
    href: "/developer",
    label: "Developer",
    match: (p: string) => p.startsWith("/developer"),
    icon: <path d="M3.5 5h17v14h-17zM7.5 9.5l3 2.5-3 2.5M13 15h4" />,
  },
  {
    href: "/templates",
    label: "Templates",
    match: (p: string) => p.startsWith("/templates"),
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1 5.1-2.1Z" />
      </>
    ),
  },
];

/* Bottom-cluster entry, same row shape as the sections.
   Gear outline from Feather Icons (MIT, © Cole Bemis) — see NOTICE. */
const SETTINGS = {
  href: "/settings",
  label: "Settings",
  match: (p: string) => p.startsWith("/settings"),
  icon: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
};

const USERS = {
  href: "/users",
  label: "Users",
  match: (p: string) => p === "/users" || p.startsWith("/users/"),
  icon: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2" /></>,
};

function RailLink({
  link,
  pathname,
}: {
  link: (typeof LINKS)[number];
  pathname: string;
}) {
  const mode = useRailItemMode();
  return (
    <Link
      href={link.href}
      className={styles.railLink}
      data-active={link.match(pathname) || undefined}
      {...railHint(mode, link.label)}
    >
      <span className={styles.railIcon}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          {link.icon}
        </svg>
      </span>
      <span className={styles.railLabel}>{link.label}</span>
    </Link>
  );
}

export function NavLinks() {
  const pathname = usePathname();
  return (
    <>
      {LINKS.map((link) => (
        <RailLink key={link.href} link={link} pathname={pathname} />
      ))}
    </>
  );
}

export function RailSettingsLink() {
  const pathname = usePathname();
  return <RailLink link={SETTINGS} pathname={pathname} />;
}

export function RailUsersLink() {
  return <RailLink link={USERS} pathname={usePathname()} />;
}

/** The section a route belongs to (spec list, 's
 * lookup): the shell's breadcrumb and the browser title read one table. */
export function sectionFor(pathname: string): { href: string; label: string } {
  return (
    [...LINKS, USERS, SETTINGS].find((l) => l.href !== "/" && l.match(pathname)) ??
    LINKS[0]
  );
}

/* The header card's breadcrumb: the
   wordmark is the root — the Workspace segment is retired — then the
   project when an object page contributes one, then the section, then
   a slot the page fills with its own tail (the bold, editable name). */
export function HeaderCrumbs() {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  const object = usePathObject(pathname);
  const project = useProjectFact(object?.projectId ?? null);
  // A filed map or workflow whose project is shared carries the project's
  // people mark on its segment: the sharing is the project's. Its people
  // are read only when the reader owns it; a project shared with them
  // already says whose it is.
  const owned = !!project && (!project.role || project.role === "owner");
  const people = useProjectPeople(
    owned && object?.projectId ? [object.projectId] : NO_IDS,
  );
  const mark =
    project && object?.projectId
      ? peopleMark(project, people.get(object.projectId))
      : null;
  return (
    <nav className={styles.crumbs} aria-label="Breadcrumb">
      {project !== null && object?.projectId && (
        <>
          <Link
            href={`/projects/${object.projectId}`}
            className={styles.crumbLink}
            data-shared={mark ? "" : undefined}
          >
            {mark ? (
              <>
                <span className={styles.crumbText}>{project.name}</span>
                <PeopleChip mark={mark} />
              </>
            ) : (
              project.name
            )}
          </Link>
          <span className={styles.crumbSep}>/</span>
        </>
      )}
      <Link href={section.href} className={styles.crumbLink}>
        {section.label}
      </Link>
      <span id="header-crumb-slot" className={styles.slot} />
    </nav>
  );
}

const NO_IDS: readonly string[] = [];
