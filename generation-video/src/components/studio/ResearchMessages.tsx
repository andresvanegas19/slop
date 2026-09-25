"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState, type FormEvent } from "react";
import { BUBBLE, LINK, TEXT, bubble } from "./ChatThread";
import { Spinner } from "./LiveStatus";
import { isResearchRunning, researchCounts, shortUrl } from "./research";
import { CompetitorsCard, StorylineCard } from "./StorylineMessages";
import type { ResearchQuestion, ResearchSession } from "./types";
import { cn, collapse, fade, spring } from "./ui";

type ResearchMessagesProps = {
  session: ResearchSession;
  /** In the editor the session is history: no "Create video now" / dismiss. */
  readOnly: boolean;
  isGenerating: boolean;
  actionError: string | null;
  onAnswer: (questionId: string, answer: string) => void;
  onLoop: (looping: boolean) => void;
  onStop: () => void;
  /** Asks the agent for a storyline (optionally with a template); nothing renders until it is approved. */
  onCreate: (template?: string) => void;
  onApproveStoryline: (edits: Record<string, unknown> | null) => void;
  onDismiss: () => void;
};

const ASSISTANT = cn(BUBBLE, "flex-col self-start rounded-bl-[5px] border border-border bg-surface text-[#e8e8e8]");
const SMALL_PILL = "rounded-full border px-2.5 py-1 text-[11px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50";

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The research session as chat messages: the user's request, the live research card, and follow-up questions. */
export default function ResearchMessages({ session, readOnly, isGenerating, actionError, onAnswer, onLoop, onStop, onCreate, onApproveStoryline, onDismiss }: ResearchMessagesProps) {
  const [showFindings, setShowFindings] = useState(false);
  const running = isResearchRunning(session);
  const counts = researchCounts(session);
  const company = session.company || "your company";
  const canCreate = session.profile !== null && session.profile !== undefined && !isGenerating && !session.storylineWriting;
  const statsLine = [plural(counts.pages, "page"), plural(counts.findings, "finding"), counts.tokens > 0 ? `${Math.round(counts.tokens / 100) / 10}k tokens` : null].filter(Boolean).join(" · ");
  const activity = session.statusLabel ?? (session.currentPage ? `Reading ${shortUrl(session.currentPage)}` : "Starting research");

  return (
    <>
      <motion.div variants={bubble} className={cn(BUBBLE, "items-center self-end rounded-br-[5px] bg-blue text-white")}>
        <div>
          <p className={TEXT}>{session.prompt}</p>
          <small className="mt-[3px] block text-[10px] text-[#d6e0ff] opacity-85">Company research · {session.durationSec}s video</small>
        </div>
      </motion.div>

      <motion.div variants={bubble} className={cn(ASSISTANT, "min-w-[min(100%,320px)]", session.error && "border-danger-line")} aria-live="polite">
        <div className="flex items-center gap-2">
          {running ? <Spinner /> : <span className={cn("text-[12px]", session.error ? "text-danger-soft" : "text-mint")} aria-hidden="true">{session.error ? "!" : "✓"}</span>}
          <strong className="min-w-0 truncate text-[13px] font-semibold">{running ? `Researching ${company}` : session.status === "stopped" ? `Research stopped · ${company}` : session.error ? `Research interrupted · ${company}` : `Research complete · ${company}`}</strong>
        </div>
        <p className="m-0 flex min-w-0 gap-1 text-[12px] text-[#b8c6b9]" role="status">
          {running && (
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={activity} className="min-w-0 truncate" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={fade}>{activity}…</motion.span>
            </AnimatePresence>
          )}
          <span className="flex-none text-[#7c7c7c] tabular-nums">{running ? "· " : ""}{statsLine}</span>
        </p>
        {running && (
          <span className="relative block h-[2px] overflow-hidden rounded-full bg-[#262626]" aria-hidden="true">
            <motion.i className="absolute inset-y-0 block w-1/3 rounded-full bg-green/70 motion-reduce:hidden" initial={{ left: "-33%" }} animate={{ left: "100%" }} transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity }} />
          </span>
        )}

        {session.findings.length > 0 && (
          <div>
            <button type="button" className="border-0 bg-transparent p-0 text-[11px] text-mint hover:text-white" aria-expanded={showFindings} onClick={() => setShowFindings((open) => !open)}>
              ✓ {plural(session.findings.length, "finding")} <span className="text-[#7c7c7c]">{showFindings ? "▾" : "▸"}</span>
            </button>
            <AnimatePresence initial={false}>
              {showFindings && (
                <motion.div key="findings" className="overflow-hidden" {...collapse}>
                  <ul className="mt-1 grid max-h-48 gap-1 overflow-y-auto pr-1">
                    <AnimatePresence initial={false}>
                      {session.findings.map((finding) => (
                        <motion.li key={finding.key} className="text-[11px] leading-snug text-[#bdbdbd]" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={fade}>
                          {finding.text}
                          {finding.source && <> <a className="text-link underline-offset-2 hover:underline" href={finding.source} target="_blank" rel="noreferrer">{finding.title ?? shortUrl(finding.source)}</a></>}
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ul>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {session.error && <p className="m-0 text-[12px] text-danger-soft" role="alert">{session.error}</p>}
        {actionError && <p className="m-0 text-[12px] text-danger-soft" role="alert">{actionError}</p>}

        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <button
            type="button"
            className={cn(SMALL_PILL, session.looping ? "border-ok-line bg-ok-bg text-mint" : "border-chip-line bg-chip text-[#bcbcbc] hover:bg-chip-hover")}
            aria-pressed={session.looping}
            disabled={Boolean(session.error)}
            onClick={() => onLoop(!session.looping)}
            title="Keep looking for more pages and findings until you stop it"
          >
            {session.looping ? "✓ Keep researching" : "Keep researching"}
          </button>
          {running && <button type="button" className={cn(SMALL_PILL, "border-danger-line bg-danger-bg text-danger-soft hover:bg-[#3a1616]")} onClick={onStop}>Stop</button>}
          {!readOnly && <button type="button" className={cn(LINK, "mt-0 text-[11px]")} onClick={onDismiss}>Dismiss</button>}
          {!readOnly && !session.storyline && (
            <motion.button
              type="button"
              className="ml-auto rounded-full border-0 bg-blue px-3.5 py-1.5 text-[12px] font-semibold text-white transition-colors duration-150 enabled:hover:bg-blue-hover disabled:bg-[#343434] disabled:text-[#777]"
              disabled={!canCreate}
              title={session.profile ? "Write a storyline from your request and this research; you review it before anything renders" : "Available once the research has a company profile"}
              whileTap={canCreate ? { scale: 0.95 } : undefined}
              transition={spring}
              onClick={() => onCreate()}
            >
              {session.storylineWriting ? "Writing storyline…" : isGenerating ? "Creating…" : "Create video now"}
            </motion.button>
          )}
        </div>
      </motion.div>

      {session.questions.map((question) => <Question key={question.id} question={question} onAnswer={onAnswer} />)}
      {session.competitors && <CompetitorsCard competitors={session.competitors} />}
      <StorylineCard session={session} readOnly={readOnly} isGenerating={isGenerating} onWrite={onCreate} onApprove={onApproveStoryline} />
    </>
  );
}

function Question({ question, onAnswer }: { question: ResearchQuestion; onAnswer: (questionId: string, answer: string) => void }) {
  const [draft, setDraft] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) return;
    onAnswer(question.id, draft);
    setDraft("");
  }
  return (
    <>
      <motion.div variants={bubble} initial="hidden" animate="visible" className={cn(ASSISTANT, question.answered && "opacity-80")}>
        <p className={TEXT}>{question.question}</p>
        {question.options.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {question.options.map((option, index) => (
              <motion.button
                key={option}
                type="button"
                className={cn(SMALL_PILL, question.answer === option ? "border-blue bg-blue text-white" : "border-info-line bg-info-bg text-[#dbe5ff] enabled:hover:border-accent")}
                disabled={question.answered}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ ...spring, delay: 0.04 * index }}
                onClick={() => onAnswer(question.id, option)}
              >
                {option}
              </motion.button>
            ))}
          </div>
        )}
        {!question.answered && (
          <form className="flex items-center gap-1.5 rounded-full border border-[#333] bg-[#141414] py-1 pr-1 pl-3" onSubmit={submit}>
            <input className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-[#eee] outline-0 placeholder:text-[#777]" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Or type your answer…" aria-label={`Answer: ${question.question}`} maxLength={2000} />
            <button type="submit" className="grid h-6 w-6 flex-none place-items-center rounded-full border-0 bg-blue text-[12px] text-white disabled:bg-[#343434] disabled:text-[#777]" disabled={!draft.trim()} aria-label="Send answer">↟</button>
          </form>
        )}
      </motion.div>
      {question.answered && question.answer && (
        <motion.div variants={bubble} initial="hidden" animate="visible" className={cn(BUBBLE, "self-end rounded-br-[5px] bg-blue text-white")}>
          <div>
            <p className={TEXT}>{question.answer}</p>
            <small className="mt-[3px] block text-[10px] text-[#d6e0ff] opacity-85">Answer</small>
          </div>
        </motion.div>
      )}
    </>
  );
}
