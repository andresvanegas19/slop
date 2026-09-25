"use client";

import { AnimatePresence, motion } from "motion/react";
import BlobLoader from "@/components/BlobLoader";
import { currentStepSeconds, useNow } from "./LiveStatus";
import type { HistoryItem, HistoryKind, LiveProgress } from "./types";
import { CANCEL_BUTTON, HistoryRowContent, LABEL, cn, collapse, fade, pop, springSoft } from "./ui";

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

function generatingLabel(kind: HistoryKind) {
  return kind === "market" ? "Rendering your market update" : kind === "storyboard" ? "Rendering your storyboard" : kind === "upload" ? "Importing your video" : kind === "ad" ? "Creating your ad" : kind === "company" ? "Creating your company short" : "Preparing your video";
}

function generatingDetail(kind: HistoryKind, clipCopy: string) {
  return kind === "upload" ? "Preparing frames from your clip…" : kind === "market" ? "Filming each development as a cinematic shot… this takes a few minutes." : kind === "storyboard" ? "Rendering scenes, motion, overlays, and narration…" : kind === "ad" ? "Writing your ad and rendering scenes… this takes 1–3 minutes." : kind === "company" ? "Writing your story and rendering scenes… this takes 1–3 minutes." : `Generating a ${clipCopy} clip with sound…`;
}

/** The side panel's default view: generating card, collapsible history list, and the output note. */
export default function HistoryPanel({ history, isHistoryOpen, onToggleHistory, openProjectId, onOpenProject, isGenerating, generatingKind, clipCopy, onCancelGeneration, generationLive }: HistoryPanelProps) {
  const now = useNow(isGenerating && generationLive !== null);
  const step = generationLive?.steps[generationLive.steps.length - 1];
  const seconds = generationLive ? currentStepSeconds(generationLive, now) : 0;
  const liveDetail = step ? `${step.label}…${seconds >= 1 ? ` ${seconds}s` : ""}` : null;
  return (
    <>
      <AnimatePresence initial={false}>
        {isGenerating && (
          <motion.div key="generating" className="overflow-hidden" {...collapse}>
            <motion.div
              className="mt-[28px] grid justify-items-center rounded-[13px] border border-[#1f3a26] bg-[#0b0b0b] bg-[radial-gradient(circle_at_50%_40%,#0f2a1655,transparent_70%)] px-2.5 py-4 text-center"
              initial={{ scale: 0.97 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.97 }}
              transition={pop.transition}
            >
              <BlobLoader label={generatingLabel(generatingKind)} detail={liveDetail ?? generatingDetail(generatingKind, clipCopy)} size={200} />
              <button type="button" className={CANCEL_BUTTON} onClick={onCancelGeneration}>Cancel <kbd className="ml-1.5 rounded border border-[#3a3a3a] px-[5px] py-px [font-family:inherit] text-[10px] text-[#8a8a8a]">Esc</kbd></button>
            </motion.div>
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
