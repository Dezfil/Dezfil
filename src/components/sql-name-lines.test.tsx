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
const row = (value: Account, own = false) => renderToStaticMarkup(<UserRow account={value} own={own} open={false} busy={false}
  handOver={null} onToggle={() => {}} onAccess={async () => true} onReset={async () => true} onDone={() => {}} />);

describe("the SQL name on the account surfaces", () => {
  it("draws a quiet line under the person's name on a Users row, deactivated rows included", () => {
    expect(row(account)).toMatch(/<b>Ada Lovelace<\/b><span[^>]*>ada_lovelace<\/span>/);
    expect(row(account, true)).toMatch(/<b>Ada Lovelace<small> · you<\/small><\/b><span[^>]*>ada_lovelace<\/span>/);
    expect(row({ ...account, status: "deactivated" })).toContain(">ada_lovelace<");
  });

  it("names it on the Account card beside the display name, outside the editable fields", () => {
    const html = renderToStaticMarkup(<AccountCard account={account} />);
    expect(html).toMatch(/SQL name<\/span><code[^>]*>ada_lovelace<\/code>/);
    expect(html.indexOf("ada_lovelace")).toBeGreaterThan(html.indexOf("Display name"));
    expect(html.indexOf("ada_lovelace")).toBeLessThan(html.indexOf(">Email<"));
    expect(html).not.toMatch(/<input[^>]*value="ada_lovelace"/);
  });
});
