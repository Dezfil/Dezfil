import { assistantRuns } from "@/lib/assistant/runs";

export async function GET() {
  return Response.json({ pending: assistantRuns.pending() }, { headers: { "cache-control": "no-store" } });
}
