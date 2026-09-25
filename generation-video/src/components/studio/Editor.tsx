"use client";

import { AnimatePresence, motion } from "motion/react";
import BlobLoader from "@/components/BlobLoader";
import type { Studio } from "./hooks/useStudio";
import Player from "./Player";
import Timeline from "./Timeline";
import { LABEL, PILL_BUTTON, cn, collapse, fade } from "./ui";
import { formatWindow, frameIndexAt, kindLabel } from "./utils";

// Leaves room for the Next.js dev-tools badge (bottom-left) under the timeline meta line.
const DEV_BADGE_ROOM = process.env.NODE_ENV === "development" ? "min-[761px]:pb-10" : "";

/** The side panel's editor view: title, player, timeline, selected-range card and shortcuts line. */
export default function Editor({ studio: s }: { studio: Studio }) {
  const project = s.project;
  // While a streamed operation runs, the stage overlay shows the server's current step.
  const liveSteps = s.pendingOp?.live?.steps;
  const liveStep = liveSteps?.[liveSteps.length - 1];
  const busy = s.busy && liveStep ? { ...s.busy, detail: `${liveStep.label}…` } : s.busy;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col pt-[22px] max-[1000px]:flex-none", DEV_BADGE_ROOM)}>
      <div>
        <span className={LABEL}>Editing project</span>
        <h2 className="mt-1.5 truncate text-[20px] font-medium tracking-[-.01em] text-[#f2f2f2]">{project?.title ?? s.openItem?.title ?? "Loading project…"}</h2>
      </div>
      {s.projectError ? (
        <p className="mt-[18px] text-left text-[13px] text-danger" role="alert">{s.projectError}</p>
      ) : !project ? (
        <div className="grid min-h-[320px] flex-1 place-items-center"><BlobLoader label="Loading project" size={160} /></div>
      ) : (
        <motion.div className="mt-4 flex min-h-0 min-w-0 flex-1 flex-col max-[1000px]:flex-none" onKeyDown={s.onPlayerKeyDown} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fade}>
          <Player
            videoRef={s.videoRef}
            videoKey={`${project.videoUrl}-${s.videoReload}`}
            src={project.videoUrl}
            poster={project.frames[s.targetFrame]?.imageUrl ?? project.frames[0]?.imageUrl}
            isMuted={s.isMuted}
            onToggleMute={() => s.setIsMuted((current) => !current)}
            isPlaying={s.isPlaying}
            onTogglePlay={s.togglePlay}
            currentTime={s.currentTime}
            duration={s.duration}
            grab={s.grab}
            isGrabFresh={s.isGrabFresh}
            onGrab={() => { s.pauseQuietly(); s.grabCurrentFrame({ confirm: true, focusComposer: true }); }}
            isEditing={s.isEditing}
            busy={busy}
            onCancelEdit={s.cancelEdit}
            editedNote={s.editedNote}
            onLoadedMetadata={s.onVideoLoadedMetadata}
            onTimeUpdate={s.onVideoTimeUpdate}
            onPlay={() => s.setIsPlaying(true)}
            onPause={s.onVideoPause}
            onEnded={() => s.setIsPlaying(false)}
            onSeeked={s.onVideoSeeked}
          />

          <Timeline
            timelineRef={s.timelineRef}
            project={project}
            total={s.timelineTotal}
            duration={s.duration}
            currentTime={s.currentTime}
            targetFrame={s.targetFrame}
            editWindow={s.editWindow}
            range={s.range}
            rangeLimit={s.rangeLimit}
            flashWindow={s.flashWindow}
            grab={s.grab}
            grabPercent={s.grabPercent}
            isGrabFresh={s.isGrabFresh}
            playheadPercent={s.playheadPercent}
            confirmRemoveFrame={s.confirmRemoveFrame}
            isStoryboardProject={s.isStoryboardProject}
            isEditing={s.isEditing}
            showNextShot={s.isAutoMode && !s.isStoryboardProject}
            isAtEnd={s.isAtEnd}
            onGoToEnd={s.goToEnd}
            onRemoveFrame={s.requestRemoveFrame}
            onPointerDown={s.onTimelinePointerDown}
            onPointerMove={s.onTimelinePointerMove}
            onPointerUp={s.onTimelinePointerUp}
            onPointerCancel={s.onTimelinePointerCancel}
          />

          <AnimatePresence initial={false}>
            {(s.range || s.grab) && (
              <motion.div key="grab-card" className="flex-none overflow-hidden" {...collapse}>
                <GrabCard studio={s} />
              </motion.div>
            )}
          </AnimatePresence>
          <div className="mt-1.5 flex flex-none items-center justify-between gap-3">
            <p className="text-[10px] text-[#979797]">{project.durationSeconds} second MP4 · {project.frames.length} frame{project.frames.length === 1 ? "" : "s"} · {kindLabel(s.openItem?.kind ?? project.kind)} · drag on the strip to select a range · ←/→ step 1/30s · Shift/Alt+←/→ adjust range end/start</p>
          </div>
        </motion.div>
      )}
    </div>
  );
}

/** "Selected range" card: preview of the grabbed frame, the range, and Remove range / Clear. */
function GrabCard({ studio: s }: { studio: Studio }) {
  const project = s.project;
  if (!project) return null;
  const { grab, range, editWindow, isAppendMode } = s;
  const rangeFrame = range ? project.frames[frameIndexAt(project.frames, range.startSec)] : undefined;
  return (
    <div className={cn("mt-3 flex items-center gap-3 rounded-[12px] border border-info-line bg-[#0f1627] p-2 transition-shadow duration-300 max-[760px]:flex-wrap", s.isGrabFresh && "shadow-[0_0_0_2px_#4f6fe055]")}>
      {grab?.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="aspect-video w-40 flex-none rounded-[8px] bg-black object-cover" src={grab.thumbUrl} alt={`Frame at ${grab.atSec.toFixed(1)}s`} />
      ) : range && rangeFrame ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="aspect-video w-40 flex-none rounded-[8px] bg-black object-cover" src={rangeFrame.imageUrl} alt="" />
      ) : <span className="aspect-video w-40 flex-none rounded-[8px] bg-black" />}
      <div className="grid min-w-0 flex-1 gap-[3px]">
        <span className={LABEL}>Selected range</span>
        <strong className="text-[16px] text-white tabular-nums">{isAppendMode ? `${(grab?.atSec ?? 0).toFixed(1)}s` : editWindow ? formatWindow(editWindow) : ""}</strong>
        <small className="text-[11px] text-[#9fb0d6]">{isAppendMode ? "Append mode adds to the end instead" : editWindow ? `${(editWindow.endSec - editWindow.startSec).toFixed(1)}s long · shot ${frameIndexAt(project.frames, editWindow.startSec) + 1} · drag the edges to adjust` : ""}</small>
      </div>
      <div className="flex flex-none flex-wrap items-center justify-end gap-1.5 max-[760px]:w-full max-[760px]:flex-[1_1_100%] max-[760px]:justify-start">
        {range && !isAppendMode && (
          <span title={s.isStoryboardProject ? "Removing parts isn't supported for storyboards yet" : "Cut this range out of the video (can't be undone)"}>
            <button
              type="button"
              className={cn("rounded-full border px-[11px] py-1.5 text-[11px] whitespace-nowrap transition-colors duration-150 disabled:opacity-50", s.confirmCut ? "border-danger-strong bg-danger-strong text-white" : "border-danger-line bg-danger-bg text-danger-soft hover:bg-[#3a1616]")}
              disabled={s.isStoryboardProject || s.isEditing}
              onClick={s.requestCutRange}
            >
              {s.confirmCut ? `Confirm remove ${(range.endSec - range.startSec).toFixed(1)}s` : `✂ Remove range (${(range.endSec - range.startSec).toFixed(1)}s)`}
            </button>
          </span>
        )}
        <button type="button" className={PILL_BUTTON} onClick={s.clearSelection}>Clear</button>
      </div>
    </div>
  );
}
