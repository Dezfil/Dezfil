import { EntryScreen } from "@/components/auth/EntryScreen";
import { externalSignIn } from "@/lib/auth/external-sign-in/config";

// The mode is the server's, read at start: drawn from the first paint, so no
// password field shows on an instance that takes none.
export const dynamic = "force-dynamic";
export default function Page() { return <EntryScreen mode={externalSignIn().enabled ? "external" : "sign-in"} />; }
