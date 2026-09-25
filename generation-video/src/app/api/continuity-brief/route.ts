import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { createMockContinuityBrief } from "@/lib/mock-video-agent";
import { logError, logInfo } from "@/lib/runtime-log";

async function routePOST(request: Request) {
  try {
    const body = await request.json() as { selectedColumns?: unknown };
    if (!Array.isArray(body.selectedColumns) || !body.selectedColumns.every((column) => typeof column === "string")) {
      logError("continuity_brief_rejected", { reason: "invalid_selected_columns" });
      return NextResponse.json({ error: "selectedColumns must be an array of column IDs." }, { status: 400 });
    }
    const brief = createMockContinuityBrief(body.selectedColumns);
    logInfo("continuity_brief_created", { selectedColumns: brief.selectedColumns.length, source: brief.source });
    return NextResponse.json(brief);
  } catch (error) {
    logError("continuity_brief_rejected", { reason: error instanceof Error ? error.message : "unknown_error" });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create continuity brief." },
      { status: 400 },
    );
  }
}

export const POST = withRouteLog(routePOST);
