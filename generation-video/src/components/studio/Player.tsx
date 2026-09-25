"use client";

import { AnimatePresence, motion } from "motion/react";
import type { RefObject, SyntheticEvent } from "react";
import BlobLoader from "@/components/BlobLoader";
import type { BusyState, FrameGrab } from "./types";
import { CANCEL_BUTTON, cn, fadeUp, spring } from "./ui";

type PlayerProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoKey: string;
  src: string;
  poster?: string;
  isMuted: boolean;
  onToggleMute: () => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  currentTime: number;
  duration: number;
  grab: FrameGrab | null;
  isGrabFresh: boolean;
  onGrab: () => void;
  isEditing: boolean;
  busy: BusyState | null;
  onCancelEdit: () => void;
  editedNote: string | null;
  onLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onTimeUpdate: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  onSeeked: () => void;
};

/** The video stage (with grab flash, busy overlay and edited note) plus the play / sound / grab controls. */
export default function Player(props: PlayerProps) {
  const { videoRef, grab, isGrabFresh, isEditing, busy, editedNote } = props;
  return (
    <>
      <div
        className="relative grid min-h-[220px] flex-1 cursor-pointer place-items-center overflow-hidden rounded-[14px] border border-[#262626] bg-[#070707] outline-0 focus-visible:shadow-[0_0_0_2px_var(--color-blue)] max-[1000px]:aspect-video max-[1000px]:min-h-0 max-[1000px]:flex-none"
        tabIndex={0}
        aria-label="Video player. Space plays or pauses; left and right arrows step one frame."
        onClick={(event) => { if (event.target === event.currentTarget || event.target === videoRef.current) props.onTogglePlay(); }}
      >
        <video
          key={props.videoKey}
          ref={videoRef}
          className="block h-full max-h-full w-full rounded-[13px] bg-black object-contain"
          src={props.src}
          poster={props.poster}
          preload="auto"
          playsInline
          muted={props.isMuted}
          onLoadedMetadata={props.onLoadedMetadata}
          onTimeUpdate={props.onTimeUpdate}
          onPlay={props.onPlay}
          onPause={props.onPause}
          onEnded={props.onEnded}
          onSeeked={props.onSeeked}
        />
        {grab && isGrabFresh && (
          <motion.span
            key={`pulse-${grab.key}`}
            className="pointer-events-none absolute inset-0 z-2 rounded-[13px] border-2 border-accent bg-[#4f6fe022]"
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            aria-hidden="true"
          />
        )}
        <AnimatePresence>
          {isEditing && (
            <motion.div
              key="overlay"
              className="absolute inset-0 grid place-items-center rounded-[13px] bg-[#050505d9] backdrop-blur-[3px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="grid justify-items-center max-[760px]:scale-60">
                <BlobLoader label={busy?.label ?? "Updating your video"} detail={busy?.detail ?? "Regenerating the frame and re-rendering…"} size={200} />
                <button type="button" className={CANCEL_BUTTON} onClick={props.onCancelEdit}>Cancel</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {!isEditing && editedNote && (
            <motion.p
              key={editedNote}
              className="absolute top-3 left-1/2 m-0 -translate-x-1/2 rounded-full border border-ok-line bg-[#0f2415e6] px-3 py-1 text-[11px] text-mint"
              {...fadeUp}
            >
              {editedNote}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <div className="mt-3 flex flex-none items-center gap-2">
        <motion.button whileTap={{ scale: 0.92 }} transition={spring} type="button" className="grid h-[34px] w-[34px] place-items-center rounded-full border border-chip-line bg-chip text-[12px] text-[#eee] hover:bg-chip-hover" onClick={props.onTogglePlay} aria-label={props.isPlaying ? "Pause" : "Play"}>{props.isPlaying ? "❚❚" : "▶"}</motion.button>
        <span className="min-w-[92px] text-[12px] text-[#cfcfcf] tabular-nums">{props.currentTime.toFixed(1)}s / {props.duration.toFixed(1)}s</span>
        <button
          type="button"
          className={cn("rounded-full border px-[11px] py-[7px] text-[11px] transition-colors duration-150", props.isMuted ? "border-chip-line bg-chip text-[#bcbcbc]" : "border-ok-line bg-ok-bg text-mint")}
          onClick={props.onToggleMute}
          aria-pressed={!props.isMuted}
        >
          {props.isMuted ? "Sound off" : "Sound on"}
        </button>
        <span className="flex-1" />
        <motion.button
          type="button"
          className={cn("rounded-full border px-[13px] py-[7px] text-[12px] transition-colors duration-150", grab && isGrabFresh ? "border-accent bg-accent text-white" : "border-info-line bg-info-bg text-info-text hover:bg-chip-hover")}
          animate={grab && isGrabFresh ? { scale: [1, 1.06, 1] } : { scale: 1 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          whileTap={{ scale: 0.95 }}
          onClick={props.onGrab}
        >
          {grab && isGrabFresh ? `✓ Grabbed ${grab.atSec.toFixed(1)}s` : grab ? "⌖ Re-grab" : "⌖ Grab this frame"}
        </motion.button>
      </div>
    </>
  );
}
