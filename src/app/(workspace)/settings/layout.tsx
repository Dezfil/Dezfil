import { SettingsFrame } from "@/components/settings/SettingsFrame";

/**
 * Every Settings address renders under this layout, so the frame stays
 * mounted while the tab changes: a tab change is an address the frame
 * follows, never a remount that would drop what is on screen.
 */
export default function SettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <>
    {children}
    <SettingsFrame />
  </>;
}
