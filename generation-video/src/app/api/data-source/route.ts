import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { getMockAnalyticalDataMetadata } from "@/lib/mock-analytical-data";
import { logInfo } from "@/lib/runtime-log";

export const runtime = "nodejs";

function routeGET() {
  const metadata = getMockAnalyticalDataMetadata();
  logInfo("data_source_metadata_served", {
    source: metadata.source,
    table: metadata.table.qualifiedName,
    columns: metadata.columns.length,
  });
  return NextResponse.json(metadata, {
    headers: {
      "Cache-Control": "no-store",
      "X-Data-Source": "local-mock",
      "X-Mock-Response": "true",
    },
  });
}

export const GET = withRouteLog(routeGET);
