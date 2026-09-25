"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import ChatThread from "@/components/studio/ChatThread";
import GenerationStage from "@/components/studio/GenerationStage";
import Composer from "@/components/studio/Composer";
import Editor from "@/components/studio/Editor";
import HistoryPanel, { GeneratingRow } from "@/components/studio/HistoryPanel";
import LogDrawer, { ViewLogLink } from "@/components/studio/LogDrawer";
import MarketMessages from "@/components/studio/MarketMessages";
import ResearchMessages from "@/components/studio/ResearchMessages";
import { useStudio } from "@/components/studio/hooks/useStudio";
import { LABEL, cn, fade, fadeUp } from "@/components/studio/ui";
import { formatWindow } from "@/components/studio/utils";

const PANEL_EASE = "duration-[450ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none";

export default function Home() {
  const s = useStudio();
  const { isEditorOpen } = s;
  const researchSession = s.research.session;
  // A market update is shown on the home screen only (the finished video opens in the editor).
  const marketRun = isEditorOpen ? null : s.marketRun;
  // The conversation layout is used for editor threads, a company research session, and a market update.
  const hasThread = s.hasThread || researchSession !== null || marketRun !== null;
  // A new generation takes over the main stage (the composer stays below, disabled for new generations).
  const showStage = s.isGenerating && !isEditorOpen && !hasThread;
  const marketCompany = marketRun?.view?.company?.name;
  const threadTitle = isEditorOpen ? s.openTitle : marketRun ? (marketCompany ? `Market update · ${marketCompany}` : "Market update") : researchSession?.company ? `Researching ${researchSession.company}` : "Company research";

  return (
    <MotionConfig reducedMotion="user">
      <main className={cn("block min-h-screen bg-black transition-[padding-left] max-[760px]:pl-0", PANEL_EASE, isEditorOpen ? "pl-(--editor-width)" : "pl-(--panel-width)")}>
        <aside
          className={cn(
            "fixed inset-y-0 left-0 flex min-h-0 min-w-0 flex-col border-r border-border bg-panel p-[23px] transition-[width,box-shadow]",
            "max-[760px]:static max-[760px]:w-auto max-[760px]:overflow-visible max-[760px]:border-r-0 max-[760px]:border-b max-[760px]:p-4 max-[760px]:shadow-none",
            PANEL_EASE,
            isEditorOpen
              ? "z-30 w-(--editor-width) overflow-hidden shadow-[24px_0_60px_#0009,1px_0_0_#333] min-[761px]:max-[1000px]:overflow-y-auto"
              : "z-10 w-(--panel-width) min-[761px]:overflow-y-auto",
          )}
          aria-label={isEditorOpen ? "Project editor" : "Video history"}
        >
          <div className="flex items-center justify-between gap-[9px] text-[15px]">
            <div className="flex items-center gap-[9px]"><span className="grid h-[25px] w-[25px] place-items-center rounded-[7px] bg-[#f2f2f2] font-[Georgia,serif] font-bold text-[#111]">L</span><strong>Longform</strong></div>
            <AnimatePresence initial={false}>
              {isEditorOpen && (
                <motion.button key="close" className="rounded-[5px] border border-chip-line bg-chip px-2.5 py-1.5 text-[11px] text-[#bcbcbc] hover:bg-chip-hover hover:text-white" onClick={s.closeEditor} aria-label="Close editor" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>✕ Close</motion.button>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {isEditorOpen ? (
              <motion.div key="editor" className="flex min-h-0 flex-1 flex-col max-[1000px]:flex-none" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ type: "spring", duration: 0.35, bounce: 0 }}>
                <Editor studio={s} />
              </motion.div>
            ) : (
              <motion.div key="history" className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ type: "spring", duration: 0.3, bounce: 0 }}>
                <HistoryPanel
                  history={s.history}
                  isHistoryOpen={s.isHistoryOpen}
                  onToggleHistory={s.setHistoryOpen}
                  openProjectId={s.openProjectId}
                  onOpenProject={s.openProject}
                  isGenerating={s.isGenerating}
                  generatingKind={s.generatingKind}
                  clipCopy={s.clipCopy}
                  onCancelGeneration={s.cancelGeneration}
                  generationLive={s.generationLive}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </aside>

        <section className={cn("grid min-h-screen min-w-0 place-items-center max-[760px]:min-h-[62vh]", isEditorOpen ? "p-6" : "p-8 max-[760px]:p-[18px]")}>
          <div
            className={cn(
              "text-center",
              hasThread ? "flex h-[calc(100vh-48px)] w-[min(100%,860px)] flex-col max-[760px]:h-auto" : "w-[min(100%,980px)]",
              !hasThread && !isEditorOpen && "-translate-y-[5vh] max-[760px]:translate-y-0",
            )}
          >
            <span className={cn(LABEL, hasThread ? "mb-1.5" : "mb-6")}>AI video studio</span>
            <AnimatePresence mode="wait" initial={false}>
              {showStage ? (
                <motion.div key="stage" className="mb-[34px] max-[760px]:mb-[22px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}>
                  <GenerationStage kind={s.generatingKind} clipCopy={s.clipCopy} prompt={s.generatingPrompt} live={s.generationLive} onCancel={s.cancelGeneration} />
                </motion.div>
              ) : (
                <motion.div key="heading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
                  <h1
                    className={cn(
                      "m-0 font-normal text-[#f5f5f5]",
                      hasThread ? "truncate text-[20px] tracking-[-.01em]" : isEditorOpen ? "text-[clamp(28px,3vw,46px)] tracking-[-.04em]" : "text-[clamp(38px,5vw,70px)] tracking-[-.04em] max-[760px]:text-[39px]",
                    )}
                  >
                    {hasThread ? threadTitle : <>What&apos;s on your mind today?</>}
                  </h1>
                  {!hasThread && <p className={cn("mt-[13px] text-[#a9a9a9]", isEditorOpen ? "mb-[26px] text-[14px]" : "mb-[45px] text-[17px] max-[760px]:mb-[26px]")}>Describe a moment and get a {s.clipCopy} video. Or use + to make an ad, a company short, or a market update.</p>}
                </motion.div>
              )}
            </AnimatePresence>
            {hasThread && <ChatThread threadRef={s.threadRef} thread={s.thread} pendingOp={s.pendingOp} isEditing={s.isEditing} onRetry={s.retryThreadOp} onCancel={s.cancelEdit}
                onStartNewVideo={s.startSuggestedVideo} onKeepEditing={() => s.promptInputRef.current?.focus()}
                lead={marketRun ? (
                  <MarketMessages run={marketRun} isGenerating={s.isGenerating} onRetryRender={s.retryMarketRender} onDismiss={s.dismissMarket} />
                ) : researchSession && (
                  <ResearchMessages
                    session={researchSession}
                    readOnly={isEditorOpen}
                    isGenerating={s.isGenerating}
                    actionError={s.research.actionError}
                    onAnswer={(questionId, answer) => void s.research.answer(questionId, answer)}
                    onLoop={(looping) => void s.research.setLooping(looping)}
                    onStop={() => void s.research.stop()}
                    onCreate={s.createVideoFromResearch}
                    onApproveStoryline={(edits) => void s.approveStoryline(edits)}
                    onDismiss={s.dismissResearch}
                  />
                )}
              />}
            <Composer studio={s} />
            {s.isGenerating && !s.isContinueMode && !showStage && <GeneratingRow className="mx-auto mt-[18px] hidden max-w-[420px] max-[760px]:flex" kind={s.generatingKind} live={s.generationLive} onCancel={s.cancelGeneration} />}
            <AnimatePresence initial={false}>
              {s.interruptedJobs.map((job) => (
                <motion.div key={job.jobId} className="mx-auto mt-3 flex max-w-[600px] flex-wrap items-center gap-2 rounded-[10px] border border-[#a98238] bg-[#49391433] px-3 py-2 text-left text-[12px] text-[#ffdf9b]" role="status" {...fadeUp}>
                  <span className="min-w-0 flex-1">Interrupted by a server restart{job.prompt ? <> — <span className="text-[#e9d3a0]">“{job.prompt.length > 70 ? `${job.prompt.slice(0, 70)}…` : job.prompt}”</span></> : null}</span>
                  <button type="button" className="rounded-full border border-[#c79a45] bg-[#c79a45] px-3 py-1 text-[12px] text-black hover:brightness-110" onClick={() => void s.resumeInterruptedJob(job)}>Resume</button>
                  <button type="button" className="rounded-full border border-[#5a4a2a] bg-transparent px-3 py-1 text-[12px] text-[#d8c290] hover:text-white" onClick={() => s.dismissInterruptedJob(job)}>Dismiss</button>
                </motion.div>
              ))}
            </AnimatePresence>
            <AnimatePresence mode="popLayout">
              {s.error && <motion.p key={`error-${s.error}`} className="mx-auto mt-[15px] text-[13px] text-danger" role="alert" {...fadeUp}>{s.error} <ViewLogLink className="ml-1" /></motion.p>}
              {s.notice && !s.error && <motion.p key={`notice-${s.notice}`} className="mx-auto mt-3 text-[12px] text-[#8a8a8a]" role="status" {...fadeUp}>{s.notice}</motion.p>}
            </AnimatePresence>
            {s.narrationMessages.length > 0 && (
              <motion.section className="mx-auto mt-[15px] max-w-[600px] rounded-[10px] border border-[#a98238] bg-[#49391455] px-[15px] py-3 text-left text-[12px] text-[#ffdf9b]" aria-live="polite" {...fadeUp}>
                <strong className="block">Narration review</strong>
                <ul className="mt-1.5 pl-[19px] [&>li+li]:mt-1">{s.narrationMessages.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}</ul>
              </motion.section>
            )}
            <p className={cn("mx-auto max-w-[600px] text-[11px] text-faint", hasThread ? "mt-2.5" : "mt-[17px]")}>{s.isAtEnd ? `The playhead is at the end of “${s.openTitle}”: describe what happens next and it becomes a new shot.` : s.isAutoMode ? `Auto: your prompt decides — edit ${s.editWindow ? formatWindow(s.editWindow) : "the selected moment"}, ask a question, extend (“make it 3 seconds longer”), cut (“remove this part”), or attach a clip to append. Press End to continue from the end.` : s.isAppendMode ? `Adds a new shot at the end of “${s.openTitle}”: attach a video or pick one from history to append it as-is, or describe the next shot to generate it. Esc or ✕ goes back to new videos.` : !s.isContinueMode && s.attachment ? "Your video becomes a new project you can edit moment by moment or extend with more shots. A prompt is optional." : s.isContinueMode ? `Your message applies to ${s.editWindow ? formatWindow(s.editWindow) : `${s.targetSec.toFixed(1)}s`} of “${s.openTitle}” (frame ${s.targetFrame + 1}) — drag on the timeline strip to choose exactly which part to change. Describe a change to regenerate it and re-render the${s.project ? ` ${s.project.durationSeconds}s` : ""} video, or ask a question about it. Pause or use “Grab this frame” to pick a moment; Esc or ✕ goes back to new videos.` : <>{s.mediaType === "market" ? "Tell us what your company does: the agent finds your competitors, reads their recent news and pricing, and turns what changed into a short, sourced video." : s.mediaType === "ad" ? `Writes a ${s.presetLength}-second multi-scene ad (16:9) from your product or offer, then opens it in the editor. Takes 1–3 minutes.` : s.mediaType === "company" ? `Writes a ${s.presetLength}-second brand video about your company, then opens it in the editor. Takes 1–3 minutes.` : s.mediaType === "storyboard" ? "Select a valid local storyboard JSON file before rendering. Narration warnings must be reviewed before the server will render." : `Every prompt becomes a ${s.clipCopy} video with sound. Use + for ads, company shorts, or a market update — or attach, drop, or paste a video to start from your own footage.`} Your BFL key stays on the server.</>}</p>
          </div>
        </section>
        <LogDrawer />
      </main>
    </MotionConfig>
  );
}
