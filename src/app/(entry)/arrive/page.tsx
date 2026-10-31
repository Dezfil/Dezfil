import { redirect } from "next/navigation";
import { ArrivalScreen } from "@/components/auth/ArrivalScreen";
import { externalSignIn } from "@/lib/auth/external-sign-in/config";

export const dynamic = "force-dynamic";
/** Where the sign-in service returns the browser. An instance without one has no such page to offer. */
export default function Page() {
  if (!externalSignIn().enabled) redirect("/sign-in");
  return <ArrivalScreen />;
}
