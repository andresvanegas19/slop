"use client";

import { AnimatePresence, motion } from "motion/react";
import { generatingLabel, stepText } from "./GenerationStage";
import { Spinner, useNow } from "./LiveStatus";
import type { HistoryItem, HistoryKind, LiveProgress } from "./types";
import { HistoryRowContent, LABEL, cn, collapse, fade, springSoft } from "./ui";

type HistoryPanelProps = {
  history: HistoryItem[];
  isHistoryOpen: boolean;
  onToggleHistory: (open: boolean) => void;
  openProjectId: string | null;
  onOpenProject: (item: HistoryItem) => void;
  isGenerating: boolean;
  generatingKind: HistoryKind;
  clipCopy: string;
  onCancelGeneration: () => void;
  /** Streamed progress for the running generation, when the server sends it. */
  generationLive: LiveProgress | null;
};

/** The side panel's default view: generating card, collapsible history list, and the output note. */
/** One-line "generating" row (spinner · label · elapsed · ✕); the main stage shows the full GenerationStage view. */
export function GeneratingRow({ kind, live, onCancel, className }: { kind: HistoryKind; live: LiveProgress | null; onCancel: () => void; className?: string }) {
  const now = useNow(true);
  const step = live?.steps[live.steps.length - 1];
  const elapsed = live ? Math.max(0, Math.round((now - live.startedAt) / 1000)) : null;
  const label = step ? stepText(step.label) : generatingLabel(kind);
  return (
    <div className={cn("flex items-center gap-2 rounded-[10px] border border-[#1f3a26] bg-[#0b0b0b] px-2.5 py-2 text-left text-[12px] text-[#cfe3d4]", className)} role="status">
      <Spinner />
      <span className="min-w-0 flex-1 truncate" title={label}>{label}…</span>
      {elapsed !== null && elapsed >= 1 && <span className="flex-none text-[11px] text-faint tabular-nums">{elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, "0")}s` : `${elapsed}s`}</span>}
      <button type="button" className="grid h-5 w-5 flex-none place-items-center rounded-full border-0 bg-[#1f1f1f] text-[10px] text-[#9a9a9a] hover:bg-[#333] hover:text-white" onClick={onCancel} aria-label="Cancel generation" title="Cancel (Esc)">✕</button>
    </div>
  );
}

export default function HistoryPanel({ history, isHistoryOpen, onToggleHistory, openProjectId, onOpenProject, isGenerating, generatingKind, onCancelGeneration, generationLive }: HistoryPanelProps) {
  return (
    <>
      <AnimatePresence initial={false}>
        {isGenerating && (
          <motion.div key="generating" className="overflow-hidden" {...collapse}>
            <GeneratingRow className="mt-[28px]" kind={generatingKind} live={generationLive} onCancel={onCancelGeneration} />
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mt-[28px]">
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-[9px] border border-transparent bg-transparent px-1.5 py-2 hover:border-border hover:bg-[#171717] focus-visible:border-border focus-visible:bg-[#171717] focus-visible:outline-0"
          aria-expanded={isHistoryOpen}
          aria-controls="history-list"
          onClick={() => onToggleHistory(!isHistoryOpen)}
        >
          <span className={LABEL}>History ({history.length})</span>
          <motion.span className="text-[18px] leading-none text-[#8a8a8a]" animate={{ rotate: isHistoryOpen ? 90 : 0 }} transition={springSoft} aria-hidden="true">›</motion.span>
        </button>
        <AnimatePresence initial={false}>
          {isHistoryOpen && (
            <motion.div id="history-list" key="history-list" className="overflow-hidden" {...collapse}>
              {history.length === 0 ? (
                <p className="mx-1.5 mt-1.5 text-[10px] leading-normal text-faint">Finished videos are saved here. Click one to edit it frame by frame.</p>
              ) : (
                <ul className="mt-1.5 grid gap-1.5">
                  <AnimatePresence initial={false}>
                    {history.map((item) => (
                      <motion.li key={item.projectId} layout="position" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={fade}>
                        <button
                          type="button"
                          className={cn(
                            "flex w-full items-center gap-[11px] rounded-[11px] border p-1.5 text-left text-[#e6e6e6] transition-[background-color,border-color] duration-150 focus-visible:outline-0",
                            item.projectId === openProjectId ? "border-info-line bg-info-bg" : "border-transparent bg-transparent hover:border-[#333] hover:bg-[#1a1a1a] focus-visible:border-[#333] focus-visible:bg-[#1a1a1a]",
                          )}
                          onClick={() => onOpenProject(item)}
                          title={`Open “${item.title}” in the editor`}
                        >
                          <HistoryRowContent item={item} />
                        </button>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <p className="mt-auto text-[10px] text-faint max-[760px]:hidden">Generated files remain local in <code className="text-[#acacac]">output/</code>.</p>
    </>
  );
}
