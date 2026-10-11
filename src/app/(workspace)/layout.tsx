import Link from "next/link";
import { HealthDot } from "@/components/HealthDot";
import { HeaderCrumbs, NavLinks } from "@/components/NavLinks";
import { InstanceChip } from "@/components/shell/InstanceChip";
import { HeadCard } from "@/components/shell/HeadCard";
import { ShellTitle } from "@/components/shell/ShellTitle";
import { RailShell } from "@/components/RailShell";
import { HintLayer } from "@/components/ui/HintLayer";
import { PanelLens } from "@/components/look/PanelLens";
import { AccountRail } from "@/components/AccountRail";
import { ThemeProvider, ThemeToggle } from "@/components/theme";
import styles from "./layout.module.css";
import { requirePageScope } from "@/lib/auth/scope-page";
import { PrivateWorkspace } from "@/components/auth/PrivateWorkspace";
import { SignedIn } from "@/components/sharing/signed-in";
import { accountLabels } from "@/lib/metadata/accounts";
import { DOCUMENT_METADATA, DezfilDocument } from "../document";
import { pageLook } from "./page-look";

export const metadata = DOCUMENT_METADATA;

// The Wheelhouse workspace shell: a floating header card (wordmark +
// breadcrumb) with the action row beside it, and a left icon rail for
// mode navigation. Pages contribute to the header through the slot
// elements — the builder portals its breadcrumb tail and actions in. The
// published viewer (/v/[token]) lives outside this group, so it renders
// full-bleed with no edit affordances — and outside the theme provider,
// so it never themes.
//
// This is a root layout: the document it serves carries the signed-in
// person's look on <html>, and no other root does.
export default async function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const scope = await requirePageScope();
  // Who is signed in, by display name and SQL name: the lists mark what
  // someone else owns against it.
  const signedIn = accountLabels([scope.accountId]).get(scope.accountId) ?? null;
  return (
    <DezfilDocument look={pageLook(scope.accountId)}>
    <PrivateWorkspace key={scope.accountId} accountId={scope.accountId}>
    <SignedIn account={signedIn}>
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
        <span id="header-attribution-slot" className={styles.slot} />
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
        <AccountRail />
      </RailShell>
      <main className={styles.main}>{children}</main>
      <HintLayer />
      <PanelLens />
    </ThemeProvider>
    </SignedIn>
    </PrivateWorkspace>
    </DezfilDocument>
  );
}
