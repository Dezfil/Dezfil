import type { NextRequest } from "next/server";
import { gateRequest } from "@/lib/auth/gate";
export function proxy(request: NextRequest) { return gateRequest(request); }
export const config = { matcher: ["/:path*"] };
