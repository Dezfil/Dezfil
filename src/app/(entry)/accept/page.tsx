import { EntryScreen } from "@/components/auth/EntryScreen";
import { externalSignIn } from "@/lib/auth/external-sign-in/config";

// An old link on an instance with a sign-in service is told so before anyone types a password.
export const dynamic = "force-dynamic";
export default function Page() { return externalSignIn().enabled ? <EntryScreen mode="external" linkOpened /> : <EntryScreen mode="redeem" />; }
