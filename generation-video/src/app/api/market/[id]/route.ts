import { NextResponse } from "next/server";
import { MARKET_SESSION_ID, proxyMarket } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET → MarketSessionView (contracts/market.py): `{ session_id, status, message, company, competitors, pages_fetched,
 * developments, storyboard_id, watch_id, published, error, events, started_at, updated_at }`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!MARKET_SESSION_ID.test(id)) {
    return NextResponse.json({ error: `"${id.slice(0, 80)}" is not a market session id.` }, { status: 400 });
  }
  return proxyMarket(request, "market_get", `/market/${id}`);
}
