import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { AccountCard } from "./settings/AccountCard";
import { UserRow } from "./users/UserRow";

const account: Account = {
  id: "ada", name: "Ada Lovelace", email: "ada@example.test", sqlName: "ada_lovelace", isAdmin: false,
  status: "active", isOriginal: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  lastSignInAt: null,
};
const row = (value: Account, own = false, open = false) => renderToStaticMarkup(<UserRow account={value} own={own} open={open} busy={false}
  handOver={null} onToggle={() => {}} onAccess={async () => true} onReset={async () => true} onRemovePicture={() => {}} onDone={() => {}} onDelete={() => {}} />);

describe("the SQL name on the account surfaces", () => {
  it("names it, labeled, in an opened Users row and never under the person's name, deactivated rows included", () => {
    for (const [value, own] of [[account, false], [account, true], [{ ...account, status: "deactivated" as const }, false]] as const) {
      expect(row(value, own)).not.toContain("ada_lovelace");
      expect(row(value, own, true)).toMatch(/SQL name <span[^>]*>ada_lovelace<\/span>/);
    }
  });

  it("names it on the Account card beside the display name, outside the editable fields", () => {
    const html = renderToStaticMarkup(<AccountCard account={account} />);
    expect(html).toMatch(/SQL name<\/span><code[^>]*>ada_lovelace<\/code>/);
    expect(html.indexOf("ada_lovelace")).toBeGreaterThan(html.indexOf("Display name"));
    expect(html.indexOf("ada_lovelace")).toBeLessThan(html.indexOf(">Email<"));
    expect(html).not.toMatch(/<input[^>]*value="ada_lovelace"/);
  });
});
