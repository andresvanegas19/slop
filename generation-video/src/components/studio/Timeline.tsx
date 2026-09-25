"use client";

import { AnimatePresence, motion } from "motion/react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { FrameGrab, Project, ProjectFrame, TimeWindow } from "./types";
import { cn, fadeUp, springSoft } from "./ui";
import { editWindowFor, formatRange, formatSeconds, formatWindow } from "./utils";

type TimelineProps = {
  timelineRef: RefObject<HTMLDivElement | null>;
  project: Project;
  total: number;
  duration: number;
  currentTime: number;
  targetFrame: number;
  editWindow: TimeWindow | null;
  range: TimeWindow | null;
  rangeLimit: string | null;
  flashWindow: TimeWindow | null;
  grab: FrameGrab | null;
  grabPercent: number | null;
  isGrabFresh: boolean;
  playheadPercent: number;
  confirmRemoveFrame: number | null;
  isStoryboardProject: boolean;
  isEditing: boolean;
  showNextShot: boolean;
  /** The range a running edit is changing (shimmers), or a pending appended shot (placeholder at the end). */
  pendingWindow?: TimeWindow | null;
  pendingAppend?: boolean;
  isAtEnd: boolean;
  onGoToEnd: () => void;
  onRemoveFrame: (frame: ProjectFrame) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
};

const percent = (seconds: number, total: number) => `${(seconds / total) * 100}%`;

/** A light band sweeping across its (relative, overflow-hidden) parent. */
function Shimmer() {
  return (
    <motion.i
      className="pointer-events-none absolute inset-y-0 block w-1/2 motion-reduce:hidden"
      style={{ background: "linear-gradient(90deg, transparent, #ffffff38, transparent)" }}
      initial={{ left: "-50%" }}
      animate={{ left: "100%" }}
      transition={{ duration: 1.3, ease: "easeInOut", repeat: Infinity }}
      aria-hidden="true"
    />
  );
}

/** Filmstrip with shots, past-edit ticks, the draggable range, grab marker, playhead and the "+ next shot" ghost. */
export default function Timeline({ timelineRef, ...props }: TimelineProps) {
  const { project, total, editWindow, range, grab, flashWindow } = props;
  const lastIndex = project.frames.length - 1;
  return (
    <div className="mt-2.5 flex flex-none items-stretch gap-1.5">
      <div
        ref={timelineRef}
        className="relative h-16 min-w-0 flex-1 cursor-ew-resize touch-none overflow-visible rounded-[10px] border border-border bg-[#0a0a0a] outline-0 select-none focus-visible:shadow-[0_0_0_2px_var(--color-blue)]"
        role="slider"
        tabIndex={0}
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={Number(props.duration.toFixed(2))}
        aria-valuenow={Number(props.currentTime.toFixed(2))}
        aria-valuetext={`${props.currentTime.toFixed(1)} seconds`}
        onPointerDown={props.onPointerDown}
        onPointerMove={props.onPointerMove}
        onPointerUp={props.onPointerUp}
        onPointerCancel={props.onPointerCancel}
      >
        {project.frames.map((frame, position) => {
          const confirming = props.confirmRemoveFrame === frame.index;
          return (
            <div
              key={frame.index}
              className={cn(
                "group pointer-events-auto absolute inset-y-0 overflow-hidden bg-black bg-size-[auto_100%] bg-position-[left_center] bg-repeat-x transition-opacity duration-150",
                position < lastIndex && "border-r border-black",
                lastIndex === 0 ? "rounded-[9px]" : position === 0 ? "rounded-l-[9px]" : position === lastIndex ? "rounded-r-[9px]" : "",
                frame.index === props.targetFrame ? "opacity-100 shadow-[inset_0_0_0_2px_var(--color-blue)]" : "opacity-70",
              )}
              style={{ left: percent(frame.startSec, total), width: percent(frame.durationSec, total), backgroundImage: `url("${frame.imageUrl}")` }}
              title={`Frame ${frame.index + 1} · ${formatSeconds(frame.startSec)}–${formatSeconds(frame.startSec + frame.durationSec)}`}
            >
              <span className="absolute bottom-1 left-[5px] rounded bg-[#000a] px-[5px] py-px text-[9px] text-[#eee]">#{frame.index + 1}{frame.source === "upload" && <b className="ml-1 font-bold text-mint" title="Uploaded clip">⬆</b>}</span>
              {project.frames.length > 1 && (
                <button
                  type="button"
                  className={cn(
                    "absolute top-1 right-1 z-3 grid h-5 min-w-5 place-items-center rounded-full border-0 px-1.5 text-[10px] text-white transition-[opacity,background-color] duration-150 disabled:opacity-0!",
                    confirming ? "bg-danger-strong opacity-100" : "bg-[#000b] opacity-0 group-hover:opacity-100 hover:bg-danger-muted focus-visible:opacity-100",
                  )}
                  disabled={props.isStoryboardProject || props.isEditing}
                  title={props.isStoryboardProject ? "Removing shots isn't supported for storyboards yet" : confirming ? "Click again to remove this shot (can't be undone)" : `Remove shot ${frame.index + 1}`}
                  aria-label={confirming ? `Confirm removing shot ${frame.index + 1}` : `Remove shot ${frame.index + 1}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => { event.stopPropagation(); props.onRemoveFrame(frame); }}
                >
                  {confirming ? "Confirm remove" : "✕"}
                </button>
              )}
            </div>
          );
        })}
        {project.frames.flatMap((frame) => (frame.edits ?? []).map((edit, editIndex) => {
          const past = typeof edit.rangeStartSec === "number" && typeof edit.rangeEndSec === "number" ? { startSec: edit.rangeStartSec, endSec: edit.rangeEndSec } : editWindowFor(project.frames, edit.atSec, edit.windowSec ?? 1);
          return <span key={`${frame.index}-${editIndex}-${edit.at}`} className="absolute bottom-0 z-1 h-1.5 cursor-help rounded-t-[3px] bg-[#5cbf8acc]" style={{ left: percent(past.startSec, total), width: percent(past.endSec - past.startSec, total) }} title={`Edited ${formatWindow(past)} · ${edit.prompt}`} />;
        }))}
        {editWindow && (
          <motion.span
            className={cn("absolute inset-y-0 z-2 cursor-grab touch-none rounded-[6px] border-2 border-accent active:cursor-grabbing", range ? "bg-[#4f6fe03d]" : "border-dashed bg-[#4f6fe01f]")}
            data-range-drag={range ? "move" : undefined}
            initial={false}
            animate={{ left: percent(editWindow.startSec, total), width: percent(editWindow.endSec - editWindow.startSec, total) }}
            transition={{ type: "spring", duration: 0.16, bounce: 0 }}
            title={`${formatRange(editWindow)} — drag to move, drag the edges to resize`}
          >
            <span className="absolute -top-0.5 -bottom-0.5 -left-[7px] w-3 cursor-ew-resize touch-none after:absolute after:top-1/2 after:left-1/2 after:h-6 after:w-[5px] after:-translate-1/2 after:rounded-[3px] after:bg-white after:shadow-[0_0_0_1px_var(--color-accent),0_1px_4px_#000a] after:content-['']" data-range-drag="start" aria-hidden="true" />
            <span className="absolute -top-0.5 -right-[7px] -bottom-0.5 w-3 cursor-ew-resize touch-none after:absolute after:top-1/2 after:left-1/2 after:h-6 after:w-[5px] after:-translate-1/2 after:rounded-[3px] after:bg-white after:shadow-[0_0_0_1px_var(--color-accent),0_1px_4px_#000a] after:content-['']" data-range-drag="end" aria-hidden="true" />
            <AnimatePresence>
              {props.rangeLimit && (
                <motion.span
                  key="limit"
                  className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 rounded-[6px] bg-danger-muted px-2 py-[3px] text-[10px] whitespace-nowrap text-white"
                  role="status"
                  {...fadeUp}
                >
                  {props.rangeLimit}
                </motion.span>
              )}
            </AnimatePresence>
          </motion.span>
        )}
        {props.pendingWindow && (
          <span
            className="pointer-events-none absolute inset-y-0 z-2 overflow-hidden rounded-[6px] border-2 border-accent bg-[#4f6fe02e]"
            style={{ left: percent(props.pendingWindow.startSec, total), width: percent(props.pendingWindow.endSec - props.pendingWindow.startSec, total) }}
            aria-hidden="true"
          >
            <Shimmer />
          </span>
        )}
        {flashWindow && (
          <motion.span
            key={`${flashWindow.startSec}-${flashWindow.endSec}`}
            className="pointer-events-none absolute inset-y-0 z-1 rounded-[6px] bg-[#5cbf8a88]"
            style={{ left: percent(flashWindow.startSec, total), width: percent(flashWindow.endSec - flashWindow.startSec, total) }}
            initial={{ opacity: 1 }}
            animate={{ opacity: [1, 1, 0] }}
            transition={{ duration: 1.8, times: [0, 0.3, 1], ease: "easeOut" }}
            aria-hidden="true"
          />
        )}
        {grab && props.grabPercent !== null && (
          <motion.span
            key={`grab-${grab.key}`}
            className={cn(
              "pointer-events-none absolute -top-1 -bottom-1 z-3 -ml-[1.5px] w-[3px] origin-bottom rounded-[2px] bg-accent shadow-[0_0_10px_var(--color-accent)]",
              props.isGrabFresh && "after:absolute after:top-1/2 after:left-1/2 after:h-2.5 after:w-2.5 after:animate-grab-ring after:rounded-full after:bg-accent after:content-[''] motion-reduce:after:hidden",
            )}
            style={{ left: `${props.grabPercent}%` }}
            initial={{ opacity: 0, scaleY: 0.5 }}
            animate={{ opacity: 1, scaleY: 1 }}
            transition={springSoft}
            aria-hidden="true"
          >
            <em className="absolute bottom-[calc(100%+4px)] left-1/2 -translate-x-1/2 rounded-[5px] bg-accent px-1.5 py-px text-[10px] whitespace-nowrap text-white not-italic tabular-nums">{grab.atSec.toFixed(1)}s</em>
          </motion.span>
        )}
        <span className="pointer-events-none absolute -top-1.5 -bottom-1.5 z-2 -ml-px w-0.5 rounded-[2px] bg-white shadow-[0_0_6px_#000]" style={{ left: `${props.playheadPercent}%` }} aria-hidden="true">
          <i className="absolute -top-[5px] left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-white" />
        </span>
      </div>
      {props.pendingAppend ? (
        <motion.div
          className="relative grid w-[78px] flex-none place-items-center overflow-hidden rounded-[10px] border-2 border-accent bg-[#4f6fe026] text-[11px] leading-[1.2] text-white"
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={springSoft}
          aria-label="New shot being generated"
        >
          + new shot
          <Shimmer />
        </motion.div>
      ) : props.showNextShot && (
        <motion.button
          type="button"
          className={cn(
            "w-[78px] flex-none rounded-[10px] border-2 border-dashed text-[11px] leading-[1.2] transition-[color,border-color,background-color,box-shadow] duration-150",
            props.isAtEnd ? "border-accent bg-[#4f6fe033] text-white shadow-[0_0_0_2px_#4f6fe044]" : "border-[#3d4f7a] bg-[#0d1220] text-[#8ea2d4] hover:border-accent hover:text-white",
          )}
          whileTap={{ scale: 0.96 }}
          onClick={props.onGoToEnd}
          title="Move to the end — your prompt will continue the video (End)"
        >
          + next shot
        </motion.button>
      )}
    </div>
  );
}
