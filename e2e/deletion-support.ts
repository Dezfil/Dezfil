import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type APIRequestContext } from "@playwright/test";

/** Scratch-only file handshake with deletion-proof-host, outside product HTTP. */
export async function deletionControl(message: { command: "hold" | "release"; accountId: string } | { command: "compaction"; fail: boolean }) {
  const directory = process.env.DEZFIL_PROOF_CONTROL_DIR;
  if (!directory || !path.isAbsolute(directory)) throw new Error("Set DEZFIL_PROOF_CONTROL_DIR to the proof host's absolute control directory");
  const requestId = randomUUID(), file = path.join(directory, "request.json"), candidate = `${file}.${requestId}`;
  await writeFile(candidate, JSON.stringify({ ...message, requestId })); await rename(candidate, file);
  await expect.poll(async () => {
    try { const response = JSON.parse(await readFile(path.join(directory, "response.json"), "utf8"));
      if (response.requestId !== requestId) return false;
      if (response.error) throw new Error(response.error);
      return response.value?.ok === true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }).toBe(true);
}
export async function erasePerson(admin: APIRequestContext, id: string, email: string) {
  expect((await admin.patch(`/api/users/${id}`, { data: { status: "deactivated" } })).status()).toBe(200);
  const preview = await admin.get(`/api/users/${id}/deletion-preview`); expect(preview.status()).toBe(200);
  const response = await admin.delete(`/api/users/${id}`, { data: { confirm: true, email, confirmation: (await preview.json()).confirmation } });
  expect([200, 202]).toContain(response.status()); let status = await response.json();
  if (status.state !== "completed") await expect.poll(async () => {
    const finished = await admin.post(`/api/users/deletions/${status.id}/finish`); expect([200, 202]).toContain(finished.status());
    status = await finished.json(); return status.state;
  }).toBe("completed");
  return status;
}
