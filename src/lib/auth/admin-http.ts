import { smallJsonValue } from "@/lib/api/json-body";
import { metadataDb } from "@/lib/metadata/db";
import { requireAdmin } from "./admin";
import { AuthError } from "./errors";
import { requestIngress, requireRequestAuth } from "./http";

export function requireRequestAdmin(request: Request) {
  const context = requireRequestAuth(request);
  requireAdmin(context, metadataDb(), Date.now());
  return context;
}

async function objectBody(request: Request, allowed: string[]) {
  const body: unknown = await smallJsonValue(request, () => null);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
      !body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.includes(key))) {
    throw new AuthError("invalid_request", "Enter the required account details.", 400);
  }
  return body as Record<string, unknown>;
}

export async function invitationBody(request: Request) {
  const body = await objectBody(request, ["name", "email", "isAdmin"]);
  if (typeof body.name !== "string" || typeof body.email !== "string" ||
      (body.isAdmin !== undefined && typeof body.isAdmin !== "boolean")) {
    throw new AuthError("invalid_request", "Enter a name, email and optional admin flag.", 400);
  }
  return { name: body.name, email: body.email, ...(body.isAdmin === undefined ? {} : { isAdmin: body.isAdmin as boolean }) };
}

export async function accessBody(request: Request) {
  const body = await objectBody(request, ["isAdmin", "status"]);
  if ((!Object.keys(body).length) || (body.isAdmin !== undefined && typeof body.isAdmin !== "boolean") ||
      (body.status !== undefined && body.status !== "active" && body.status !== "deactivated")) {
    throw new AuthError("invalid_request", "Choose an admin flag or active or deactivated status.", 400);
  }
  return body as { isAdmin?: boolean; status?: "active" | "deactivated" };
}

export async function deletionBody(request: Request) {
  const body = await objectBody(request, ["confirm", "confirmation", "email"]);
  if (body.confirm !== true || typeof body.confirmation !== "string" || !/^[a-f0-9]{64}$/.test(body.confirmation) ||
      body.email !== undefined && typeof body.email !== "string") {
    throw new AuthError("invalid_request", "Confirm deletion using a fresh preview.", 400);
  }
  return { confirm: true, confirmation: body.confirmation, ...(body.email === undefined ? {} : { email: body.email as string }) };
}

export function handOver(request: Request, issued: { account: unknown; secret?: string; expiresAt?: number }) {
  if (issued.secret === undefined || issued.expiresAt === undefined) return { account: issued.account };
  const url = new URL("/accept", requestIngress(request).origin);
  url.hash = new URLSearchParams({ secret: issued.secret }).toString();
  return { account: issued.account, signInUrl: url.href, expiresAt: new Date(issued.expiresAt).toISOString() };
}
