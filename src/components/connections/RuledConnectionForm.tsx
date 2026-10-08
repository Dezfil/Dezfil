"use client";

import type { ComponentProps } from "react";
import { useRuleRefusal } from "@/components/use-instance-rules";
import { ConnectionForm } from "./ConnectionForm";

/** The connection form where it is placed on a page: it reads who may add
 * database connections for the signed-in person and draws what that rule
 * holds back disabled with its sentence. */
export function RuledConnectionForm(props: Omit<ComponentProps<typeof ConnectionForm>, "refusal">) {
  const refusal = useRuleRefusal("connections.create");
  return <ConnectionForm {...props} refusal={refusal} />;
}
