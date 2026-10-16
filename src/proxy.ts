import type { NextRequest } from "next/server";
import { gateRequest } from "@/lib/auth/gate";
export function proxy(request: NextRequest) { return gateRequest(request); }
export const config = { matcher: ["/((?!api/tables/?$|api/published/[^/]+/widget-values/?$|api/published/[^/]+/render/[^/]+/?$|api/published/[^/]+/extent/[^/]+/?$|api/auth/sign-in/?$|api/auth/setup/?$|api/auth/redeem/?$).*)"] };
