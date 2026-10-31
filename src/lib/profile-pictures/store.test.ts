import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Faults and holds at the picture folder's file operations, by path. */
const faults = vi.hoisted(() => ({
  write: null as null | ((file: string) => Promise<void> | void),
  rename: null as null | ((from: string) => Promise<void> | void),
  rm: null as null | ((file: string) => Promise<void> | void),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const picture = (file: unknown) => String(file).includes("/profile-pictures/");
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (picture(args[0]) && faults.write) await faults.write(String(args[0]));
      return actual.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (picture(args[0]) && faults.rename) await faults.rename(String(args[0]));
      return actual.rename(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (picture(args[0]) && faults.rm) await faults.rm(String(args[0]));
      return actual.rm(...args);
    },
  };
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountScope } from "@/lib/test-support/accounts";
import { authenticateSession, issueSession, type AuthContext } from "@/lib/auth/credentials";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { requireAdmin } from "@/lib/auth/admin";
import { acceptAccountDeletion, finishAccountDeletion } from "@/lib/auth/account-deletion";
import { discoverAccountDeletions } from "@/lib/auth/account-deletion-journal";
import { admittedReads, drainAccountWork } from "@/lib/auth/account-deletion-admission";
import { erasureInventory } from "@/lib/auth/account-erasure-inventory";
import { eraseAccountFiles } from "@/lib/ingest/account-files";
import { ownedFileRecords, registerAccountFile } from "@/lib/ingest/file-ownership";
import { proveErasure } from "../../../test-support/account-erasure-proof";
import { admitPictureWrite, pictureWriteAccounts, publishPicture, sweepProfilePictures, type PictureWrite } from "./store";

/**
 * The picture store. Target and Control are people with pictures of their
 * own; Admin is an admin. Every write takes its place in its account's order
 * when admitted, publishes in the account's turn, and publishes only when no
 * write admitted after it has; the row's commit is the success boundary.
 */
const root = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let admin: AuthContext;
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  directory = mkdtempSync(path.join(root, "picture-store-"));
  process.env.DEZFIL_DATA_DIR = directory;
  closeMetadataDb();
  scopes = Object.fromEntries(["target", "control", "admin"].map((id) => [id, testAccountScope(undefined, id)]));
  metadataDb().exec("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'; UPDATE accounts SET last_sign_in_at = 'time'");
  admin = authenticateSession(issueSession(getAccount("admin")!, metadataDb(), Date.now()).secret)!;
});
afterEach(() => {
  faults.write = faults.rename = faults.rm = null;
  closeMetadataDb();
  process.env.DEZFIL_DATA_DIR = root;
  rmSync(directory, { recursive: true, force: true });
});

const own = (id: string) => (db: Database) => { requireAccountScope(scopes[id], db); };
const asAdmin = () => (db: Database) => { requireAdmin(admin, db, Date.now()); };
const admit = (subject: string, actor = subject) => admitPictureWrite(actor, subject);
/** Publish and give the place back, as a route does once all has settled. */
const publish = (write: PictureWrite, picture: string | null, authorize = own(write.subjectId)) =>
  publishPicture(write, picture === null ? null : Buffer.from(picture), authorize).finally(() => write.release());
const set = (id: string, picture: string | null) => publish(admit(id), picture);
const folder = () => path.join(directory, "profile-pictures");
const stored = () => (existsSync(folder()) ? readdirSync(folder()).sort() : []);
const records = () => ownedFileRecords().map((record) => record.file).filter((file) => file.startsWith("profile-pictures/")).sort();
const version = (id: string) => getAccount(id)?.pictureVersion;
const file = (id: string) => `${id}.${version(id)}.webp`;
/** A hold at one file operation: reached once the operation is entered,
 * opened or failed by the test. */
function hold() {
  const reached = Promise.withResolvers<void>(), opened = Promise.withResolvers<void>();
  void opened.promise.catch(() => undefined);
  return { reached: reached.promise, enter: () => { reached.resolve(); return opened.promise; }, open: () => opened.resolve(), fail: () => opened.reject(new Error("stopped")) };
}

describe("one file per account", () => {
  it("names the version its row holds, replaces it with the next one and removes it, a second removal changing nothing", async () => {
    const first = await set("target", "one");
    expect(first.outcome).toBe("published");
    expect(first.account.pictureVersion).toBe(version("target"));
    expect(stored()).toEqual([file("target")]);
    expect(readFileSync(path.join(folder(), file("target")), "utf8")).toBe("one");
    expect(records()).toEqual([`profile-pictures/${file("target")}`]);
    const before = version("target");
    await set("target", "two");
    expect(version("target")).not.toBe(before);
    await set("control", "theirs");
    expect(stored()).toEqual([file("control"), file("target")].sort());
    expect(records()).toEqual([file("control"), file("target")].map((name) => `profile-pictures/${name}`).sort());
    const removed = await set("target", null);
    expect(removed.account).not.toHaveProperty("pictureVersion");
    expect(stored()).toEqual([file("control")]);
    expect(records()).toEqual([`profile-pictures/${file("control")}`]);
    expect((await set("target", null)).outcome).toBe("published");
    expect(stored()).toEqual([file("control")]);
  });

  it("registers both of a new file's names to its account before a byte is written", async () => {
    let seen: string[] = [];
    faults.write = () => { seen = records(); };
    await set("target", "one");
    expect(seen).toEqual([`profile-pictures/${file("target")}`, `profile-pictures/${file("target")}.part`]);
    expect(ownedFileRecords().filter((record) => record.file.startsWith("profile-pictures/")).map((record) => record.accountId)).toEqual(["target"]);
  });
});

describe("the success boundary", () => {
  it.each(["write", "rename", "row"])("a failure at the %s keeps the previous picture and leaves no new file or record", async (stage) => {
    await set("target", "one");
    const previous = version("target");
    if (stage === "write") faults.write = () => { throw new Error("injected write failure"); };
    if (stage === "rename") faults.rename = () => { throw new Error("injected rename failure"); };
    if (stage === "row") metadataDb().exec("CREATE TRIGGER fail_picture BEFORE UPDATE OF picture_version ON accounts BEGIN SELECT RAISE(ABORT, 'injected row failure'); END");
    await expect(set("target", "two")).rejects.toThrow(/injected/);
    expect(version("target")).toBe(previous);
    expect(stored()).toEqual([file("target")]);
    expect(records()).toEqual([`profile-pictures/${file("target")}`]);
    expect(readFileSync(path.join(folder(), file("target")), "utf8")).toBe("one");
  });

  it("answers success when the replaced file cannot be removed, which keeps its record until the sweep", async () => {
    await set("target", "one");
    const replaced = file("target");
    faults.rm = (removing) => { if (removing.endsWith(replaced)) throw new Error("injected unlink failure"); };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await set("target", "two")).outcome).toBe("published");
    expect(stored()).toEqual([file("target"), replaced].sort());
    expect(records()).toContain(`profile-pictures/${replaced}`);
    faults.rm = null;
    expect(await sweepProfilePictures()).toBe(1);
    expect(stored()).toEqual([file("target")]);
    expect(records()).toEqual([`profile-pictures/${file("target")}`]);
  });

  it.each([
    ["the partial file is written", "rename", "previous"],
    ["the new file is in place", "part", "previous"],
    ["the row has committed", "retire", "new"],
  ] as const)("a restart once %s leaves the %s picture, and the sweep the rest", async (_, point, survivor) => {
    await set("target", "one");
    const previous = version("target")!;
    const stop = hold();
    if (point === "rename") faults.rename = stop.enter;
    if (point === "part") faults.rm = (removing) => (removing.endsWith(".part") ? stop.enter() : undefined);
    if (point === "retire") faults.rm = (removing) => (removing.includes(previous) ? stop.enter() : undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const write = admit("target");
    const running = publish(write, "two").catch(() => undefined);
    await stop.reached;
    // What a restart finds: the row and the folder as the process left them.
    faults.write = faults.rename = faults.rm = null;
    await sweepProfilePictures();
    if (survivor === "previous") expect(version("target")).toBe(previous);
    else expect(version("target")).not.toBe(previous);
    expect(stored()).toEqual([file("target")]);
    expect(records()).toEqual([`profile-pictures/${file("target")}`]);
    stop.fail(); await running;
  });
});

describe("the order of writes", () => {
  it("lets a write admitted later that published first win over an earlier one, which writes nothing", async () => {
    const earlier = admit("target"), later = admit("target");
    let writes = 0;
    faults.write = () => { writes += 1; };
    expect((await publish(later, "later")).outcome).toBe("published");
    const lost = await publish(earlier, "earlier");
    expect(lost).toMatchObject({ outcome: "superseded", account: { pictureVersion: version("target") } });
    expect(writes).toBe(1);
    expect(readFileSync(path.join(folder(), file("target")), "utf8")).toBe("later");
    expect(stored()).toEqual([file("target")]);
  });

  it("publishes one write at a time in the account's turn, in their order", async () => {
    const first = admit("target"), second = admit("target");
    const stop = hold();
    let writes = 0;
    faults.write = () => { writes += 1; return writes === 1 ? stop.enter() : undefined; };
    const both = [publish(first, "first"), publish(second, "second")];
    await stop.reached; await tick(); await tick();
    expect(writes).toBe(1);
    stop.open();
    expect((await Promise.all(both)).map((result) => result.outcome)).toEqual(["published", "published"]);
    expect(readFileSync(path.join(folder(), file("target")), "utf8")).toBe("second");
    expect(stored()).toEqual([file("target")]);
  });

  it("lets a removal admitted after an upload win when it publishes first, and an upload admitted after a removal stand", async () => {
    const upload = admit("target"), removal = admit("target");
    await publish(removal, null);
    expect((await publish(upload, "late")).outcome).toBe("superseded");
    expect(version("target")).toBeUndefined();
    expect(stored()).toEqual([]);
    const before = admit("target"), after = admit("target");
    await publish(after, "kept");
    expect((await publish(before, null)).outcome).toBe("superseded");
    expect(readFileSync(path.join(folder(), file("target")), "utf8")).toBe("kept");
  });

  it("orders an admin's removal with the person's own writes, and refuses it once the admin is no longer one", async () => {
    const upload = admit("target"), removal = admit("target", "admin");
    await publish(removal, null, asAdmin());
    expect((await publish(upload, "late")).outcome).toBe("superseded");
    expect(stored()).toEqual([]);
    await set("target", "one");
    const demoted = admit("target", "admin");
    metadataDb().exec("UPDATE accounts SET is_admin = 0 WHERE id = 'admin'");
    await expect(publish(demoted, null, asAdmin())).rejects.toMatchObject({ code: "forbidden" });
    expect(stored()).toEqual([file("target")]);
  });
});

describe("deletion", () => {
  it("waits for an admitted write, which can no longer publish, and admits none after acceptance", async () => {
    await set("target", "one");
    const stop = hold();
    faults.write = stop.enter;
    const write = admit("target");
    const running = publish(write, "two");
    void running.catch(() => undefined);
    await stop.reached;
    metadataDb().exec("UPDATE accounts SET status = 'deactivated' WHERE id = 'target'");
    const accepted = acceptAccountDeletion(admin, "target", () => {});
    expect(() => admit("target")).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => admit("target", "admin")).toThrow(expect.objectContaining({ code: "not_found" }));
    let done = false;
    const finished = finishAccountDeletion(admin, accepted.id).then((result) => { done = true; return result; });
    await tick(); await tick();
    expect(done).toBe(false);
    expect(admittedReads("target")).toBe(1);
    stop.open();
    await expect(running).rejects.toMatchObject({ code: "authentication_required" });
    expect(await finished).toEqual({ id: accepted.id, state: "completed" });
    expect(stored()).toEqual([]);
    expect(records()).toEqual([]);
  });

  it("erases the account's current, replaced and partial files and keeps every other account's", async () => {
    const id = "file:profile-pictures";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const probe = {
      async populate() {
        await set("target", "one");
        const replaced = file("target");
        faults.rm = (removing) => { if (removing.endsWith(replaced)) throw new Error("injected unlink failure"); };
        await set("target", "two");
        faults.rm = null;
        // What a process stopped mid-write leaves: a registered partial file.
        registerAccountFile("target", "profile-pictures/target.stopped.webp.part");
        writeFileSync(path.join(folder(), "target.stopped.webp.part"), "partial");
        await set("control", "theirs");
      },
      observe: () => ({ target: stored().filter((name) => name.startsWith("target.")), control: stored().filter((name) => name.startsWith("control.")) }),
      dispose() {},
    };
    await proveErasure({ ...erasureInventory, stores: { [id]: erasureInventory.stores[id] } }, { [id]: probe }, async () => {
      metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
      await eraseAccountFiles("target", [], metadataDb());
    });
    expect(records()).toEqual([`profile-pictures/${file("control")}`]);
  });

  it("drains the account's place in the order of writes and keeps every other account's", async () => {
    const id = "memory:src/lib/profile-pictures/store.ts#pictureWrites";
    const stop = hold();
    let target: Promise<unknown> = Promise.resolve(), control: PictureWrite | null = null;
    const probe = {
      async populate() {
        faults.write = stop.enter;
        target = publish(admit("target"), "one").catch(() => undefined);
        await stop.reached;
        control = admit("control");
      },
      observe: () => ({ target: pictureWriteAccounts().filter((account) => account === "target"), control: pictureWriteAccounts().filter((account) => account === "control") }),
      dispose() { control?.release(); },
    };
    await proveErasure({ ...erasureInventory, stores: { [id]: erasureInventory.stores[id] } }, { [id]: probe }, async () => {
      metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
      const drained = drainAccountWork("target");
      stop.open();
      await target; await drained;
    });
    expect(stored()).toEqual([]);
  });

  it("finishes erasing the picture after a restart through the deletion's continuation", async () => {
    await set("target", "one");
    await set("control", "theirs");
    metadataDb().exec("UPDATE accounts SET status = 'deactivated' WHERE id = 'target'");
    const accepted = acceptAccountDeletion(admin, "target", () => {});
    closeMetadataDb();
    discoverAccountDeletions(metadataDb());
    expect(await finishAccountDeletion(admin, accepted.id)).toEqual({ id: accepted.id, state: "completed" });
    expect(stored()).toEqual([file("control")]);
    expect(records()).toEqual([`profile-pictures/${file("control")}`]);
    expect(metadataDb().prepare("SELECT picture_version FROM accounts WHERE id = 'target'").get()).toEqual({ picture_version: null });
  });
});

describe("the start-up sweep", () => {
  it("keeps exactly the pictures the rows name and the records of those", async () => {
    await set("target", "one");
    await set("control", "theirs");
    mkdirSync(folder(), { recursive: true });
    for (const name of ["target.replaced.webp", "target.stopped.webp.part"]) {
      registerAccountFile("target", `profile-pictures/${name}`);
      writeFileSync(path.join(folder(), name), "left over");
    }
    writeFileSync(path.join(folder(), "nobody.stray.webp"), "left over");
    registerAccountFile("control", "profile-pictures/control.gone.webp");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await sweepProfilePictures()).toBe(3);
    expect(stored()).toEqual([file("control"), file("target")].sort());
    expect(records()).toEqual([file("control"), file("target")].map((name) => `profile-pictures/${name}`).sort());
    expect(await sweepProfilePictures()).toBe(0);
  });
});

it.each([['ENOSPC', 507, 'storage_exhausted'], ['EACCES', 500, 'internal']] as const)("preserves the previous picture after a partial %s write", async (code, status, answer) => {
  await set("target", "one");
  const previous = version("target");
  faults.write = target => { writeFileSync(target, "partial"); throw Object.assign(new Error("destination refused"), { code }); };
  await expect(set("target", "two")).rejects.toMatchObject({ code: answer, status });
  expect(version("target")).toBe(previous);
  expect(stored()).toEqual([file("target")]);
  expect(records()).toEqual([`profile-pictures/${file("target")}`]);
  expect(readFileSync(path.join(folder(), file("target")), "utf8")).toBe("one");
});
