"use client";

import { useRef, useState } from "react";
import type { PgConnection } from "@/lib/metadata/connections";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { CopyIcon, MoreIcon, TrashIcon } from "@/components/ui/icons";
import { IconDownload } from "@/components/gallery-icons";
import { serverAddress } from "./connection-view";
import styles from "./ConnectionMenu.module.css";

function Mark({ children }: { children: React.ReactNode }) {
  return <span className={styles.mark}>{children}</span>;
}

function Body({
  connection,
  snapshotCount,
  showImport,
  onDelete,
  onCopied,
}: {
  connection: PgConnection;
  snapshotCount: number;
  showImport: boolean;
  onDelete: () => void;
  onCopied?: (address: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const body = useRef<HTMLSpanElement>(null);

  if (confirming) {
    return (
      <span ref={body} className={styles.body} role="none">
        <span className={styles.confirm} role="none">
          {snapshotCount === 0
            ? "No snapshots depend on this connection."
            : `${snapshotCount} snapshot${snapshotCount === 1 ? "" : "s"} will keep serving but can no longer refresh.`}
        </span>
        <MenuItem danger onSelect={onDelete}>Confirm delete</MenuItem>
        <MenuItem keepOpen onSelect={() => setConfirming(false)}>Cancel</MenuItem>
      </span>
    );
  }

  return (
    <span ref={body} className={styles.body} role="none">
      {showImport ? (
        <MenuItem href={`/data?source=postgis&connection=${encodeURIComponent(connection.id)}`}>
          <Mark><IconDownload /></Mark>
          Import tables
        </MenuItem>
      ) : null}
      <MenuItem
        onSelect={() => {
          const address = serverAddress(connection);
          void navigator.clipboard.writeText(address);
          onCopied?.(address);
        }}
      >
        <Mark><CopyIcon /></Mark>
        Copy server address
      </MenuItem>
      <MenuItem danger keepOpen onSelect={() => setConfirming(true)}>
        <Mark><TrashIcon /></Mark>
        Delete
      </MenuItem>
    </span>
  );
}

export function ConnectionMenu({
  connection,
  snapshotCount,
  showImport = true,
  onDelete,
  onCopied,
}: {
  connection: PgConnection;
  snapshotCount: number;
  /** The detail page carries its own Import tables button; its menu drops the duplicate. */
  showImport?: boolean;
  onDelete: () => void;
  onCopied?: (address: string) => void;
}) {
  return (
    <Menu
      className={styles.wrap}
      label={`Actions for ${connection.name}`}
      triggerLabel={`More actions for ${connection.name}`}
      triggerClassName={styles.trigger}
      trigger={<MoreIcon />}
      menuClassName={styles.menu}
    >
      <Body
        connection={connection}
        snapshotCount={snapshotCount}
        showImport={showImport}
        onDelete={onDelete}
        onCopied={onCopied}
      />
    </Menu>
  );
}
