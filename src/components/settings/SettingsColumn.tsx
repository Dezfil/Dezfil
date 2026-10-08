"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowRightIcon, DataServicesIcon, GaugeIcon, KeyIcon, LookIcon, MapsIcon, PersonIcon, PublishingIcon, ServerIcon, ShieldIcon, SlidersIcon, UsersIcon, WorkflowsIcon,
} from "@/components/ui/icons";
import { tabAddress } from "./settings-address";
import { settingsColumn, type SettingsTabId } from "./settings-tabs";
import styles from "./SettingsFrame.module.css";

const ICONS: Record<SettingsTabId, ReactNode> = {
  account: <PersonIcon />,
  tokens: <KeyIcon />,
  appearance: <LookIcon />,
  general: <SlidersIcon />,
  maps: <MapsIcon />,
  workflows: <WorkflowsIcon />,
  publishing: <PublishingIcon />,
  data: <DataServicesIcon />,
  limits: <GaugeIcon />,
  security: <ShieldIcon />,
  system: <ServerIcon />,
};

/** The tab column: the search at its head, You, then Instance, each with
 * the tabs this person may open, and for an admin the Users page under a
 * rule at the foot. No tab is marked current while the search answers. */
export function SettingsColumn({ admin, current, search }: { admin: boolean; current: SettingsTabId | null; search?: ReactNode }) {
  const column = settingsColumn(admin);
  return <nav className={styles.column} aria-label="Settings">
    {search}
    {column.groups.map(group => <div key={group.id} className={styles.group}>
      <div className={styles.groupLabel}>{group.label}</div>
      {group.tabs.map(tab => <Link key={tab.id} href={tabAddress(tab.id)} scroll={false} className={styles.item}
        aria-current={tab.id === current ? "page" : undefined}>
        {ICONS[tab.id]}<span>{tab.label}</span>
      </Link>)}
    </div>)}
    {column.users && <>
      <div className={styles.rule} />
      <Link id="settings-users" href="/users" className={styles.item}><UsersIcon /><span>Users</span><span className={styles.out}><ArrowRightIcon /></span></Link>
    </>}
  </nav>;
}
