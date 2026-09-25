"use client";

import { motion, type Variants } from "motion/react";
import type { ReactNode, RefObject } from "react";
import BlobLoader from "@/components/BlobLoader";
import LiveStatus from "./LiveStatus";
import type { MemoryChip, NewVideoSuggestion, PendingOp, ThreadEntry } from "./types";
import { cn, fade, spring } from "./ui";

type ChatThreadProps = {
  threadRef: RefObject<HTMLDivElement | null>;
  thread: ThreadEntry[];
  pendingOp: PendingOp | null;
  isEditing: boolean;
  onRetry: () => void;
  onCancel: () => void;
  /** Messages rendered before the thread (e.g. a company research session). */
  lead?: ReactNode;
  /** "This sounds like a new video" bubbles: start it (closes the editor) or keep editing. */
  onStartNewVideo?: (suggestion: NewVideoSuggestion) => void;
  onKeepEditing?: () => void;
};

type SuggestionActions = { onStartNewVideo?: (suggestion: NewVideoSuggestion) => void; onKeepEditing?: () => void };

const SUGGESTION_LABEL: Record<NewVideoSuggestion["preset"], string> = { company: "Start a new company video", ad: "Start a new ad", clip: "Start a new video" };

const list: Variants = { hidden: {}, visible: { transition: { staggerChildren: 0.035 } } };
export const bubble: Variants = { hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0, transition: fade } };
export const BUBBLE = "flex max-w-[82%] gap-2.5 rounded-[16px] px-[13px] py-2.5 text-[13px] leading-normal max-[760px]:max-w-[92%]";
export const TEXT = "m-0 whitespace-pre-wrap [overflow-wrap:anywhere]";
export const LINK = "mt-1 self-start border-0 bg-transparent p-0 text-[12px] text-link underline underline-offset-2 hover:text-white disabled:opacity-50";

function Figure({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="m-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="block aspect-video w-[132px] rounded-[8px] bg-black object-cover max-[760px]:w-[104px]" src={src} alt={alt} />
      <figcaption className="mt-[3px] text-[10px] text-[#8a8a8a]">{caption}</figcaption>
    </figure>
  );
}

function Entry({ entry, actions }: { entry: ThreadEntry; actions?: SuggestionActions }) {
  if (entry.role === "user") {
    return (
      <motion.div variants={bubble} className={cn(BUBBLE, "items-center self-end rounded-br-[5px] bg-blue text-white")}>
        {entry.thumbUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="aspect-video w-14 flex-none rounded-[6px] object-cover" src={entry.thumbUrl} alt="" />
        )}
        <div>
          <p className={TEXT}>{entry.text}</p>
          {entry.context && <small className="mt-[3px] block text-[10px] text-[#d6e0ff] opacity-85">{entry.context}</small>}
        </div>
      </motion.div>
    );
  }
  return (
    <motion.div variants={bubble} className={cn(BUBBLE, "flex-col self-start rounded-bl-[5px] border bg-surface text-[#e8e8e8]", entry.edited ? "border-ok-line" : "border-border")}>
      {entry.action && (
        <motion.span
          className="self-start rounded-full border border-info-line bg-info-bg px-[9px] py-[3px] text-[11px] font-semibold text-[#dbe5ff]"
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...spring, delay: 0.08 }}
        >
          {entry.action.label} <em className="ml-1 text-[10px] font-normal text-[#7f8fb5] not-italic">detected automatically{entry.action.detectedBy === "rules" ? " · by rules" : ""}</em>
        </motion.span>
      )}
      {entry.text && <p className={TEXT}>{entry.text}</p>}
      {entry.suggestion && actions?.onStartNewVideo && (
        <div className="mt-0.5 flex flex-wrap gap-1.5">
          <button type="button" className="rounded-full border border-accent bg-accent px-3 py-1.5 text-[12px] text-white hover:brightness-110" onClick={() => actions.onStartNewVideo?.(entry.suggestion!)}>
            {SUGGESTION_LABEL[entry.suggestion.preset]}
          </button>
          <button type="button" className="rounded-full border border-chip-line bg-chip px-3 py-1.5 text-[12px] text-[#cfcfcf] hover:bg-chip-hover hover:text-white" onClick={actions.onKeepEditing}>
            Keep editing this one
          </button>
        </div>
      )}
      {entry.edited && (entry.beforeUrl || entry.afterUrl) && (
        <div className="flex items-center gap-2">
          {entry.beforeUrl && <Figure src={entry.beforeUrl} alt="Before" caption="Before" />}
          {entry.beforeUrl && entry.afterUrl && <span className="text-[#777]" aria-hidden="true">→</span>}
          {entry.afterUrl && <Figure src={entry.afterUrl} alt="After" caption={entry.beforeUrl ? "After" : "New shot"} />}
        </div>
      )}
      {entry.note && <small className="text-[11px] text-mint">✓ {entry.note}</small>}
      {entry.enhancedPrompt && (
        <details className="text-[12px] text-[#a9a9a9]">
          <summary className="cursor-pointer text-[11px] text-link">Enhanced prompt</summary>
          <p className={cn(TEXT, "mt-1 text-[#bdbdbd]")}>{entry.enhancedPrompt}</p>
        </details>
      )}
      {entry.memorySources ? <MemoryRow sources={entry.memorySources} /> : entry.ragSources && <small className="text-[10px] text-[#7c7c7c]">Used guidance: {entry.ragSources.join(", ")}</small>}
    </motion.div>
  );
}

const MEMORY_ICON: Record<MemoryChip["kind"], string> = { knowledge: "📚", video: "🎞", user_prompt: "💬", research: "🔎", example: "✦" };

function sinceLabel(at?: string) {
  const time = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, (Date.now() - time) / 60_000);
  return minutes < 60 ? `${Math.round(minutes)}m ago` : minutes < 2_880 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1_440)}d ago`;
}

function chipLabel(source: MemoryChip) {
  if (source.kind === "knowledge") {
    const [doc, section] = source.title.split(" — ");
    return section ? `${doc.split(" ").slice(0, 2).join(" ")} › ${section}` : doc;
  }
  if (source.kind === "user_prompt") return [source.title === "Your usual style" ? "your usual style" : `“${source.title}”`, sinceLabel(source.at)].filter(Boolean).join(" · ");
  if (source.kind === "example") return ["past edit", sinceLabel(source.at)].filter(Boolean).join(" · ");
  return source.title;
}

/** "Memory used" chips: where the context for this reply came from (docs, past videos, your prompts, research). */
function MemoryRow({ sources }: { sources: MemoryChip[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px] text-[#7c7c7c]" aria-label="Memory used">
      <span className="mr-0.5">Memory used</span>
      {sources.slice(0, 6).map((source) => {
        const body = (
          <>
            <span aria-hidden="true">{MEMORY_ICON[source.kind]}</span>
            <span className="max-w-[180px] truncate">{chipLabel(source)}</span>
          </>
        );
        const className = "inline-flex max-w-[210px] items-center gap-1 rounded-full border border-[#2a2a2a] bg-[#161616] px-1.5 py-[1px] text-[#8d8d8d]";
        const title = `${source.kind.replace("_", " ")} · ${source.ref} · score ${source.score}`;
        return source.url ? (
          <a key={`${source.kind}:${source.ref}`} className={cn(className, "hover:border-[#3a3a3a] hover:text-[#b5b5b5]")} href={source.url} target="_blank" rel="noreferrer" title={title}>{body}</a>
        ) : (
          <span key={`${source.kind}:${source.ref}`} className={className} title={title}>{body}</span>
        );
      })}
    </div>
  );
}

/** Continue-mode conversation: saved + local entries, then the pending operation (running or failed with Retry). */
export default function ChatThread({ threadRef, thread, pendingOp, isEditing, onRetry, onCancel, lead, onStartNewVideo, onKeepEditing }: ChatThreadProps) {
  // Only the latest new-video suggestion keeps its buttons.
  const lastSuggestion = [...thread].reverse().find((entry) => entry.suggestion)?.id;
  return (
    <motion.div
      className="mt-[14px] mb-4 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1.5 py-2 text-left [scrollbar-color:#333_transparent] max-[760px]:max-h-[60vh]"
      ref={threadRef}
      aria-live="polite"
      variants={list}
      initial="hidden"
      animate="visible"
    >
      {lead}
      {thread.map((entry) => <Entry key={entry.id} entry={entry} actions={entry.id === lastSuggestion ? { onStartNewVideo, onKeepEditing } : undefined} />)}
      {pendingOp && (
        <>
          <Entry key={pendingOp.user.id} entry={pendingOp.user} />
          {pendingOp.error ? (
            <motion.div key="pending-error" variants={bubble} className={cn(BUBBLE, "flex-col self-start rounded-bl-[5px] border border-danger-line bg-[#2a121255] text-danger-soft")} role="alert">
              <p className={TEXT}>{pendingOp.error}</p>
              <button type="button" className={LINK} onClick={onRetry} disabled={isEditing}>↻ Retry</button>
            </motion.div>
          ) : pendingOp.live ? (
            <motion.div key="pending-live" variants={bubble} className={cn(BUBBLE, "flex-col self-start rounded-bl-[5px] border border-border bg-surface text-[#e8e8e8]")}>
              <LiveStatus live={pendingOp.live} fallbackLabel={pendingOp.detail} onCancel={onCancel} />
            </motion.div>
          ) : (
            <motion.div key="pending-running" variants={bubble} className={cn(BUBBLE, "flex-row items-center self-start rounded-bl-[5px] border border-border bg-surface text-[#e8e8e8]")}>
              <BlobLoader label="Working…" size={56} />
              <div>
                <p className={cn(TEXT, "text-[12px] text-[#b8c6b9]")}>{pendingOp.detail}</p>
                <button type="button" className={LINK} onClick={onCancel}>Cancel</button>
              </div>
            </motion.div>
          )}
        </>
      )}
    </motion.div>
  );
}
