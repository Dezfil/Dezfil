import { NextResponse } from "next/server";
import { withStorageRecovery } from "@/lib/system/storage-reserve";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { signEveryoneOut } from "@/lib/auth/sign-out-everyone";
export async function POST(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    return privateResponse(NextResponse.json(await withStorageRecovery(() => signEveryoneOut(context))));
  }
  catch (error) { return authFailure(error); }
}
