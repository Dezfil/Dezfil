import { leave } from "@/lib/auth/entry";
export async function POST(request: Request) { return leave(request); }
