import { TemplatesScreen } from "@/components/templates/TemplatesScreen";
import { requirePageScope } from "@/lib/auth/scope-page";

// Every signed-in account sees the templates; the list is read in the
// browser, so the page is drawn before the catalogue answers.
export default async function TemplatesPage() {
  await requirePageScope();
  return <TemplatesScreen />;
}
