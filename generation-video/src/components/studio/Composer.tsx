"use client";

import { AnimatePresence, motion } from "motion/react";
import StoryPicker from "./StoryPicker";
import type { Studio } from "./hooks/useStudio";
import type { MediaType } from "./types";
import { CHIP_CLOSE, HistoryRowContent, Segmented, cn, collapse, fade, fadeUp, pop, spring } from "./ui";
import { PRESET_LENGTHS, VIDEO_ACCEPT, formatBytes, formatRange, isPreset, kindLabel } from "./utils";

const MEDIA_OPTIONS: { type: MediaType; icon: string; title: string; description: string; advanced?: boolean }[] = [
  { type: "market", icon: "◎", title: "Market update", description: "Tell us about your company — we find your competitors and summarize what changed in your market" },
  { type: "ad", icon: "✦", title: "New ad", description: "A multi-scene ad from your product or offer" },
  { type: "company", icon: "◆", title: "Company short", description: "A short brand video about your company" },
  { type: "stories", icon: "❖", title: "Stories", description: "3 short stories → pick one → video" },
  { type: "storyboard", icon: "☷", title: "Storyboard file", description: "Render a structured JSON storyboard", advanced: true },
];

const CHIP = "flex w-[min(100%,460px)] items-center gap-2.5 rounded-[14px] border py-1.5 pr-2 pl-1.5 text-left";

/** Prompt pill with + menu, sources/length chips, attachment and history-source chips, and the continue-mode bar. */
export default function Composer({ studio }: { studio: Studio }) {
  const { fileInputRef, promptInputRef, ...s } = studio;
  const { attachment, sourceProject, isContinueMode, isAppendMode, isAutoMode, isAtEnd, mediaType, editWindow } = s;
  const dragBlocked = s.isDragOver && s.attachDisabledReason !== null && !(isContinueMode && s.continueAction === "edit" && !s.isStoryboardProject);
  const busy = isContinueMode ? s.isEditing : s.isGenerating || s.isStartingResearch;

  const placeholder = isAutoMode && sourceProject ? `Append “${sourceProject.title}” — press send, or add a note` : isAutoMode && attachment ? "Optional: say what to do with this clip…" : isAtEnd ? "What happens next? e.g. “she waves goodbye”…" : isAutoMode ? "Describe a change, ask a question, or say “make it 3 seconds longer”…" : isAppendMode && sourceProject ? `Append “${sourceProject.title}” — press send` : isAppendMode ? "Describe the next shot, or attach a video to add to the end…" : attachment && !isContinueMode ? "Optional: describe your video…" : isContinueMode ? `Continue editing at ${s.targetSec.toFixed(1)}s — describe what to change or ask about it…` : mediaType === "storyboard" ? "Storyboard file selected below" : mediaType === "market" ? "Tell us about your company, e.g. “We're Acme, invoicing software for freelancers”" : mediaType === "rawtree" ? "No prompt needed — uses the latest competitor data" : mediaType === "ad" ? "Describe the product or offer to advertise…" : mediaType === "company" ? "Tell us about your company — what you do and for whom…" : mediaType === "stories" ? "A place, a product or a moment — we'll write a few short stories…" : `Describe your ${s.clipCopy} video`;
  const submitLabel = isAutoMode ? "Send" : isAppendMode ? "Append shot" : isContinueMode ? "Send edit or question" : attachment ? "Import attached video" : mediaType === "storyboard" ? "Render storyboard" : mediaType === "market" ? "Start market update" : mediaType === "rawtree" ? "Create competitor summary" : mediaType === "ad" ? "Create ad" : mediaType === "company" ? "Create company short" : mediaType === "stories" ? "Write stories" : "Generate quick clip";

  return (
    <div
      className="relative"
      onDragEnter={s.onComposerDragEnter}
      onDragOver={s.onComposerDragOver}
      onDragLeave={s.onComposerDragLeave}
      onDrop={s.onComposerDrop}
      onPaste={s.onComposerPaste}
    >
      <AnimatePresence>
        {s.isDragOver && (
          <motion.div
            key="drop-hint"
            className={cn("pointer-events-none absolute -top-[34px] left-1/2 z-3 -translate-x-1/2 rounded-full px-3 py-[5px] text-[12px] whitespace-nowrap text-white", dragBlocked ? "bg-danger-muted" : "bg-accent")}
            aria-hidden="true"
            {...fadeUp}
          >
            {s.isStoryboardProject && isContinueMode ? "Append isn't supported for storyboards yet" : isContinueMode ? "Drop to append this video to the end" : "Drop a video to start from your own footage"}
          </motion.div>
        )}
      </AnimatePresence>
      <input ref={fileInputRef} type="file" accept={VIDEO_ACCEPT} hidden onChange={s.onFileInputChange} />
      <AnimatePresence initial={false}>
        {!isContinueMode && s.stories.session && <motion.div key={`stories-${s.stories.session.key}`} {...collapse}><StoryPicker stories={s.stories} /></motion.div>}
      </AnimatePresence>
      {isContinueMode && (
        <div className="mb-2.5 ml-3.5 flex flex-wrap items-center gap-2 text-left max-[760px]:ml-0">
          <Segmented
            id="continue-mode"
            label="What to do with your message"
            value={s.continueAction}
            onSelect={s.selectContinueAction}
            options={[
              { value: "auto", label: "Auto", title: "Your prompt decides: edit, answer, extend, cut, or append" },
              { value: "edit", label: "Edit moment" },
              { value: "append", label: "Append shot", disabled: s.isStoryboardProject, wrapTitle: s.isStoryboardProject ? "Append isn't supported for storyboards yet" : "" },
            ]}
          />
          <motion.div layout="position" transition={spring} className="m-0 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-full border border-info-line bg-info-bg py-[5px] pr-1.5 pl-3 text-left text-[12px] text-[#c9d6f5]">
            {!isAppendMode && !isAtEnd && s.grab?.thumbUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="h-6 w-10 flex-none rounded-[4px] object-cover" src={s.grab.thumbUrl} alt="" />
            )}
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={isAtEnd ? "end" : "editing"} className="truncate" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
                {isAtEnd ? <>At the end · <strong className="font-semibold text-white">your prompt continues the video</strong></> : <>Editing: <strong className="font-semibold text-white">{s.openTitle}</strong> · {isAppendMode ? `end (${(s.project?.durationSeconds ?? 0).toFixed(1)}s)` : `${editWindow ? formatRange(editWindow) : `${s.targetSec.toFixed(1)}s`}${s.range ? "" : " (suggested)"}`}</>}
              </motion.span>
            </AnimatePresence>
            <button type="button" className={CHIP_CLOSE} onClick={s.closeEditor} aria-label="Stop editing and close the editor">✕</button>
          </motion.div>
        </div>
      )}
      <AnimatePresence>
        {(isAppendMode || isAutoMode) && s.isHistoryPickerOpen && (
          <motion.div
            key="history-picker"
            className="mb-2.5 ml-3.5 grid max-h-[280px] w-[min(100%,460px)] origin-bottom-left gap-1 overflow-y-auto rounded-[14px] border border-[#3a3a3a] bg-[#1b1b1b] p-1.5 text-left shadow-[0_14px_30px_#000a]"
            role="listbox"
            aria-label="Append a video from history"
            {...pop}
          >
            {s.history.length === 0 ? <p className="mx-1.5 mt-1.5 text-[10px] leading-normal text-faint">No videos in your history yet.</p> : s.history.map((item) => (
              <button
                key={item.projectId}
                type="button"
                role="option"
                aria-selected={sourceProject?.projectId === item.projectId}
                className="flex items-center gap-2.5 rounded-[10px] border border-transparent bg-transparent p-1.5 text-left text-[#e6e6e6] hover:border-info-line hover:bg-info-bg aria-selected:border-info-line aria-selected:bg-info-bg"
                onClick={() => s.pickSourceProject(item)}
              >
                <HistoryRowContent item={item} suffix={item.projectId === s.openProjectId ? " (this video)" : ""} />
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {(isAppendMode || isAutoMode) && sourceProject && (
          <motion.div key={`source-${sourceProject.projectId}`} {...collapse}>
            <div className={cn(CHIP, "mb-2.5 ml-3.5 border-[#333] bg-[#181818]")}>
              <span className="aspect-video w-16 flex-none overflow-hidden rounded-[7px] bg-black">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {sourceProject.thumbUrl && <img className="block h-full w-full object-cover" src={sourceProject.thumbUrl} alt="" />}
              </span>
              <span className="grid min-w-0 flex-1 gap-[3px]">
                <strong className="truncate text-[12px] font-medium text-[#eee]">From history: {sourceProject.title}</strong>
                <small className="text-[11px] text-[#8a8a8a]">{sourceProject.durationSeconds}s · {kindLabel(sourceProject.kind)} · the prompt is ignored for this</small>
              </span>
              <button type="button" className={cn(CHIP_CLOSE, "h-[22px] w-[22px]")} onClick={() => s.setSourceProject(null)} aria-label="Remove the history video">✕</button>
            </div>
          </motion.div>
        )}
        {attachment && (
          <motion.div key={`attachment-${attachment.key}`} {...collapse}>
            <div className={cn(CHIP, "mb-2.5 ml-3.5", attachment.status === "error" ? "border-danger-line bg-[#2a121255]" : "border-[#333] bg-[#181818]")}>
              <span className="aspect-video w-16 flex-none overflow-hidden rounded-[7px] bg-black">
                {attachment.upload?.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="block h-full w-full object-cover" src={attachment.upload.thumbUrl} alt="" />
                ) : (
                  <video className="block h-full w-full object-cover" src={attachment.previewUrl} muted playsInline preload="metadata" onLoadedMetadata={(event) => {
                    const seconds = event.currentTarget.duration;
                    if (Number.isFinite(seconds)) s.setLocalDuration(attachment.key, seconds);
                  }} />
                )}
              </span>
              <span className="grid min-w-0 flex-1 gap-[3px]">
                <strong className="truncate text-[12px] font-medium text-[#eee]" title={attachment.file.name}>{attachment.upload?.filename ?? attachment.file.name}</strong>
                <small className={cn("text-[11px]", attachment.status === "error" ? "text-danger-soft" : "text-[#8a8a8a]")}>
                  {attachment.status === "error" ? attachment.error : attachment.status === "uploading" ? `Uploading… ${Math.round(attachment.progress * 100)}% · ${formatBytes(attachment.file.size)}` : `${(attachment.upload?.durationSeconds ?? attachment.localDuration ?? 0).toFixed(1)}s · ${formatBytes(attachment.file.size)}${attachment.upload?.hasAudio ? " · sound" : ""}`}
                </small>
                {attachment.status === "uploading" && <span className="block h-[3px] overflow-hidden rounded-[2px] bg-[#2a2a2a]" aria-hidden="true"><i className="block h-full rounded-[2px] bg-accent transition-[width] duration-200" style={{ width: `${Math.max(3, attachment.progress * 100)}%` }} /></span>}
              </span>
              <button type="button" className={cn(CHIP_CLOSE, "h-[22px] w-[22px]")} onClick={s.clearAttachment} aria-label={attachment.status === "uploading" ? "Cancel upload" : "Remove attached video"}>✕</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <form
        className={cn(
          "flex items-center rounded-[58px] border bg-field text-left transition-[border-color,background-color,box-shadow] duration-150",
          s.isDragOver ? cn("border-dashed", dragBlocked ? "border-danger-muted bg-danger-bg" : "border-accent bg-[#16203a]") : isContinueMode ? "border-info-line" : "border-[#383838]",
          isContinueMode
            ? "min-h-[76px] gap-2.5 p-2.5 pl-[22px] shadow-[inset_0_1px_0_#2e2e2e,0_0_0_3px_#416bc522] max-[760px]:gap-1.5"
            : "min-h-[112px] gap-[17px] py-4 pr-[19px] pl-[21px] shadow-[inset_0_1px_0_#2e2e2e] max-[760px]:min-h-[76px] max-[760px]:gap-2 max-[760px]:p-2.5",
        )}
        onSubmit={s.submitComposer}
      >
        {!isContinueMode && (
          <div>
            <motion.button
              className="w-[41px] border-0 bg-transparent text-[46px] leading-none font-extralight text-white max-[760px]:w-[25px] max-[760px]:text-[33px]"
              type="button"
              aria-label="Choose another source"
              aria-expanded={s.isMediaMenuOpen}
              whileTap={{ scale: 0.9 }}
              transition={spring}
              onClick={() => s.setIsMediaMenuOpen((open) => !open)}
            >
              +
            </motion.button>
          </div>
        )}
        {(isAppendMode || isAutoMode) && (
          <span className="inline-flex flex-none" title={s.isStoryboardProject ? "Append isn't supported for storyboards yet" : "Append a video from your history"}>
            <button type="button" className="rounded-full border border-[#3a3a3a] bg-chip px-[11px] py-1.5 text-[12px] whitespace-nowrap text-[#d0d0d0] hover:bg-[#2a2a2a] hover:text-white disabled:opacity-50 max-[760px]:px-2 max-[760px]:py-[5px] max-[760px]:text-[11px]" aria-haspopup="listbox" aria-expanded={s.isHistoryPickerOpen} disabled={s.isStoryboardProject} onClick={() => s.setIsHistoryPickerOpen((open) => !open)} aria-label="Append a video from history">⟲<span className="max-[760px]:hidden"> From history</span></button>
          </span>
        )}
        <span className="inline-flex flex-none" title={s.attachDisabledReason ?? "Attach a video (MP4, MOV, WebM, M4V · max 200 MB)"}>
          <button className="grid h-10 w-10 place-items-center rounded-full border-0 bg-transparent text-[#d0d0d0] hover:bg-[#2c2c2c] hover:text-white aria-disabled:cursor-not-allowed aria-disabled:bg-transparent aria-disabled:text-[#555]" type="button" aria-label="Attach a video" aria-disabled={s.attachDisabledReason !== null} onClick={s.openFilePicker}>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </span>
        <input
          ref={promptInputRef}
          className={cn("min-w-0 flex-1 border-0 bg-transparent text-[#f4f4f4] outline-0 placeholder:text-[#b4b4b4] disabled:cursor-default", isContinueMode ? "text-[clamp(15px,1.3vw,20px)]" : "text-[clamp(19px,2vw,30px)]")}
          value={s.prompt}
          onChange={(event) => s.setPrompt(event.target.value)}
          placeholder={placeholder}
          aria-label={isContinueMode ? `Edit or ask about the moment at ${s.targetSec.toFixed(1)} seconds` : "Video idea"}
          maxLength={isContinueMode || mediaType === "market" ? 4000 : 32000}
          disabled={!isContinueMode && !attachment && mediaType === "storyboard"}
        />
        <motion.button
          className={cn(
            "grid flex-none place-items-center rounded-full border-0 bg-blue text-white transition-colors duration-150 enabled:hover:bg-blue-hover disabled:bg-[#343434] disabled:text-[#777]",
            isContinueMode ? "h-[54px] w-[54px] text-[26px]" : "h-[73px] w-[73px] text-[36px] max-[760px]:h-[55px] max-[760px]:w-[55px] max-[760px]:text-[28px]",
          )}
          aria-label={submitLabel}
          disabled={!s.canSubmit}
          whileTap={s.canSubmit ? { scale: 0.92 } : undefined}
          transition={spring}
        >
          {busy ? <span className="h-6 w-6 animate-spin-fast rounded-full border-[3px] border-[#b9c9f1] border-t-white" /> : "↟"}
        </motion.button>
      </form>
      {!isContinueMode && (
        <div className="flex flex-wrap items-start">
          <AnimatePresence initial={false}>
            {mediaType && (
              <motion.div key="source-chip" className="mt-3 ml-2.5 inline-flex items-center gap-2 rounded-full border border-[#3a3a3a] bg-[#181818] py-[5px] pr-1.5 pl-3 text-[12px] text-[#cfcfcf]" {...pop}>
                <span>{mediaType === "storyboard" ? "☷ Storyboard file" : mediaType === "market" ? "◎ Market update" : mediaType === "rawtree" ? "◎ Competitor summary" : mediaType === "ad" ? "✦ New ad" : mediaType === "stories" ? "❖ Stories" : "◆ Company short"}</span>
                <button type="button" className={CHIP_CLOSE} onClick={() => s.selectMediaType(null)} aria-label="Back to quick clip">✕</button>
              </motion.div>
            )}
          </AnimatePresence>
          {mediaType === "stories" && (
            <>
              <Segmented
                id="story-count"
                label="Number of stories"
                className="mt-3 ml-2 max-[760px]:mt-2.5 max-[760px]:ml-2.5"
                value={s.storyCount}
                onSelect={s.setStoryCount}
                options={[3, 4].map((count) => ({ value: count, label: `${count} stories` }))}
              />
              <Segmented
                id="story-length"
                label="Video length"
                className="mt-3 ml-2 max-[760px]:mt-2.5 max-[760px]:ml-2.5"
                value={s.storyLength}
                onSelect={s.setStoryLength}
                options={[5, 10].map((length) => ({ value: length, label: `${length}s` }))}
              />
            </>
          )}
          {isPreset(mediaType) && (
            <Segmented
              id="preset-length"
              label="Video length"
              className="mt-3 ml-2 max-[760px]:mt-2.5 max-[760px]:ml-2.5"
              value={s.presetLength}
              onSelect={s.setPresetLength}
              options={PRESET_LENGTHS.map((length) => ({ value: length, label: `${length}s` }))}
            />
          )}
        </div>
      )}
      {!isContinueMode && mediaType === "storyboard" && (
        <label className="mx-2.5 mt-[13px] grid gap-2 rounded-[13px] border border-[#414141] bg-[#181818] px-4 py-3.5 text-left text-[#dedede]">
          <span><strong className="block text-[13px]">Storyboard file</strong><small className="mt-[3px] block text-[11px] text-[#aaa]">Choose a local JSON file. Try <code className="text-info-text">storyboards/mock_changes.json</code>; browsers cannot select it automatically.</small></span>
          <input className="max-w-full text-[12px] text-[#cfcfcf]" type="file" accept=".json,application/json" onChange={s.selectStoryboard} aria-describedby="storyboard-file-status" />
          <span id="storyboard-file-status" className={cn("text-[11px]", s.storyboardError ? "text-danger" : s.storyboardFileName ? "text-[#a5dcb2]" : "text-[#9b9b9b]")}>{s.storyboardError ?? (s.storyboardFileName ? `${s.storyboardFileName} is valid JSON.` : "No file selected.")}</span>
        </label>
      )}
      <AnimatePresence>
        {!isContinueMode && s.isMediaMenuOpen && (
          <motion.div key="media-menu" className="absolute top-[calc(100%+16px)] left-0 z-2 w-[min(100%,700px)] origin-top-left rounded-[22px] border border-[#414141] bg-[#242424] p-3 shadow-[0_18px_40px_#000b]" {...pop}>
            {MEDIA_OPTIONS.map((option) => (
              <div key={option.type}>
                {option.advanced && <div className="mx-[15px] mt-2 mb-1 border-t border-[#3a3a3a] pt-2.5 text-left text-[10px] font-bold tracking-[.12em] text-[#8a8a8a] uppercase">Advanced</div>}
                <button type="button" className={cn("flex w-full items-center gap-[17px] rounded-[15px] border-0 p-[15px] text-left text-[#eee] hover:bg-[#3c3c3c]", mediaType === option.type ? "bg-[#3c3c3c]" : "bg-transparent")} onClick={() => s.selectMediaType(option.type)}>
                  <span className="grid h-[35px] w-[35px] flex-none place-items-center rounded-[10px] border border-[#737373] text-[17px]">{option.icon}</span>
                  <span><strong className="block text-[18px] font-medium">{option.title}</strong><small className="mt-[3px] block text-[13px] text-[#b0b0b0]">{option.description}</small></span>
                </button>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
