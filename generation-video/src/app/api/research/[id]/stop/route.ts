import { withRouteLog } from "@/lib/route-log";
import { badSessionId, proxyJson } from "@/lib/research-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST (no body needed) → `{ session_id, status }`. Stopping is final; start a new session to research again. */
async function routePOST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return badSessionId(id) ?? proxyJson("research_stop", `/research/${id}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

export const POST = withRouteLog(routePOST);
