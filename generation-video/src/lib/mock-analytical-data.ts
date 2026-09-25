/**
 * Local-only metadata for the future Rawtree-like analytical data integration.
 * This module deliberately contains no client, credentials, or network calls.
 */
export type MockAnalyticalValue = string | number | boolean | null;

export type MockAnalyticalColumn = {
  id: string;
  label: string;
  dataType: "string" | "number" | "boolean" | "timestamp";
  nullable: boolean;
  description: string;
  selectable: true;
};

export type MockAnalyticalTableReference = {
  catalog: "mock_local";
  namespace: "video_analytics";
  name: "generation_events";
  displayName: string;
  qualifiedName: string;
};

export type MockAnalyticalDataMetadata = {
  mock: true;
  source: "local-mock";
  sourceKind: "rawtree-like-schema-free-olap";
  message: string;
  table: MockAnalyticalTableReference;
  sqlPreview: string;
  columns: readonly MockAnalyticalColumn[];
  sampleRows: readonly Readonly<Record<string, MockAnalyticalValue>>[];
};

const table: MockAnalyticalTableReference = {
  catalog: "mock_local",
  namespace: "video_analytics",
  name: "generation_events",
  displayName: "Mock video generation events",
  qualifiedName: "mock_local.video_analytics.generation_events",
};

const columns = [
  {
    id: "event_id",
    label: "Event ID",
    dataType: "string",
    nullable: false,
    description: "Unique mock event identifier.",
    selectable: true,
  },
  {
    id: "occurred_at",
    label: "Occurred at",
    dataType: "timestamp",
    nullable: false,
    description: "Mock event timestamp in ISO 8601 format.",
    selectable: true,
  },
  {
    id: "shot_id",
    label: "Shot ID",
    dataType: "string",
    nullable: false,
    description: "Shot associated with the mock generation event.",
    selectable: true,
  },
  {
    id: "event_type",
    label: "Event type",
    dataType: "string",
    nullable: false,
    description: "Mock lifecycle event classification.",
    selectable: true,
  },
  {
    id: "duration_ms",
    label: "Duration (ms)",
    dataType: "number",
    nullable: true,
    description: "Mock processing duration, when available.",
    selectable: true,
  },
  {
    id: "estimated_cost_usd",
    label: "Estimated cost (USD)",
    dataType: "number",
    nullable: false,
    description: "Mock estimated generation cost in USD.",
    selectable: true,
  },
  {
    id: "approved",
    label: "Approved",
    dataType: "boolean",
    nullable: false,
    description: "Whether the mock output was approved.",
    selectable: true,
  },
] as const satisfies readonly MockAnalyticalColumn[];

const sampleRows = [
  {
    event_id: "mock_evt_001",
    occurred_at: "2026-09-25T16:40:00.000Z",
    shot_id: "01",
    event_type: "generation_completed",
    duration_ms: 4812,
    estimated_cost_usd: 0.42,
    approved: true,
  },
  {
    event_id: "mock_evt_002",
    occurred_at: "2026-09-25T16:42:00.000Z",
    shot_id: "02",
    event_type: "generation_completed",
    duration_ms: 5290,
    estimated_cost_usd: 0.35,
    approved: false,
  },
  {
    event_id: "mock_evt_003",
    occurred_at: "2026-09-25T16:44:00.000Z",
    shot_id: "03",
    event_type: "generation_queued",
    duration_ms: null,
    estimated_cost_usd: 0.28,
    approved: false,
  },
] as const satisfies readonly Readonly<Record<string, MockAnalyticalValue>>[];

const sqlPreview = `-- MOCK ONLY: illustrative SQL; no query is executed
SELECT
  event_id,
  occurred_at,
  shot_id,
  event_type,
  duration_ms,
  estimated_cost_usd,
  approved
FROM ${table.qualifiedName}
ORDER BY occurred_at DESC
LIMIT 100;`;

export function getMockAnalyticalDataMetadata(): MockAnalyticalDataMetadata {
  return {
    mock: true,
    source: "local-mock",
    sourceKind: "rawtree-like-schema-free-olap",
    message: "Mock analytical-data metadata generated locally; no external source was contacted.",
    table,
    sqlPreview,
    columns,
    sampleRows,
  };
}
