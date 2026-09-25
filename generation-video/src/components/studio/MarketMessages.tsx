"use client";

import { AnimatePresence, motion } from "motion/react";
import { BUBBLE, LINK, TEXT, bubble } from "./ChatThread";
import { Spinner } from "./LiveStatus";
import { MARKET_STAGES, marketStageLabel } from "./hooks/useMarket";
import { shortUrl } from "./research";
import type { MarketRun } from "./types";
import { cn, fade } from "./ui";

type MarketMessagesProps = {
  run: MarketRun;
  isGenerating: boolean;
  onRetryRender: () => void;
  onDismiss: () => void;
};

const ASSISTANT = cn(BUBBLE, "flex-col self-start rounded-bl-[5px] border border-border bg-surface text-[#e8e8e8]");
const MAX_DEVELOPMENTS = 5;

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** A market-update run as chat messages: the user's prompt, then live agent progress and the render. */
export default function MarketMessages({ run, isGenerating, onRetryRender, onDismiss }: MarketMessagesProps) {
  const view = run.view;
  const status = view?.status ?? "starting";
  const failed = status === "error" || run.pollError !== null || run.render.status === "error";
  const rendering = run.render.status === "rendering";
  const working = !failed && (status !== "ready" || rendering);
  const stageIndex = MARKET_STAGES.findIndex((stage) => stage.status === status);
  const company = view?.company;
  const latest = view?.events.at(-1)?.message || view?.message || "";
  const title = rendering ? "Rendering your market update" : run.render.status === "error" ? "The video could not be rendered" : run.pollError ? "Lost track of the market update" : marketStageLabel(status);
  const stats = view ? [plural(view.competitors.length, "competitor"), plural(view.pages_fetched, "page"), plural(view.developments.length, "development")].join(" · ") : "";

  return (
    <>
      <motion.div variants={bubble} className={cn(BUBBLE, "items-center self-end rounded-br-[5px] bg-blue text-white")}>
        <div>
          <p className={TEXT}>{run.prompt}</p>
          <small className="mt-[3px] block text-[10px] text-[#d6e0ff] opacity-85">Market update</small>
        </div>
      </motion.div>

      <motion.div variants={bubble} className={cn(ASSISTANT, "min-w-[min(100%,340px)]", failed && "border-danger-line")} aria-live="polite">
        <div className="flex items-center gap-2">
          {working ? <Spinner /> : <span className={cn("text-[12px]", failed ? "text-danger-soft" : "text-mint")} aria-hidden="true">{failed ? "!" : "✓"}</span>}
          <strong className="min-w-0 truncate text-[13px] font-semibold">{title}</strong>
        </div>

        {company && (
          <p className="m-0 text-[12px] text-[#cfcfcf]">
            {company.name}
            {company.domain && <> · <a className="text-link underline-offset-2 hover:underline" href={`https://${company.domain}`} target="_blank" rel="noreferrer">{company.domain}</a></>}
            {company.category && <span className="text-[#8a8a8a]"> · {company.category}</span>}
          </p>
        )}

        {/* Stage checklist */}
        <ol className="m-0 grid list-none gap-0.5 p-0 text-[11px]">
          {MARKET_STAGES.map((stage, index) => {
            const done = status === "ready" || (stageIndex >= 0 && index < stageIndex);
            const current = !done && index === stageIndex && !failed;
            return (
              <li key={stage.status} className={cn("flex items-center gap-1.5", done ? "text-mint" : current ? "text-[#e8e8e8]" : "text-[#6f6f6f]")}>
                <span className="inline-grid w-3 place-items-center" aria-hidden="true">{done ? "✓" : current ? <Spinner /> : "·"}</span>
                {stage.label}
              </li>
            );
          })}
        </ol>

        {working && latest && (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p key={latest} className="m-0 truncate text-[12px] text-[#b8c6b9]" role="status" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={fade}>{rendering ? "Filming each development as a cinematic shot… this takes a few minutes." : `${latest}…`}</motion.p>
          </AnimatePresence>
        )}
        {stats && <p className="m-0 text-[11px] text-[#7c7c7c] tabular-nums">{stats}</p>}

        {view && view.competitors.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {view.competitors.map((competitor) => (
              <span key={competitor.entity_id} className="rounded-full border border-chip-line bg-chip px-2 py-0.5 text-[11px] text-[#d0d0d0]" title={competitor.reason || competitor.domain || undefined}>{competitor.name}</span>
            ))}
          </div>
        )}

        {view && view.developments.length > 0 && (
          <ul className="m-0 grid gap-1 p-0 pl-4 text-[11px] leading-snug text-[#bdbdbd]">
            {view.developments.slice(0, MAX_DEVELOPMENTS).map((development) => (
              <motion.li key={development.development_id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={fade}>
                {development.headline}
                {development.url && <> <a className="text-link underline-offset-2 hover:underline" href={development.url} target="_blank" rel="noreferrer">{development.source_name || shortUrl(development.url)}</a></>}
              </motion.li>
            ))}
            {view.developments.length > MAX_DEVELOPMENTS && <li className="list-none text-[#7c7c7c]">+{view.developments.length - MAX_DEVELOPMENTS} more</li>}
          </ul>
        )}

        {status === "error" && <p className="m-0 text-[12px] text-danger-soft" role="alert">{view?.error || view?.message || "The agent could not finish the market update."}</p>}
        {run.pollError && <p className="m-0 text-[12px] text-danger-soft" role="alert">{run.pollError}</p>}
        {run.render.status === "error" && <p className="m-0 text-[12px] text-danger-soft" role="alert">{run.render.error}</p>}

        <div className="flex flex-wrap items-center gap-3 pt-0.5">
          {run.render.status === "error" && view?.storyboard_id && (
            <button type="button" className={cn(LINK, "mt-0 text-[11px]")} onClick={onRetryRender} disabled={isGenerating}>↻ Retry render</button>
          )}
          {!rendering && <button type="button" className={cn(LINK, "mt-0 text-[11px]")} onClick={onDismiss}>Dismiss</button>}
        </div>
      </motion.div>
    </>
  );
}
