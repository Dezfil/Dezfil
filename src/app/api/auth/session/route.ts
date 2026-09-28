import { currentSession } from "@/lib/auth/entry";
export async function GET(request: Request) { return currentSession(request); }
