"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { liveActionLabel, videoFraction } from "./live";
import type { LiveProgress } from "./types";
import { collapse, fade, spring } from "./ui";

/** Wall-clock time, ticking once a second while `active`. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Seconds spent in the current step (the server's elapsedMs for the video stage when it reports one). */
export function currentStepSeconds(live: LiveProgress, now: number) {
  const current = live.steps[live.steps.length - 1];
  if (current?.stage === "video" && live.video && typeof live.video.elapsedMs === "number") {
    return Math.max(0, Math.round((live.video.elapsedMs + Math.max(0, now - live.video.at)) / 1000));
  }
  return Math.max(0, Math.round((now - (current?.at ?? live.startedAt)) / 1000));
}

export function Caret() {
  return <motion.span className="ml-px inline-block h-[1em] w-[2px] translate-y-[2px] bg-current" animate={{ opacity: [1, 0] }} transition={{ duration: 0.55, repeat: Infinity, repeatType: "reverse" }} aria-hidden="true" />;
}

export function Spinner() {
  return <span className="inline-block h-3 w-3 flex-none animate-spin-fast rounded-full border-2 border-[#3d5a44] border-t-mint" aria-hidden="true" />;
}

/** Compact "what the server is doing" line inside the pending chat bubble. */
export default function LiveStatus({ live, fallbackLabel, onCancel }: { live: LiveProgress; fallbackLabel: string; onCancel: () => void }) {
  const now = useNow(true);
  const [showSteps, setShowSteps] = useState(false);
  const current = live.steps[live.steps.length - 1];
  const done = live.steps.slice(0, -1);
  const seconds = currentStepSeconds(live, now);
  const fraction = current?.stage === "video" ? videoFraction(live) : null;
  const label = current?.label ?? fallbackLabel.replace(/…$/, "");

  return (
    <div className="flex min-w-[220px] flex-col gap-1.5">
      <AnimatePresence initial={false}>
        {live.intent && (
          <motion.span
            key="intent"
            className="self-start rounded-full border border-info-line bg-info-bg px-[9px] py-[3px] text-[11px] font-semibold text-[#dbe5ff]"
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={spring}
          >
            {liveActionLabel(live.intent)} <em className="ml-1 text-[10px] font-normal text-[#7f8fb5] not-italic">detected automatically{live.intent.detectedBy === "rules" ? " · by rules" : ""}</em>
          </motion.span>
        )}
      </AnimatePresence>

      <div className="flex items-center gap-2 text-[12px] text-[#b8c6b9]" role="status">
        <Spinner />
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={current?.stage ?? "start"} className="min-w-0 truncate" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={fade}>
            {label}…
          </motion.span>
        </AnimatePresence>
        {seconds >= 1 && <span className="flex-none text-[#7c7c7c] tabular-nums">{seconds}s</span>}
        {fraction !== null && <span className="flex-none text-[#7c7c7c] tabular-nums">· {Math.round(fraction * 100)}%</span>}
      </div>
      <span className="relative block h-[2px] overflow-hidden rounded-full bg-[#262626]" aria-hidden="true">
        {fraction !== null ? (
          <motion.i className="absolute inset-y-0 left-0 block rounded-full bg-green" initial={false} animate={{ width: `${Math.max(2, fraction * 100)}%` }} transition={{ duration: 0.3 }} />
        ) : (
          <motion.i className="absolute inset-y-0 block w-1/3 rounded-full bg-green/70 motion-reduce:hidden" initial={{ left: "-33%" }} animate={{ left: "100%" }} transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity }} />
        )}
      </span>

      {done.length > 0 && (
        <div>
          <button type="button" className="border-0 bg-transparent p-0 text-[10px] text-mint hover:text-white" aria-expanded={showSteps} onClick={() => setShowSteps((open) => !open)}>
            ✓ {done.length} step{done.length === 1 ? "" : "s"} <span className="text-[#7c7c7c]">{showSteps ? "▾" : "▸"}</span>
          </button>
          <AnimatePresence initial={false}>
            {showSteps && (
              <motion.ol key="steps" className="overflow-hidden" {...collapse}>
                {done.map((step) => <li key={`${step.stage}-${step.at}`} className="mt-0.5 text-[10px] text-[#8a8a8a]"><span className="text-mint">✓</span> {step.label}</li>)}
                {current && <li className="mt-0.5 text-[10px] text-[#b8c6b9]">⟳ {current.label}</li>}
              </motion.ol>
            )}
          </AnimatePresence>
        </div>
      )}

      <AnimatePresence initial={false}>
        {live.preview && (
          <motion.figure key={live.preview.imageUrl} className="m-0" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={spring}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="block aspect-video w-24 rounded-[6px] bg-black object-cover" src={live.preview.imageUrl} alt={live.preview.label ?? "Preview"} />
            {live.preview.label && <figcaption className="mt-[3px] text-[10px] text-[#8a8a8a]">{live.preview.label}</figcaption>}
          </motion.figure>
        )}
      </AnimatePresence>

      {live.enhancedPrompt && (
        <p className="m-0 line-clamp-2 text-[11px] leading-snug text-[#8a8a8a] [overflow-wrap:anywhere]" title={live.enhancedPrompt}>
          {live.enhancedPrompt}{live.typing === "enhancedPrompt" && <Caret />}
        </p>
      )}
      {live.reply && (
        <p className="m-0 text-[13px] whitespace-pre-wrap text-[#e8e8e8] [overflow-wrap:anywhere]">
          {live.reply}{live.typing === "reply" && <Caret />}
        </p>
      )}
      <button type="button" className="self-start border-0 bg-transparent p-0 text-[12px] text-link underline underline-offset-2 hover:text-white" onClick={onCancel}>Cancel</button>
    </div>
  );
}
