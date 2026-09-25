"use client";

import { AnimatePresence, motion } from "motion/react";
import type { RefObject, SyntheticEvent } from "react";
import BlobLoader from "@/components/BlobLoader";
import { useNow } from "./LiveStatus";
import { stepText } from "./live";
import type { BusyState, FrameGrab, LiveProgress } from "./types";
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
  /** Streamed progress of the running edit (steps, preview) and the frame it changes (shown blurred underneath). */
  pendingLive?: LiveProgress | null;
  pendingImage?: string | null;
  onCancelEdit: () => void;
  editedNote: string | null;
  onLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onTimeUpdate: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  onSeeked: () => void;
};

function elapsedLabel(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  return total >= 60 ? `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`;
}

/**
 * Loading frame over the player while an edit runs: the frame being changed (blurred + dimmed), the loader with the
 * live step + elapsed time, the job's preview image fading in when it arrives, and Cancel. Clicks pass through to the
 * video (only Cancel is interactive), and playing the old video lifts the dimming.
 */
function EditOverlay({ busy, live, image, isPlaying, onCancel }: { busy: BusyState | null; live: LiveProgress | null; image: string | null; isPlaying: boolean; onCancel: () => void }) {
  const now = useNow(true);
  const step = live?.steps[live.steps.length - 1];
  const elapsed = live ? elapsedLabel(now - live.startedAt) : null;
  const detail = step ? `${stepText(step.label)}…${elapsed ? ` · ${elapsed}` : ""}` : busy?.detail ?? "Regenerating the frame and re-rendering…";
  const preview = live?.preview?.imageUrl ?? null;
  return (
    <motion.div
      key="overlay"
      className="pointer-events-none absolute inset-0 z-3 overflow-hidden rounded-[13px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.45 } }}
      transition={{ duration: 0.25 }}
      aria-live="polite"
    >
      <motion.div className="absolute inset-0" animate={{ opacity: isPlaying ? 0.15 : 1 }} transition={{ duration: 0.3 }}>
        {image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="absolute inset-0 h-full w-full scale-110 object-cover blur-[14px] brightness-[.5]" src={image} alt="" />
        )}
        <div className="absolute inset-0 bg-[#050505b3]" />
        <AnimatePresence>
          {preview && (
            <motion.img key={preview} className="absolute inset-0 h-full w-full object-contain" src={preview} alt={live?.preview?.label ?? "Preview"} initial={{ opacity: 0, scale: 1.02 }} animate={{ opacity: 0.55, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.6, ease: "easeOut" }} />
          )}
        </AnimatePresence>
      </motion.div>
      <div className="relative grid h-full place-items-center">
        <div className="grid justify-items-center max-[760px]:scale-60">
          <BlobLoader label={busy?.label ?? "Updating your video"} detail={detail} size={180} />
          {preview && <span className="mt-1 text-[10px] text-[#9fb0d6]">{live?.preview?.label ?? "Preview"} ready</span>}
          <button type="button" className={cn(CANCEL_BUTTON, "pointer-events-auto")} onClick={(event) => { event.stopPropagation(); onCancel(); }}>Cancel</button>
        </div>
      </div>
    </motion.div>
  );
}

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
        <motion.video
          key={props.videoKey}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
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
          {isEditing && <EditOverlay busy={busy} live={props.pendingLive ?? null} image={props.pendingImage ?? null} isPlaying={props.isPlaying} onCancel={props.onCancelEdit} />}
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
