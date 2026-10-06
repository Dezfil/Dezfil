import { authenticatedRoute } from "@/lib/assistant/testing/account";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { GET as assistantStatusHandler } from "@/app/api/assistant/route";
import { GET as configHandler } from "@/app/api/config/route";
import { scanConsumption } from "../../../test-support/settings-consumption";

const assistantStatus = authenticatedRoute(assistantStatusHandler);
const configGet = authenticatedRoute(configHandler);

/**
 * Credential-leak sweep: the model credential appears in no API response
 * and no client-delivered code. Enforced structurally so a regression fails
 * CI.
 */

const SENTINEL = "sk-ant-SECRET-DO-NOT-LEAK-000";
const CATALOGUE = "src/lib/settings/catalogue.ts";

function allowedCredentialLocation(file: string, source: string): boolean {
  return file.startsWith("src/lib/assistant/") || file === CATALOGUE && scanConsumption(file, source).length === 0;
}

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

describe("credential leak sweep", () => {
  it("the status response never contains the key", async () => {
    process.env.ANTHROPIC_API_KEY = SENTINEL;
    const res = await assistantStatus();
    const text = await res.text();
    expect(text).not.toContain(SENTINEL);
    // But it is genuinely enabled — so the omission is deliberate, not absence.
    expect(JSON.parse(text)).toMatchObject({ enabled: true, provider: "anthropic" });
  });

  it("the client config response never contains the key", async () => {
    process.env.ANTHROPIC_API_KEY = SENTINEL;
    const res = await configGet();
    expect(await res.text()).not.toContain(SENTINEL);
  });

  it("no client-delivered component reads a model credential", () => {
    // The key env vars may only be read server-side (config/factory), never in
    // components that ship to the browser.
    const files = walk(path.join(process.cwd(), "src/components"));
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return (
        src.includes("ANTHROPIC_API_KEY") || src.includes("OPENAI_API_KEY")
      );
    });
    expect(offenders).toEqual([]);
  });

  it("credential handling is contained to the server-only assistant lib", () => {
    // The catalogue may name a credential variable as data, with no reads.
    // Routes reach credentials through the assistant factory.
    const files = walk(path.join(process.cwd(), "src"));
    const stray = files
      .map((f) => path.relative(process.cwd(), f))
      .filter((f) => !f.endsWith(".test.ts"))
      .filter((f) => {
        const src = readFileSync(path.join(process.cwd(), f), "utf8");
        return (
          src.includes("ANTHROPIC_API_KEY") || src.includes("OPENAI_API_KEY")
        );
      })
      .filter((f) => !allowedCredentialLocation(f, readFileSync(f, "utf8")));
    expect(stray).toEqual([]);
  });

  it("refuses seeded credential reads in the catalogue while admitting its definitions", () => {
    const source = readFileSync(CATALOGUE, "utf8");
    expect(allowedCredentialLocation(CATALOGUE, source)).toBe(true);
    for (const seed of [
      "export const leaked = process.env.ANTHROPIC_API_KEY;",
      'export const leaked = process.env["OPENAI_API_KEY"];',
      'const env = process.env; const key = "OPENAI_API_KEY"; export const leaked = env[key];',
    ]) expect(allowedCredentialLocation(CATALOGUE, `${source}\n${seed}`)).toBe(false);
    expect(allowedCredentialLocation("src/lib/settings/other.ts", source)).toBe(false);
  });
});
