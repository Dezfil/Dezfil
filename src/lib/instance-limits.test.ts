import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instanceSettingsFixture } from "../../test-support/instance-settings";
import { testAccountScope } from "./test-support/accounts";
import { createMap, duplicateMap } from "./map-service";
import { createProject } from "./metadata/owned-projects";
import { inviteAccount } from "./auth/admin";
import { acceptAccountDeletion, finishAccountDeletion } from "./auth/account-deletion";
import * as compaction from "./metadata/account-compaction.mjs";
import { instanceCounts } from "./instance-limits";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture({ file: true }); });
afterEach(() => f.close());

describe("instance counts", () => {
  it("counts maps and projects across owners and filing, with duplicates included", () => {
    const admin = testAccountScope(f.db, "admin"), member = testAccountScope(f.db, "member");
    const project = createProject(member, { name: "Private project" }, f.db);
    const original = createMap(member, "Filed map", project.id);
    createMap(admin, "Private map");
    duplicateMap(member, original.id);
    expect(instanceCounts(f.db)).toEqual({ maps: 3, projects: 1, people: 2 });
  });

  it("keeps an unreadable journal isolated while its deleting account still occupies one place", () => {
    const account = inviteAccount(f.context, { name: "Delete me", email: "delete@example.test" }, f.db).account;
    const deletion = acceptAccountDeletion(f.context, account.id, () => {}, f.db);
    writeFileSync(path.join(f.dir, "account-deletions", `${deletion.id}.json`), "{");
    expect(instanceCounts(f.db)).toEqual({ maps: 0, projects: 0, people: 3 });

  });

  it.each([false, true])("keeps an unfinished deletion after profile erasure (invited=%s), and frees only its completion", async invited => {
    const account = inviteAccount(f.context, { name: "Delete me", email: "delete@example.test" }, f.db).account;
    if (!invited) f.db.prepare("UPDATE accounts SET status='deactivated',last_sign_in_at=? WHERE id=?").run(new Date().toISOString(), account.id);
    expect(instanceCounts(f.db).people).toBe(3);
    const accepted = acceptAccountDeletion(f.context, account.id, () => {}, f.db);
    expect(instanceCounts(f.db).people).toBe(3);
    const compact = vi.spyOn(compaction, "compactMetadataStore").mockImplementationOnce(() => { throw new Error("Hold after profile erasure"); });
    expect(await finishAccountDeletion(f.context, accepted.id, f.db)).toMatchObject({ state: "needs-retry" });
    const identity = f.db.prepare("SELECT status FROM accounts WHERE id=?").get(account.id);
    expect(identity).toEqual(invited ? undefined : { status: "deleted" });
    expect(instanceCounts(f.db).people).toBe(3);
    compact.mockRestore();
    expect(await finishAccountDeletion(f.context, accepted.id, f.db)).toMatchObject({ state: "completed" });
    expect(instanceCounts(f.db).people).toBe(2);
    expect(f.db.prepare("SELECT status FROM accounts WHERE id=?").get(account.id)).toEqual(identity);
  });
});
