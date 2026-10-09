import { NextResponse } from "next/server";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { readInstanceSettings } from "@/lib/settings/read";
import { readServiceFacts } from "@/lib/settings/service-facts";
import { changeInstanceSettings } from "@/lib/settings/change";
import { admitServiceAddresses } from "@/lib/settings/address-admission";
import { smallJsonValue } from "@/lib/api/json-body";
import { ApiError } from "@/lib/api/errors";

export async function GET(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    // The services' caches are read from the data folder once the admin is
    // rechecked inside the read.
    const settings = readInstanceSettings(context);
    return privateResponse(NextResponse.json({ ...settings, services: await readServiceFacts() }));
  } catch (error) { return authFailure(error); }
}

export async function PATCH(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    const input = await smallJsonValue(request, () => null);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    // Resolving an address's name is asynchronous, so its check runs here,
    // before the write transaction; the write keeps only what it saw.
    const admission = await admitServiceAddresses(input);
    const settings = changeInstanceSettings(context, input, undefined, undefined, admission);
    return privateResponse(NextResponse.json({ ...settings, services: await readServiceFacts() }));
  } catch (error) { return authFailure(error); }
}
