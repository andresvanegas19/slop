/* Shared studio types (moved verbatim from app/page.tsx). */
import type { Storyline } from "@/lib/storyline";

export type MediaType = "storyboard" | "rawtree" | "market" | "ad" | "company" | "stories";
export type PresetType = "ad" | "company";
/** "rawtree" = legacy competitor summaries (kept so old history items still render); new ones are "market". */
export type HistoryKind = "clip" | "storyboard" | "rawtree" | "market" | "upload" | "ad" | "company";

export type ProjectFrame = { index: number; imageUrl: string; prompt: string; startSec: number; durationSec: number; narration?: string; headline?: string; sub?: string; segmentUrl?: string; source?: "generated" | "upload"; edits?: FrameEdit[] };
export type FrameEdit = { atSec: number; windowSec?: number; rangeStartSec?: number; rangeEndSec?: number; prompt: string; at: string };
export type RangeDrag = { mode: "new" | "start" | "end" | "move"; startX: number; anchorSec: number; original: TimeWindow | null; moved: boolean; pointerId: number };
export type TimeWindow = { startSec: number; endSec: number };
export type ChatMessage = { role: "user" | "assistant"; text: string; at: string; edited?: boolean; atSec?: number; rangeStartSec?: number; rangeEndSec?: number; grabbedFrameUrl?: string; enhancedPrompt?: string; ragSources?: unknown; memorySources?: unknown };
/** Where a piece of memory used for a reply came from (server MemorySource). */
export type MemoryChip = { kind: "knowledge" | "video" | "user_prompt" | "research" | "example"; title: string; ref: string; url?: string; at?: string; score: number };
export type ThreadEntry = { id: string; role: "user" | "assistant"; text: string; at: string; context?: string; thumbUrl?: string; edited?: boolean; note?: string; beforeUrl?: string; afterUrl?: string; enhancedPrompt?: string; ragSources?: string[]; memorySources?: MemoryChip[]; action?: { label: string; detectedBy: "llm" | "rules" }; suggestion?: NewVideoSuggestion };
/** `target`: what the running edit changes (the player overlay / timeline shimmer show it). */
export type PendingOp = { user: ThreadEntry; detail: string; error: string | null; live?: LiveProgress; target?: { window?: TimeWindow | null; append?: boolean } };
/** "This sounds like a new video" (auto mode's new_video intent): the preset + prompt to start it with. */
export type NewVideoSuggestion = { preset: "company" | "ad" | "clip"; prompt: string };
/** What the server has reported so far while streaming an operation (see stream.ts / live.ts). */
export type LiveStep = { stage: string; label: string; at: number };
export type LiveProgress = {
  startedAt: number;
  steps: LiveStep[];
  intent?: { action: string; detectedBy: "llm" | "rules"; atEnd?: boolean; window?: TimeWindow };
  reply: string;
  enhancedPrompt: string;
  typing: "reply" | "enhancedPrompt" | null;
  preview?: { imageUrl: string; label?: string };
  video?: { status?: string; progress?: number; elapsedMs?: number; at: number };
};
export type Project = { id: string; kind: "clip" | "storyboard"; title: string; createdAt: string; updatedAt: string; videoUrl: string; durationSeconds: number; frames: ProjectFrame[]; chats: Record<string, ChatMessage[]> };

export type HistoryItem = { projectId: string; title: string; videoUrl: string; thumbUrl: string; durationSeconds: number; createdAt: string; kind: HistoryKind; generatedSeconds?: number; researchSessionId?: string };
export type Upload = { id: string; videoUrl: string; thumbUrl: string; durationSeconds: number; width: number; height: number; hasAudio: boolean; filename: string };
export type Attachment = { key: number; file: File; previewUrl: string; progress: number; status: "uploading" | "done" | "error"; localDuration?: number; upload?: Upload; error?: string };
export type ContinueAction = "auto" | "edit" | "append";
export type CommandResult = { action?: unknown; detectedBy?: unknown; summary?: unknown; reply?: unknown; project?: unknown; window?: unknown; appendedFrameIndexes?: unknown; removed?: unknown; enhancedPrompt?: unknown; ragSources?: unknown; memorySources?: unknown; grabbedFrameUrl?: unknown; atEnd?: unknown; suggestion?: unknown; error?: unknown };
export type BusyState = { label: string; detail: string };
export type AppendResult = { project?: unknown; appendedFrameIndex?: unknown; enhancedPrompt?: unknown; ragSources?: unknown; memorySources?: unknown; error?: unknown };
export type FrameGrab = { key: number; atSec: number; thumbUrl: string | null; captured: boolean };

export type RenderIssue = { path?: unknown; code?: unknown; message?: unknown };
export type RenderResult = {
  videoUrl?: unknown;
  durationSeconds?: unknown;
  narrationAvailable?: unknown;
  project?: unknown;
  error?: unknown;
  details?: unknown;
};
export type AskResult = { reply?: unknown; edited?: unknown; project?: unknown; enhancedPrompt?: unknown; grabbedFrameUrl?: unknown; window?: unknown; error?: unknown };

/* ---- Company research sessions (/api/research) ---- */
export type ResearchQuestion = { id: string; question: string; options: string[]; answered: boolean; answer?: string };
export type ResearchFinding = { key: string; text: string; source?: string; title?: string };
export type ResearchStats = { pages: number; findings: number; tokens: number };
/** A competitor the agent researched; it informs the differentiation only and is never named in the ad. */
export type ResearchCompetitor = { id: string; name: string; domain?: string; verified: boolean; summary?: string; claims: string[]; pages: number; stage?: string; currentPage?: string; error?: string };
export type ResearchCompetitors = { status: string; message?: string; items: ResearchCompetitor[]; differentiators: string[]; avoidTerms: string[] };
export type ResearchSession = {
  id: string;
  prompt: string;
  company: string;
  durationSec: number;
  startedAt: string;
  status: string;
  statusLabel?: string;
  currentPage?: string;
  profile: unknown;
  published: boolean;
  questions: ResearchQuestion[];
  findings: ResearchFinding[];
  stats: ResearchStats;
  looping: boolean;
  lastSeq: number;
  pagesSeen: number;
  error?: string;
  competitors?: ResearchCompetitors;
  /** The latest storyline (validated with parseStoryline) and whether the agent is writing one. */
  storyline?: Storyline | null;
  storylineWriting?: boolean;
};

/* ---- Market updates (/api/market, contracts/market.py MarketSessionView) ---- */
export type MarketStatus = "starting" | "discovering" | "collecting" | "analyzing" | "storyboarding" | "ready" | "error";
export type MarketCompetitor = { entity_id: string; name: string; domain?: string | null; reason?: string };
export type MarketDevelopment = { development_id: string; entity_name: string; kind: string; headline: string; summary?: string; url: string; source_name?: string; significance: number };
export type MarketView = {
  session_id: string;
  status: MarketStatus;
  message: string;
  company: { name: string; domain?: string | null; category?: string } | null;
  competitors: MarketCompetitor[];
  pages_fetched: number;
  developments: MarketDevelopment[];
  storyboard_id: string | null;
  error: string | null;
  events: { at: string; stage: MarketStatus; message: string }[];
};
/** The home screen's market-update run: the agent session, then the render of its stored storyboard. */
export type MarketRun = {
  id: string;
  prompt: string;
  startedAt: string;
  view: MarketView | null;
  /** Polling problem (agent unreachable, session lost). Polling stops when set. */
  pollError: string | null;
  render: { status: "idle" | "rendering" | "done" | "error"; error?: string };
};
