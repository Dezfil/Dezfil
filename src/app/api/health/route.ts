import { NextResponse } from "next/server";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { dataDir } from "@/lib/config";
import { ensureDataDir } from "@/lib/data-dir";
import { requireIngress } from "@/lib/auth/ingress.mjs";
import { ENGINE_UNREADY, queryEngineAnswers } from "@/lib/system/engine-readiness";

/**
 * Readiness check: 200 when the instance can serve its purpose (storage
 * usable, and the engine that runs people's SQL answering once something
 * has started it; see system/engine-readiness), 503 with a reason when it
 * cannot. Headless drivers poll this after `docker run`.
 */
export async function GET(request?: Request) {
  try {
    requireIngress(request?.headers);
    await ensureDataDir(dataDir());
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
  if (!(await queryEngineAnswers())) {
    return NextResponse.json(
      { status: "unready", reason: ENGINE_UNREADY },
      { status: 503 },
    );
  }
  return NextResponse.json({ status: "ready" });
}
