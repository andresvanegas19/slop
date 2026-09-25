"use client";

import { AnimatePresence, motion, type Variants } from "motion/react";
import { Spinner } from "./LiveStatus";
import type { StoriesState, StoryCard, StoryRenderState } from "./hooks/useStories";
import { CHIP_CLOSE, cn, fade, spring, springSoft } from "./ui";

const cards: Variants = { hidden: {}, visible: { transition: { staggerChildren: 0.08 } } };
const card: Variants = { hidden: { opacity: 0, y: 12, scale: 0.98 }, visible: { opacity: 1, y: 0, scale: 1, transition: springSoft } };
const PILL = "rounded-full border px-3 py-1.5 text-[12px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50";

function seconds(ms: number) {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** One still: shimmering skeleton until the image arrives, then a soft fade/scale in. */
function Still({ url, caption, index }: { url?: string; caption: string; index: number }) {
  return (
    <figure className="m-0 min-w-0 flex-1">
      <div className="relative aspect-video overflow-hidden rounded-[9px] bg-[#1c1c1c]">
        <AnimatePresence initial={false}>
          {url ? (
            <motion.img
              key={url}
              className="absolute inset-0 block h-full w-full object-cover"
              src={url}
              alt={caption}
              initial={{ opacity: 0, scale: 1.04 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
            />
          ) : (
            <motion.div
              key="skeleton"
              className="absolute inset-0 bg-gradient-to-r from-[#1c1c1c] via-[#2c2c2c] to-[#1c1c1c] bg-[length:200%_100%]"
              aria-hidden="true"
              initial={{ backgroundPosition: "100% 0%" }}
              animate={{ backgroundPosition: ["100% 0%", "-100% 0%"] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.4, repeat: Infinity, ease: "linear", delay: index * 0.15 }}
            />
          )}
        </AnimatePresence>
        <span className="absolute top-1.5 left-1.5 rounded-full bg-[#000a] px-1.5 py-[1px] text-[9px] text-[#ddd]">{index + 1}</span>
      </div>
      <figcaption className="mt-1 truncate text-[10px] text-[#9a9a9a]" title={caption}>{caption || " "}</figcaption>
    </figure>
  );
}

function RenderStatus({ state }: { state: StoryRenderState }) {
  const done = Boolean(state.projectId);
  const failed = state.status === "failed";
  return (
    <motion.p className={cn("m-0 flex items-center gap-1.5 text-[11px]", failed ? "text-danger-soft" : done ? "text-mint" : "text-[#b8c6b9]")} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={fade} role="status">
      {!done && !failed && <Spinner />}
      <span className="min-w-0 truncate">{done ? "✓ Video ready — opened in the editor" : failed ? `Failed: ${state.error ?? "try again"}` : `${state.status} · ${seconds(state.elapsedMs)}`}</span>
    </motion.p>
  );
}

function Card({ story, stories, disabled }: { story: StoryCard; stories: StoriesState; disabled: boolean }) {
  const checked = stories.selected.includes(story.id);
  const render = stories.session?.renders[story.id];
  const stillsReady = story.beats.length === 3 && story.beats.every((beat) => beat.imageUrl);
  const rendering = render && !render.projectId && render.status !== "failed";
  return (
    <motion.article
      variants={card}
      layout
      className={cn("grid gap-2 rounded-[14px] border bg-[#161616] p-3 text-left transition-colors duration-150", checked ? "border-info-line bg-[#141b2b]" : "border-[#2e2e2e]")}
    >
      <header className="flex items-start gap-2.5">
        <label className="mt-[3px] flex cursor-pointer items-center" title={stillsReady ? "Select this story" : "Waiting for the stills"}>
          <input type="checkbox" className="h-4 w-4 accent-[#416bc5]" checked={checked} disabled={!stillsReady || disabled} onChange={() => stories.toggle(story.id)} aria-label={`Select “${story.title}”`} />
        </label>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-[14px] font-semibold text-[#f0f0f0]">{story.title}</strong>
          <p className="m-0 text-[12px] leading-snug text-[#a9a9a9]">{story.logline}</p>
        </div>
        <motion.button
          type="button"
          className={cn(PILL, "flex-none border-[#3a5da8] bg-blue text-white enabled:hover:bg-blue-hover")}
          disabled={!stillsReady || disabled}
          whileTap={stillsReady && !disabled ? { scale: 0.95 } : undefined}
          transition={spring}
          onClick={() => void stories.render([story.id])}
        >
          Make this video
        </motion.button>
      </header>
      <div className="flex gap-2">
        {[0, 1, 2].map((index) => <Still key={index} index={index} url={story.beats[index]?.imageUrl} caption={story.beats[index]?.caption ?? ""} />)}
      </div>
      <AnimatePresence initial={false}>
        {render && (rendering || render.projectId || render.status === "failed") && <RenderStatus key={`${render.status}-${render.projectId ?? ""}`} state={render} />}
      </AnimatePresence>
    </motion.article>
  );
}

/** Story set as chat messages: the request, then story cards streaming in with their three stills, then render actions. */
export default function StoryPicker({ stories }: { stories: StoriesState }) {
  const session = stories.session;
  if (!session) return null;
  const writing = session.status === "writing";
  const rendering = session.status === "rendering";
  const placeholders = Math.max(0, session.count - session.stories.length);
  const selectedCount = stories.selected.length;

  return (
    <motion.section
      className="mb-4 flex max-h-[min(62vh,720px)] flex-col gap-3 overflow-y-auto px-1 py-1 text-left [scrollbar-color:#333_transparent]"
      aria-label="Stories"
      aria-live="polite"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springSoft}
    >
      <div className="flex max-w-[82%] items-center gap-2 self-end rounded-[16px] rounded-br-[5px] bg-blue px-[13px] py-2.5 text-[13px] text-white">
        <div>
          <p className="m-0 whitespace-pre-wrap">{session.prompt}</p>
          <small className="mt-[3px] block text-[10px] text-[#d6e0ff] opacity-85">Stories · {session.count} options · {session.durationSec}s video</small>
        </div>
      </div>
      <div className="grid gap-2.5 self-stretch rounded-[16px] rounded-bl-[5px] border border-border bg-surface p-3 text-[#e8e8e8]">
        <div className="flex items-center gap-2">
          {writing || rendering ? <Spinner /> : <span className={cn("text-[12px]", session.status === "error" ? "text-danger-soft" : "text-mint")} aria-hidden="true">{session.status === "error" ? "!" : "✓"}</span>}
          <strong className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {writing ? `Writing ${session.count} stories and shooting their stills…` : rendering ? "Turning your pick into a video…" : session.status === "error" ? "Something went wrong" : "Pick a story — its three stills become one continuous shot"}
          </strong>
          <button type="button" className={CHIP_CLOSE} onClick={stories.dismiss} aria-label="Close the stories">✕</button>
        </div>
        {session.error && <p className="m-0 text-[12px] text-danger-soft" role="alert">{session.error}</p>}
        <motion.div className="grid gap-2.5" variants={cards} initial="hidden" animate="visible">
          {session.stories.map((story) => <Card key={story.id} story={story} stories={stories} disabled={rendering} />)}
          {writing && Array.from({ length: placeholders }, (_, index) => (
            <motion.div key={`placeholder-${index}`} variants={card} className="grid gap-2 rounded-[14px] border border-[#262626] bg-[#141414] p-3" aria-hidden="true">
              <motion.div className="h-3.5 w-1/3 rounded bg-[#232323]" animate={{ opacity: [0.5, 1, 0.5] }} transition={{ duration: 1.2, repeat: Infinity }} />
              <motion.div className="h-3 w-2/3 rounded bg-[#1f1f1f]" animate={{ opacity: [0.5, 1, 0.5] }} transition={{ duration: 1.2, repeat: Infinity, delay: 0.1 }} />
              <div className="flex gap-2">{[0, 1, 2].map((beat) => <Still key={beat} index={beat} caption="" />)}</div>
            </motion.div>
          ))}
        </motion.div>
        <AnimatePresence initial={false}>
          {selectedCount > 0 && (
            <motion.div key="make-selected" className="sticky -bottom-3 z-1 -mx-3 -mb-3 flex items-center justify-end gap-2 rounded-b-[16px] border-t border-[#2a2a2a] bg-surface/95 px-3 py-2 backdrop-blur-sm" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={springSoft}>
              <small className="text-[11px] text-[#9a9a9a]">{selectedCount} selected</small>
              <motion.button type="button" className={cn(PILL, "border-[#3a5da8] bg-blue text-white enabled:hover:bg-blue-hover")} disabled={rendering} whileTap={{ scale: 0.95 }} transition={spring} onClick={() => void stories.render(stories.selected)}>
                Make selected videos
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}
