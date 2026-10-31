import type { NextRequest } from "next/server";
import { gateRequest } from "@/lib/auth/gate";
import { withPagePresence } from "@/lib/auth/page-presence";
export function proxy(request: NextRequest) { return withPagePresence(request, gateRequest(request)); }
export const config = { matcher: ["/((?!api/tables/?$|api/account/picture/?$|api/published/[^/]+/widget-values/?$|api/published/[^/]+/render/[^/]+/?$|api/published/[^/]+/extent/[^/]+/?$|api/auth/sign-in/?$|api/auth/setup/?$|api/auth/redeem/?$|api/auth/external/start/?$|api/auth/external/arrive/?$|arrive/?$).*)"] };
