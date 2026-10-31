import { arriveExternalSignIn } from "@/lib/auth/external-sign-in/arrival";
export async function POST(request: Request) { return arriveExternalSignIn(request); }
