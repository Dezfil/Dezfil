import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { templateSource } from "./template-source.mjs";

// Capture real provider requests and the package's served listing without
// contacting a provider or starting a listening server.
const directory = mkdtempSync(path.join(tmpdir(), "dezfil-assistant-baselines-"));
const previousDirectory = process.env.DEZFIL_DATA_DIR;
process.env.DEZFIL_DATA_DIR = directory;
const loader = templateSource();
const previousFetch = globalThis.fetch;
let client, closeMetadataDb;
try {
  ({ closeMetadataDb } = await import("../src/lib/metadata/db.ts"));
  const capture = await import("../src/lib/assistant/testing/frozen-baselines.ts");
  const { buildMcpFetchHandler } = await import("../src/lib/mcp/handler.ts");
  const openai = await capture.captureOpenAiRequest();
  const anthropic = await capture.captureAnthropicRequest();
  const handler = buildMcpFetchHandler();
  globalThis.fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(request.url).origin !== "http://localhost:3307" || new URL(request.url).pathname !== "/api/mcp") {
      throw new Error("Baseline capture attempted an unexpected request.");
    }
    return handler.fetch(request);
  };
  client = new Client({ name: "dezfil-contract-client", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3307/api/mcp")));
  const listing = await client.listTools();
  const identities = capture.captureIdentities();
  const manifest = JSON.parse(readFileSync(`${capture.BASELINE_DIR}/manifest.json`, "utf8"));
  const captures = {
    openaiRequest: openai,
    openaiToolDefinitions: capture.definitions(openai.tools),
    anthropicRequest: anthropic,
    anthropicToolDefinitions: capture.definitions(anthropic.tools),
    mcpListing: capture.definitions(listing.tools),
    identities,
  };
  for (const [key, value] of Object.entries(captures)) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(`${capture.BASELINE_DIR}/${manifest[key].file}`, text);
    manifest[key].sha256 = capture.sha256(text);
  }
  manifest.fixture = capture.FIXTURE_TURN;
  manifest.identities.counts = Object.fromEntries(Object.entries(identities).map(([key, values]) => [key, values.length]));
  manifest.packagePrompt = { path: capture.PACKAGE_PROMPT_PATH, ...capture.capturePackagePrompt() };
  writeFileSync(`${capture.BASELINE_DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("Wrote assistant baselines. Review every changed definition before committing.");
} finally {
  await client?.close();
  globalThis.fetch = previousFetch;
  closeMetadataDb?.();
  loader.deregister();
  if (previousDirectory === undefined) delete process.env.DEZFIL_DATA_DIR;
  else process.env.DEZFIL_DATA_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
}
