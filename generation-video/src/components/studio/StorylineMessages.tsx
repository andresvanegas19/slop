"use client";

/*
 * Research follow-ups after the company profile: the competitors the agent researched (they only inform how the
 * company stands apart — the ad never names them) and the storyline the agent's storyline tool wrote, which the user
 * reviews/edits and approves before anything is rendered with its template (preset).
 */
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { mentionsAny, type Storyline } from "@/lib/storyline";
import { BUBBLE, TEXT, bubble } from "./ChatThread";
import { Spinner } from "./LiveStatus";
import { shortUrl } from "./research";
import type { ResearchCompetitors, ResearchSession } from "./types";
import { cn, collapse, fade, spring } from "./ui";

const ASSISTANT = cn(BUBBLE, "flex-col self-start rounded-bl-[5px] border border-border bg-surface text-[#e8e8e8]");
const SMALL_PILL = "rounded-full border px-2.5 py-1 text-[11px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50";
const FIELD = "w-full resize-y rounded-[9px] border border-[#333] bg-[#141414] px-2.5 py-1.5 text-[12px] leading-snug text-[#eee] outline-0 placeholder:text-[#777] focus:border-accent disabled:opacity-70";

export const TEMPLATE_OPTIONS = [
  { id: "ad", label: "Ad" },
  { id: "company", label: "Company short" },
  { id: "competitive", label: "Competitive ad" },
] as const;

const templateLabel = (id: string) => TEMPLATE_OPTIONS.find((option) => option.id === id)?.label ?? id;

/** Competitor research progress and what it found (names are shown to the user, never put in the video). */
export function CompetitorsCard({ competitors }: { competitors: ResearchCompetitors }) {
  const [open, setOpen] = useState(false);
  const running = competitors.status === "running" || competitors.status === "waiting";
  const failed = competitors.status === "error" || competitors.status === "interrupted";
  if (competitors.status === "none" || competitors.status === "off" || competitors.status === "skipped") return null;
  const active = competitors.items.find((item) => item.currentPage && item.stage !== "researched");
  const title = competitors.status === "waiting" ? "Competitors: after the first research round"
    : running ? "Researching competitors"
    : failed ? "Competitor research interrupted"
    : competitors.items.length ? `${competitors.items.length} competitor${competitors.items.length === 1 ? "" : "s"} researched` : "No competitors found";
  const detail = running && active?.currentPage ? `Reading ${shortUrl(active.currentPage)}` : competitors.message;
  const hasDetails = competitors.items.some((item) => item.claims.length > 0 || item.summary) || competitors.differentiators.length > 0;

  return (
    <motion.div variants={bubble} initial="hidden" animate="visible" className={cn(ASSISTANT, "min-w-[min(100%,320px)]", failed && "border-danger-line")} aria-live="polite">
      <div className="flex items-center gap-2">
        {running ? <Spinner /> : <span className={cn("text-[12px]", failed ? "text-danger-soft" : "text-mint")} aria-hidden="true">{failed ? "!" : "✓"}</span>}
        <strong className="min-w-0 truncate text-[13px] font-semibold">{title}</strong>
      </div>
      {detail && <p className="m-0 min-w-0 truncate text-[12px] text-[#b8c6b9]" role="status">{detail}</p>}
      {competitors.items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <AnimatePresence initial={false}>
            {competitors.items.map((item) => (
              <motion.span key={item.id} className={cn(SMALL_PILL, "border-chip-line bg-chip text-[#cfcfcf]", item.error && "opacity-60")} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={spring} title={item.summary ?? item.error ?? item.domain}>
                {item.verified ? "✓ " : ""}{item.name}{item.domain ? <span className="text-[#7c7c7c]"> · {item.domain}</span> : null}
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      )}
      {hasDetails && (
        <div>
          <button type="button" className="border-0 bg-transparent p-0 text-[11px] text-mint hover:text-white" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {competitors.differentiators.length ? `How you stand apart (${competitors.differentiators.length})` : "What they say"} <span className="text-[#7c7c7c]">{open ? "▾" : "▸"}</span>
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div key="details" className="overflow-hidden" {...collapse}>
                <div className="mt-1 grid max-h-56 gap-2 overflow-y-auto pr-1 text-[11px] leading-snug text-[#bdbdbd]">
                  {competitors.differentiators.length > 0 && (
                    <ul className="m-0 grid list-disc gap-1 pl-4">
                      {competitors.differentiators.map((text) => <li key={text}>{text}</li>)}
                    </ul>
                  )}
                  {competitors.items.filter((item) => item.claims.length > 0 || item.summary).map((item) => (
                    <div key={item.id}>
                      <strong className="font-semibold text-[#dcdcdc]">{item.name}</strong>
                      {item.summary && <p className="m-0">{item.summary}</p>}
                      {item.claims.length > 0 && <ul className="m-0 grid list-disc gap-0.5 pl-4">{item.claims.slice(0, 4).map((claim) => <li key={claim}>{claim}</li>)}</ul>}
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
      <p className="m-0 text-[10px] text-[#7c7c7c]">Competitors only shape the positioning: the video never names them.</p>
    </motion.div>
  );
}

type Draft = { title: string; logline: string; call_to_action: string; beats: { message: string; visual: string }[] };

const draftOf = (storyline: Storyline): Draft => ({
  title: storyline.title,
  logline: storyline.logline,
  call_to_action: storyline.call_to_action,
  beats: storyline.beats.map((beat) => ({ message: beat.message, visual: beat.visual })),
});

/** Only the fields the user changed, in the agent's `edits` shape; null when nothing changed. */
function editsOf(storyline: Storyline, draft: Draft): Record<string, unknown> | null {
  const edits: Record<string, unknown> = {};
  for (const field of ["title", "logline", "call_to_action"] as const) if (draft[field].trim() !== storyline[field]) edits[field] = draft[field].trim();
  const beatsChanged = draft.beats.some((beat, index) => beat.message.trim() !== storyline.beats[index].message || beat.visual.trim() !== storyline.beats[index].visual);
  if (beatsChanged) edits.beats = draft.beats.map((beat) => ({ message: beat.message.trim(), visual: beat.visual.trim() }));
  return Object.keys(edits).length ? edits : null;
}

type StorylineCardProps = {
  session: ResearchSession;
  readOnly: boolean;
  isGenerating: boolean;
  onWrite: (template?: string) => void;
  onApprove: (edits: Record<string, unknown> | null) => void;
};

/** "Writing the storyline…" while the agent works, then the editable storyline (keyed by version so drafts reset). */
export function StorylineCard(props: StorylineCardProps) {
  const { session } = props;
  if (session.storylineWriting && !session.storyline) {
    return (
      <motion.div variants={bubble} initial="hidden" animate="visible" className={cn(ASSISTANT, "min-w-[min(100%,320px)]")} aria-live="polite">
        <div className="flex items-center gap-2"><Spinner /><strong className="text-[13px] font-semibold">Writing the storyline</strong></div>
        <p className="m-0 text-[12px] text-[#b8c6b9]">Using your request, the research{session.competitors?.status === "running" ? " and the competitor research (still running)" : ""}…</p>
      </motion.div>
    );
  }
  if (!session.storyline) return null;
  return <StorylineEditor key={`${session.storyline.storyline_id}:${session.storyline.version}`} {...props} storyline={session.storyline} />;
}

function StorylineEditor({ session, storyline, readOnly, isGenerating, onWrite, onApprove }: StorylineCardProps & { storyline: Storyline }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(storyline));
  const [template, setTemplate] = useState(storyline.template);
  const edits = useMemo(() => editsOf(storyline, draft), [storyline, draft]);
  const named = useMemo(() => {
    const text = [draft.title, draft.logline, draft.call_to_action, ...draft.beats.flatMap((beat) => [beat.message, beat.visual])].join("\n");
    return mentionsAny(text, storyline.avoid_terms);
  }, [draft, storyline.avoid_terms]);
  const busy = isGenerating || session.storylineWriting === true;
  const empty = !draft.title.trim() || !draft.logline.trim() || draft.beats.some((beat) => beat.message.trim().length < 3 || beat.visual.trim().length < 3);
  const canApprove = !readOnly && !busy && named.length === 0 && !empty;
  const setBeat = (index: number, field: "message" | "visual", value: string) => setDraft((current) => ({ ...current, beats: current.beats.map((beat, position) => position === index ? { ...beat, [field]: value } : beat) }));

  return (
    <motion.div variants={bubble} initial="hidden" animate="visible" className={cn(ASSISTANT, "w-full min-w-[min(100%,320px)] max-w-[min(100%,560px)]")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-mint" aria-hidden="true">✦</span>
        <strong className="text-[13px] font-semibold">Storyline</strong>
        <span className="rounded-full border border-info-line bg-info-bg px-2 py-0.5 text-[10px] text-[#dbe5ff]">{templateLabel(storyline.template)} · {storyline.duration_sec}s · {storyline.beats.length} scenes</span>
        {storyline.source !== "llm" && <span className="text-[10px] text-[#7c7c7c]">{storyline.source === "user" ? "edited" : "draft from the research"}</span>}
      </div>
      {storyline.reason && <p className="m-0 text-[11px] text-[#9a9a9a]">{storyline.reason}</p>}

      <label className="grid gap-1 text-[10px] uppercase tracking-[.1em] text-[#8a8a8a]">Title
        <input className={FIELD} value={draft.title} maxLength={120} disabled={readOnly || busy} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
      </label>
      <label className="grid gap-1 text-[10px] uppercase tracking-[.1em] text-[#8a8a8a]">Logline
        <textarea className={FIELD} rows={2} value={draft.logline} maxLength={400} disabled={readOnly || busy} onChange={(event) => setDraft((current) => ({ ...current, logline: event.target.value }))} />
      </label>

      <ol className="m-0 grid list-none gap-2 p-0">
        {storyline.beats.map((beat, index) => (
          <motion.li key={beat.index} className="grid gap-1 rounded-[11px] border border-[#2c2c2c] bg-[#161616] p-2" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ ...fade, delay: 0.03 * index }}>
            <span className="text-[10px] font-semibold uppercase tracking-[.1em] text-[#8a8a8a]">Scene {index + 1} · {beat.role}{beat.finding_ids?.length ? <span className="font-normal normal-case tracking-normal text-mint"> · grounded in research</span> : null}</span>
            <textarea className={FIELD} rows={2} value={draft.beats[index].message} maxLength={300} disabled={readOnly || busy} aria-label={`Scene ${index + 1} message`} onChange={(event) => setBeat(index, "message", event.target.value)} />
            <textarea className={cn(FIELD, "text-[11px] text-[#bdbdbd]")} rows={2} value={draft.beats[index].visual} maxLength={300} disabled={readOnly || busy} aria-label={`Scene ${index + 1} visual`} placeholder="What we see" onChange={(event) => setBeat(index, "visual", event.target.value)} />
          </motion.li>
        ))}
      </ol>

      <label className="grid gap-1 text-[10px] uppercase tracking-[.1em] text-[#8a8a8a]">Call to action
        <input className={FIELD} value={draft.call_to_action} maxLength={60} disabled={readOnly || busy} onChange={(event) => setDraft((current) => ({ ...current, call_to_action: event.target.value }))} />
      </label>

      {named.length > 0 && <p className="m-0 text-[12px] text-danger-soft" role="alert">Remove the competitor name ({named[0]}): the video never names competitors.</p>}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <select className="rounded-full border border-chip-line bg-chip px-2 py-1 text-[11px] text-[#cfcfcf] outline-0" value={template} disabled={busy} aria-label="Template" onChange={(event) => setTemplate(event.target.value)}>
            {TEMPLATE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <button type="button" className={cn(SMALL_PILL, "border-chip-line bg-chip text-[#bcbcbc] hover:bg-chip-hover")} disabled={busy} title="Write a new storyline with this template (discards your edits)" onClick={() => onWrite(template)}>
            {session.storylineWriting ? "Writing…" : "Regenerate"}
          </button>
          {edits && <button type="button" className={cn(SMALL_PILL, "border-chip-line bg-chip text-[#bcbcbc] hover:bg-chip-hover")} disabled={busy} onClick={() => setDraft(draftOf(storyline))}>Undo edits</button>}
          <motion.button
            type="button"
            className="ml-auto rounded-full border-0 bg-blue px-3.5 py-1.5 text-[12px] font-semibold text-white transition-colors duration-150 enabled:hover:bg-blue-hover disabled:bg-[#343434] disabled:text-[#777]"
            disabled={!canApprove}
            title={`Render this storyline with the ${templateLabel(storyline.template)} template`}
            whileTap={canApprove ? { scale: 0.95 } : undefined}
            transition={spring}
            onClick={() => onApprove(edits)}
          >
            {isGenerating ? "Creating…" : edits ? "Save & create video" : "Approve & create video"}
          </motion.button>
        </div>
      )}
      {!readOnly && template !== storyline.template && <p className="m-0 text-[10px] text-[#7c7c7c]">Press Regenerate to rewrite it as a {templateLabel(template)}.</p>}
      <p className={cn(TEXT, "text-[10px] text-[#7c7c7c]")}>Each scene becomes one shot; the headline, narration and visual prompt are written from it.</p>
    </motion.div>
  );
}
