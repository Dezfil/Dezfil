import { NextResponse } from "next/server";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { dataDir } from "@/lib/config";
import { ensureDataDir } from "@/lib/data-dir";
import { requireIngress } from "@/lib/auth/ingress.mjs";

/**
 * Readiness check: 200 when the instance can serve its purpose (storage
 * usable), 503 with a reason when it cannot. Headless drivers poll this
 * after `docker run`.
 */
export async function GET(request?: Request) {
  try {
    requireIngress(request?.headers);
    await ensureDataDir(dataDir());
    return NextResponse.json({ status: "ready" });
  } catch (error) {
    // The reason carries the documented sentence, never the failure's
    // own message — an EACCES/EROFS here carries the configured
    // absolute data path. The detail goes to the server log, where the
    // administrator diagnosing readiness reads it.
    console.error("[health] readiness unavailable:", error);
    return NextResponse.json(
      { status: "unready", reason: ERROR_CATALOGUE.internal },
      { status: 503 },
    );
  }
}
