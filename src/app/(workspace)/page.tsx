import { HomeScreen } from "@/components/home/HomeScreen";
import { requirePageScope } from "@/lib/auth/scope-page";

// Every signed-in account's own Home; its parts are read in the browser as
// that account, so the page is drawn before any list answers.
export default async function HomePage() {
  await requirePageScope();
  return <HomeScreen />;
}
