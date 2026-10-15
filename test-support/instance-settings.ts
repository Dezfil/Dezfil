import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import * as metadata from "../src/lib/metadata/db";
import { SETTING_CATALOGUE } from "../src/lib/settings/catalogue";
import { testAccountScope } from "../src/lib/test-support/accounts";
import { getAccount } from "../src/lib/metadata/accounts";
import { authenticateSession, createApiToken, issueSession } from "../src/lib/auth/credentials";
import { socketRequest } from "../src/lib/assistant/testing/socket-request";

export function instanceSettingsFixture() {
  const root = process.env.DEZFIL_DATA_DIR ?? path.join(process.cwd(), ".claude/test-data");
  for (const definition of SETTING_CATALOGUE) if (definition.environment) vi.stubEnv(definition.environment, undefined);
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "instance-read-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  const db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  testAccountScope(db, "member");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  const admin = issueSession(getAccount("admin", db)!, db, Date.now());
  const member = issueSession(getAccount("member", db)!, db, Date.now());
  const context = authenticateSession(admin.secret, db)!;
  const token = createApiToken(context, "Read configuration", db);
  return { db, dir, admin, member, context, token,
    request(headers: Record<string, string> = { cookie: `dezfil_session=${admin.secret}` }, method = "GET") {
      return socketRequest(new Request("http://instance.test/api/instance/settings", { method, headers }));
    },
    close() { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export const DISCLOSURE_SEEDS = {
  ANTHROPIC_API_KEY: "seed-provider-anthropic-secret",
  OPENAI_API_KEY: "seed-provider-openai-secret",
  DEZFIL_SECRET_KEY: "ab".repeat(32),
  DEZFIL_GEOCODER_URL: "https://seed-user:seed-password@geocoder.example/seed-geocoder-path?key=seed-geocoder-query",
  DEZFIL_ISOCHRONE_URL: "https://router.example/seed-routing-path?key=seed-routing-query",
  DEZFIL_SATELLITE_URL: "https://imagery.example/seed-template-path/{z}/{x}/{y}?key=seed-template-query",
  DEZFIL_BASEMAP_URL: "https://maps.example/seed-style-path?key=seed-style-query",
  DEZFIL_OVERPASS_URL: "https://osm.example/seed-overpass-path?key=seed-overpass-query",
  DEZFIL_S3_ENDPOINT: "https://objects.example/seed-s3-path?key=seed-s3-query",
  DEZFIL_OVERTURE_S3_ENDPOINT: "seed-malformed-address",
  DEZFIL_TEMPLATES_CATALOGUE: "/srv/seed-catalogue-folder/catalogue",
} as const;
export const FORBIDDEN_DISCLOSURE = [
  ...Object.values(DISCLOSURE_SEEDS), "seed-user", "seed-password", "seed-geocoder-path", "seed-geocoder-query",
  "seed-routing-path", "seed-routing-query", "seed-template-path", "seed-template-query", "seed-style-path",
  "seed-style-query", "seed-overpass-path", "seed-overpass-query", "seed-s3-path", "seed-s3-query", "seed-catalogue-folder",
];
