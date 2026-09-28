import { entryInformation } from "@/lib/auth/entry";
export async function GET(request: Request) { return entryInformation(request); }
