"use client";

import { AnimatePresence, motion } from "motion/react";
import BlobLoader from "@/components/BlobLoader";
import { Spinner, currentStepSeconds, useNow } from "./LiveStatus";
import { stepText, videoFraction } from "./live";
import type { HistoryKind, LiveProgress } from "./types";
import { CANCEL_BUTTON, cn, fade, fadeUp } from "./ui";

export function generatingLabel(kind: HistoryKind) {
  return kind === "rawtree" ? "Summarizing competitor moves" : kind === "storyboard" ? "Rendering your storyboard" : kind === "upload" ? "Importing your video" : kind === "ad" ? "Creating your ad" : kind === "company" ? "Creating your company short" : "Preparing your video";
}

export function generatingDetail(kind: HistoryKind, clipCopy: string) {
  return kind === "upload" ? "Preparing frames from your clip…" : kind === "rawtree" ? "Reading the latest competitor data from RawTree and rendering a short…" : kind === "storyboard" ? "Rendering scenes, motion, overlays, and narration…" : kind === "ad" ? "Writing your ad and rendering scenes… this takes 1–3 minutes." : kind === "company" ? "Writing your story and rendering scenes… this takes 1–3 minutes." : `Generating a ${clipCopy} clip with sound…`;
}

/** Step labels from the server may already end in an ellipsis; strip it so we never render "……". */
export { stepText };

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return total >= 60 ? `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`;
}

type GenerationStageProps = {
  kind: HistoryKind;
  clipCopy: string;
  prompt: string;
  live: LiveProgress | null;
  onCancel: () => void;
};

/** Full main-stage view while a new video is being generated: big loader, the prompt, live steps, preview, cancel. */
export default function GenerationStage({ kind, clipCopy, prompt, live, onCancel }: GenerationStageProps) {
  const now = useNow(true);
  const steps = live?.steps ?? [];
  const current = steps[steps.length - 1];
  const stepSeconds = live ? currentStepSeconds(live, now) : 0;
  const fraction = live ? videoFraction(live) : null;
  const detail = current ? `${stepText(current.label)}…${stepSeconds >= 1 ? ` ${stepSeconds}s` : ""}` : generatingDetail(kind, clipCopy);
  const totalElapsed = live ? formatElapsed(now - live.startedAt) : null;
  const typed = live?.enhancedPrompt || live?.reply || "";

  return (
    <motion.div className="mx-auto grid w-[min(100%,640px)] justify-items-center gap-5 text-center" role="status" aria-live="polite" {...fadeUp}>
      <BlobLoader label={generatingLabel(kind)} detail={detail} size={240} />

      {prompt.trim() && (
        <p className="m-0 max-w-[520px] text-[14px] leading-relaxed text-[#bdbdbd]">
          <span className="text-faint">“</span>{prompt.trim()}<span className="text-faint">”</span>
        </p>
      )}

      {fraction !== null && (
        <div className="h-1 w-[min(100%,360px)] overflow-hidden rounded-full bg-[#1d1d1d]" aria-hidden="true">
          <motion.div className="h-full rounded-full bg-[#5cbf8a]" animate={{ width: `${Math.round(fraction * 100)}%` }} transition={{ duration: 0.4, ease: "easeOut" }} />
        </div>
      )}

      {steps.length > 0 && (
        <ol className="m-0 grid w-[min(100%,420px)] list-none gap-1.5 p-0 text-left text-[12px]">
          <AnimatePresence initial={false}>
            {steps.map((step, index) => {
              const done = index < steps.length - 1;
              return (
                <motion.li key={`${step.stage}-${step.at}`} className={cn("flex items-center gap-2", done ? "text-[#7d8a80]" : "text-[#e8e8e8]")} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={fade}>
                  <span className="grid w-4 place-items-center" aria-hidden="true">{done ? <span className="text-[#5cbf8a]">✓</span> : <Spinner />}</span>
                  <span>{stepText(step.label)}</span>
                  {!done && stepSeconds >= 1 && <span className="ml-auto tabular-nums text-faint">{stepSeconds}s</span>}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      )}

      {typed && (
        <p className="m-0 line-clamp-3 max-w-[520px] text-[12px] italic leading-relaxed text-[#8f8f8f]">{typed}</p>
      )}

      <AnimatePresence>
        {live?.preview && (
          <motion.figure key={live.preview.imageUrl} className="m-0 grid justify-items-center gap-1.5" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={fade}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={live.preview.imageUrl} alt={live.preview.label ?? "Preview frame"} className="w-[min(100%,280px)] rounded-[10px] border border-border" />
            <figcaption className="text-[11px] text-faint">{live.preview.label ?? "First frame"} · preview</figcaption>
          </motion.figure>
        )}
      </AnimatePresence>

      <div className="flex items-center gap-3">
        {totalElapsed && <span className="text-[11px] tabular-nums text-faint">{totalElapsed} elapsed</span>}
        <button type="button" className={CANCEL_BUTTON} onClick={onCancel}>
          Cancel <kbd className="ml-1.5 rounded border border-[#3a3a3a] px-[5px] py-px [font-family:inherit] text-[10px] text-[#8a8a8a]">Esc</kbd>
        </button>
      </div>
    </motion.div>
  );
}
