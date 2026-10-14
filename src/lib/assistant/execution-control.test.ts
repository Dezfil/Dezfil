import { afterEach, beforeEach, expect, it, vi } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { assistantRuns } from "./runs";
import { executionControl, type ExecutionControl } from "./execution-control";
import { assistantWorkForTests, drainAssistantWork } from "./retained-work";
import { erasureInventory } from "@/lib/auth/account-erasure-inventory";
import { proveErasure } from "../../../test-support/account-erasure-proof";

let db: ReturnType<typeof metadata.open>;
const controls: ExecutionControl[] = [];
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  assistantRuns.resetForTests();
});
afterEach(() => {
  for (const control of controls.splice(0)) control.detach();
  assistantRuns.resetForTests();
  vi.restoreAllMocks(); db.close();
});

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as (options: { type: "major" }) => void;
async function collect() {
  // Weak references stay alive for the current job, so collect in later jobs.
  await new Promise(resolve => setImmediate(resolve)); gc({ type: "major" });
  await new Promise(resolve => setImmediate(resolve)); gc({ type: "major" });
}

function attach(controller = new AbortController(), accountId = "test-account") {
  const scope = testAccountScope(db, accountId);
  const run = assistantRuns.reserve(scope);
  assistantRuns.bind(scope, run.id, {});
  const request = new Request("http://127.0.0.1/api/assistant/messages", { signal: controller.signal });
  const reference = new WeakRef(request);
  const control = executionControl(scope, run.id, request);
  controls.push(control);
  return { reference, control, controller, scope };
}

it("retains each live request through a major collection and releases it at detach", async () => {
  const first = attach(), second = attach();
  await collect();
  expect.soft(first.reference.deref()).toBeDefined();
  expect.soft(second.reference.deref()).toBeDefined();
  first.controller.abort();
  expect.soft(first.control.signal.aborted).toBe(true);
  expect(second.control.signal.aborted).toBe(false);
  first.control.detach();
  await collect();
  expect(first.reference.deref()).toBeUndefined();
  expect.soft(second.reference.deref()).toBeDefined();
  expect(assistantWorkForTests(first.scope.accountId).cleanups).toBe(1);
  second.control.detach();
  second.controller.abort();
  expect(second.control.signal.aborted).toBe(false);
  await collect();
  expect(second.reference.deref()).toBeUndefined();
  expect(assistantWorkForTests(first.scope.accountId).cleanups).toBe(0);
});

it("observes an already departed request and detaches idempotently", () => {
  const controller = new AbortController(); controller.abort();
  const { control, scope } = attach(controller);
  expect(control.signal.aborted).toBe(true);
  control.detach(); control.detach();
  expect(assistantWorkForTests(scope.accountId).cleanups).toBe(0);
});

it("releases the drained account's request while another account keeps executing", async () => {
  const target = attach(new AbortController(), "target"), other = attach(new AbortController(), "control");
  const id = "memory:src/lib/assistant/execution-control.ts#executionControl.retainedRequest";
  const inventory = { ...erasureInventory, stores: { [id]: erasureInventory.stores[id] } };
  await proveErasure(inventory, { [id]: {
    populate() {}, dispose() {},
    async observe() {
      await collect();
      return { target: target.reference.deref() ? ["request"] : [], control: other.reference.deref() ? ["request"] : [] };
    },
  } }, () => drainAssistantWork(target.scope.accountId));
  expect(assistantWorkForTests(target.scope.accountId).cleanups).toBe(0);
  expect(assistantWorkForTests(other.scope.accountId).cleanups).toBe(1);
});
