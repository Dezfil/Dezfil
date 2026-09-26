import Link from "next/link";
import { HealthDot } from "@/components/HealthDot";
import { HeaderCrumbs, NavLinks, RailSettingsLink } from "@/components/NavLinks";
import { InstanceChip } from "@/components/shell/InstanceChip";
import { HeadCard } from "@/components/shell/HeadCard";
import { ShellTitle } from "@/components/shell/ShellTitle";
import { RailShell } from "@/components/RailShell";
import { HintLayer } from "@/components/ui/HintLayer";
import { UserBadge } from "@/components/UserBadge";
import { ThemeProvider, ThemeToggle } from "@/components/theme";
import styles from "./layout.module.css";

// The Wheelhouse workspace shell: a floating header card (wordmark +
// breadcrumb) with the action row beside it, and a left icon rail for
// mode navigation. Pages contribute to the header through the slot
// elements — the builder portals its breadcrumb tail and actions in. The
// published viewer (/v/[token]) lives outside this group, so it renders
// full-bleed with no edit affordances — and outside the theme provider,
// so it never themes.
export default function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ThemeProvider>
      <ShellTitle />
      <header className={styles.topbar}>
        <HeadCard className={styles.headCard}>
          <Link href="/" className={styles.brand}>
            Dezfil
          </Link>
          <InstanceChip />
          <HeaderCrumbs />
        </HeadCard>
        <span id="header-actions-start" className={styles.slot} />
        <div className={styles.actions}>
          <span id="header-actions-left" className={styles.slot} />
          <ThemeToggle />
          <span id="header-actions-right" className={styles.slot} />
        </div>
      </header>
      <RailShell className={styles.rail}>
        <NavLinks />
        <span className={styles.railSpacer} />
        <HealthDot />
        <RailSettingsLink />
        <UserBadge />
      </RailShell>
      <main className={styles.main}>{children}</main>
      <HintLayer />
    </ThemeProvider>
  );
}
