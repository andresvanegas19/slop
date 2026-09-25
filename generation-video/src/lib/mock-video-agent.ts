import { getMockAnalyticalDataMetadata } from "@/lib/mock-analytical-data";

export function createMockContinuityBrief(selectedColumns: string[]) {
  const metadata = getMockAnalyticalDataMetadata();
  const allowedColumns = new Set(metadata.columns.map((column) => column.id));
  const columns = selectedColumns.filter((column) => allowedColumns.has(column));

  if (columns.length === 0) {
    throw new Error("Select at least one analytical field before running the continuity agent.");
  }

  return {
    mock: true,
    source: metadata.table.qualifiedName,
    selectedColumns: columns,
    summary: "Milo follows a glowing seed from the farmyard into the field.",
    recommendations: [
      "Keep Milo's yellow feathers, red scarf, clay texture, and warm sunrise lighting locked across all shots.",
      "Use Shot 01's approved final frame as the image reference for Shot 02 and preserve Milo's screen direction.",
      "Use the selected cost and duration signals to reserve new generation for key beats and use pan/zoom for quieter bridges.",
    ],
  };
}
