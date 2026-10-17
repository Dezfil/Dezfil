"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { Account } from "@/lib/metadata/accounts";
import { RailDocsLink, RailSettingsLink, RailUsersLink } from "./NavLinks";
import { DISPLAY_NAME_EVENT, UserBadge } from "./UserBadge";
import { accountRequest } from "./settings/api";

export function AccountRailView({ account }: { account: Account | null }) {
  return <>
    {account?.isAdmin && <RailUsersLink />}
    <RailDocsLink />
    <RailSettingsLink />
    <UserBadge account={account} />
  </>;
}

export function AccountRail() {
  const [account, setAccount] = useState<Account | null>(null);
  const pathname = usePathname();
  useEffect(() => {
    let current = 0;
    let cancelled = false;
    const refresh = () => {
      const version = ++current;
      void accountRequest<{ account: Account }>("/api/account")
        .then(body => { if (!cancelled && version === current) setAccount(body.account); })
        .catch(() => { if (!cancelled && version === current) setAccount(null); });
    };
    refresh();
    window.addEventListener(DISPLAY_NAME_EVENT, refresh);
    return () => { cancelled = true; window.removeEventListener(DISPLAY_NAME_EVENT, refresh); };
  }, [pathname]);
  return <AccountRailView account={account} />;
}
