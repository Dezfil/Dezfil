import { enter } from "@/lib/auth/entry";
export async function POST(request: Request) { return enter(request, "redeem"); }
