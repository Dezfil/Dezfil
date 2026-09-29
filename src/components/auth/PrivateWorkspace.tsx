"use client";
import { useEffect, useState, type ReactNode } from "react";
import { watchPrivateWorkspace } from "./private-workspace";

export function PrivateWorkspace({ accountId, children }: { accountId: string; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => watchPrivateWorkspace(accountId, setReady), [accountId]);
  return ready ? children : null;
}
