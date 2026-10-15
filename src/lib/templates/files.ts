import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { currentTrustedOperation } from "@/lib/trusted-operation";

export async function copyTemplateFile(source: string, target: string): Promise<void> {
  const operation = currentTrustedOperation();
  operation?.enterStage("template file copy");
  await pipeline(createReadStream(source), createWriteStream(target), { signal: operation?.signal });
  operation?.assertCanCommit();
}

export async function templateFileDigest(file: string): Promise<string> {
  const operation = currentTrustedOperation();
  operation?.enterStage("template checksum");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal: operation?.signal })) hash.update(chunk as Buffer);
  operation?.assertCanCommit();
  return hash.digest("hex");
}
