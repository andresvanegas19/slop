"use client";

import { motion, type Transition } from "motion/react";
import type { ReactNode } from "react";
import type { HistoryItem } from "./types";
import { formatWhen, kindLabel } from "./utils";

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

/* ---- Motion presets: short, critically damped springs (no visible overshoot) and quick fades. ---- */
export const spring: Transition = { type: "spring", duration: 0.25, bounce: 0.08 };
export const springSoft: Transition = { type: "spring", duration: 0.35, bounce: 0 };
export const fade: Transition = { duration: 0.18, ease: [0.2, 0.8, 0.2, 1] };
/** Height-auto collapse used by AnimatePresence children. */
export const collapse = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { height: springSoft, opacity: fade },
} as const;
/** Popover pop (scale + fade from the element's transform origin). */
export const pop = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.96 },
  transition: spring,
} as const;
/** Fade-up for notes, toasts and bubbles. */
export const fadeUp = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4 },
  transition: fade,
} as const;

/* ---- Shared class strings ---- */
export const LABEL = "block text-[10px] font-bold uppercase tracking-[.12em] text-muted";
export const CHIP_CLOSE = "h-5 w-5 flex-none rounded-full border-0 bg-[#2a2a2a] text-[10px] text-[#aaa] hover:bg-[#3a3a3a] hover:text-white";
export const PILL_BUTTON = "rounded-full border border-chip-line bg-chip px-[11px] py-1.5 text-[11px] text-[#cfcfcf] hover:bg-chip-hover hover:text-white";
export const CANCEL_BUTTON = "mt-3 rounded-full border border-[#3a3a3a] bg-chip px-4 py-[7px] text-[12px] text-[#d8d8d8] hover:border-danger-line hover:bg-danger-bg hover:text-danger-soft";

/** Pill-shaped radio group whose selection highlight slides between options. */
export function Segmented<T extends string | number>({ id, label, value, options, onSelect, className }: {
  id: string;
  label: string;
  value: T;
  options: { value: T; label: ReactNode; title?: string; disabled?: boolean; wrapTitle?: string }[];
  onSelect: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex rounded-full border border-[#333] bg-[#151515] p-[3px]", className)} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const selected = option.value === value;
        const button = (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            className={cn("relative rounded-full border-0 bg-transparent px-3 py-[5px] text-[12px] transition-colors duration-150", selected ? "text-white" : "text-[#aaa] disabled:text-[#555]")}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onSelect(option.value)}
          >
            {selected && <motion.span layoutId={`${id}-highlight`} className="absolute inset-0 rounded-full bg-blue" transition={spring} aria-hidden="true" />}
            <span className="relative">{option.label}</span>
          </button>
        );
        return option.wrapTitle !== undefined ? <span key={String(option.value)} className="inline-flex" title={option.wrapTitle || undefined}>{button}</span> : button;
      })}
    </div>
  );
}

/** Thumbnail + title/kind/date used by the history list and the "From history" picker. */
export function HistoryRowContent({ item, suffix }: { item: HistoryItem; suffix?: string }) {
  return (
    <>
      <span className="relative grid aspect-video w-[72px] flex-none place-items-center overflow-hidden rounded-[7px] border border-[#2d2d2d] bg-page text-[#666]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {item.thumbUrl ? <img className="h-full w-full object-cover" src={item.thumbUrl} alt="" loading="lazy" /> : <span>▶</span>}
        <em className="absolute right-[3px] bottom-[3px] rounded bg-[#000b] px-1 py-px text-[9px] text-[#ddd] not-italic">{item.durationSeconds}s</em>
      </span>
      <span className="grid min-w-0 gap-[3px]">
        <strong className="truncate text-[12px] font-medium">{item.title}{suffix}</strong>
        <small className="text-[10px] text-[#7c7c7c]">{kindLabel(item.kind)} · {formatWhen(item.createdAt)}</small>
      </span>
    </>
  );
}
