import { enter } from "@/lib/auth/entry";
import { gateOnly, withRouteGate } from "@/lib/auth/route-gate";
export async function POST(request: Request) { return withRouteGate(request, () => enter(request, "redeem")); }
export async function GET(request: Request) { return gateOnly(request); }
export async function HEAD(request: Request) { return gateOnly(request); }
export async function OPTIONS(request: Request) { return gateOnly(request); }
export async function PUT(request: Request) { return gateOnly(request); }
export async function DELETE(request: Request) { return gateOnly(request); }
export async function PATCH(request: Request) { return gateOnly(request); }
