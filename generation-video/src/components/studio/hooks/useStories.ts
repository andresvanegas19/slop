"use client";

/* "Stories" flow state: POST /api/stories streams story cards + stills; POST /api/stories/:id/render makes videos. */
import { useRef, useState } from "react";
import { streamJson, type StreamEvent } from "../stream";
import type { Project } from "../types";
import { errorMessage, isProject } from "../utils";

export type StoryBeatCard = { caption: string; keyframe_prompt?: string; motion_to_next?: string; imageUrl?: string; error?: string };
export type StoryCard = { id: string; title: string; logline: string; beats: StoryBeatCard[]; index?: number };
export type StoryRenderState = { status: string; elapsedMs: number; projectId?: string; videoUrl?: string; error?: string };
export type StoriesSession = {
  key: number;
  prompt: string;
  count: number;
  durationSec: number;
  setId?: string;
  status: "writing" | "ready" | "rendering" | "error";
  stories: StoryCard[];
  renders: Record<string, StoryRenderState>;
  error?: string;
};

type StoriesResult = { storySetId?: unknown; stories?: unknown; error?: unknown };
type RenderResult = { projects?: unknown; results?: unknown; error?: unknown };

function asStory(value: unknown): StoryCard | null {
  if (!value || typeof value !== "object") return null;
  const story = value as Record<string, unknown>;
  if (typeof story.id !== "string" || typeof story.title !== "string" || !Array.isArray(story.beats)) return null;
  return {
    id: story.id,
    title: story.title,
    logline: typeof story.logline === "string" ? story.logline : "",
    index: typeof story.index === "number" ? story.index : undefined,
    beats: story.beats.map((beat) => {
      const item = (beat && typeof beat === "object" ? beat : {}) as Record<string, unknown>;
      return {
        caption: typeof item.caption === "string" ? item.caption : "",
        keyframe_prompt: typeof item.keyframe_prompt === "string" ? item.keyframe_prompt : undefined,
        motion_to_next: typeof item.motion_to_next === "string" ? item.motion_to_next : undefined,
        imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : undefined,
        error: typeof item.error === "string" ? item.error : undefined,
      };
    }),
  };
}

/** Merges a streamed/final story into the list, keeping stills that already arrived. */
function mergeStory(stories: StoryCard[], incoming: StoryCard): StoryCard[] {
  const existing = stories.find((story) => story.id === incoming.id);
  const merged: StoryCard = existing
    ? { ...existing, ...incoming, beats: incoming.beats.map((beat, index) => ({ ...existing.beats[index], ...beat, imageUrl: beat.imageUrl ?? existing.beats[index]?.imageUrl })) }
    : incoming;
  const next = existing ? stories.map((story) => story.id === incoming.id ? merged : story) : [...stories, merged];
  return next.sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
}

export function useStories(options: { onProjects: (projects: Project[]) => void }) {
  const [session, setSession] = useState<StoriesSession | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const keyRef = useRef(0);

  const update = (key: number, change: (current: StoriesSession) => StoriesSession) =>
    setSession((current) => current && current.key === key ? change(current) : current);

  async function start(prompt: string, count: number, durationSec: number) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const key = ++keyRef.current;
    setSelected([]);
    setSession({ key, prompt, count, durationSec, status: "writing", stories: [], renders: {} });
    const onEvent = (event: StreamEvent) => {
      const raw = event as unknown as Record<string, unknown>;
      if (raw.type === "story") {
        const story = asStory(raw.story);
        if (story) update(key, (current) => ({ ...current, stories: mergeStory(current.stories, story) }));
      } else if (raw.type === "preview" && typeof raw.storyId === "string" && typeof raw.beat === "number" && typeof raw.imageUrl === "string") {
        const { storyId, beat, imageUrl } = raw as { storyId: string; beat: number; imageUrl: string };
        update(key, (current) => ({
          ...current,
          stories: current.stories.map((story) => story.id === storyId
            ? { ...story, beats: story.beats.map((item, index) => index === beat ? { ...item, imageUrl, error: undefined } : item) }
            : story),
        }));
      }
    };
    try {
      const { ok, result } = await streamJson<StoriesResult>("/api/stories", { prompt, count, durationSec }, onEvent, controller.signal);
      if (!ok || typeof result.storySetId !== "string" || !Array.isArray(result.stories)) throw new Error(errorMessage(result, "The stories could not be written."));
      const finals = result.stories.map(asStory).filter((story): story is StoryCard => story !== null).map((story, index) => ({ ...story, index }));
      update(key, (current) => ({ ...current, setId: result.storySetId as string, status: "ready", stories: finals.reduce(mergeStory, current.stories.filter((story) => finals.some((item) => item.id === story.id))) }));
    } catch (caughtError) {
      if (controller.signal.aborted) return;
      console.error("[stories] could not write stories", caughtError);
      update(key, (current) => ({ ...current, status: "error", error: caughtError instanceof Error ? caughtError.message : "The stories could not be written." }));
    }
  }

  async function render(storyIds: string[]) {
    const current = session;
    if (!current?.setId || storyIds.length === 0) return;
    const key = current.key;
    const controller = new AbortController();
    abortRef.current = controller;
    update(key, (value) => ({
      ...value,
      status: "rendering",
      error: undefined,
      renders: { ...value.renders, ...Object.fromEntries(storyIds.map((id) => [id, { status: "starting", elapsedMs: 0 }])) },
    }));
    const onEvent = (event: StreamEvent) => {
      const raw = event as unknown as Record<string, unknown>;
      if (raw.type !== "story_status" || typeof raw.storyId !== "string") return;
      const state: StoryRenderState = {
        status: typeof raw.status === "string" ? raw.status : "working",
        elapsedMs: typeof raw.elapsedMs === "number" ? raw.elapsedMs : 0,
        ...(typeof raw.projectId === "string" ? { projectId: raw.projectId } : {}),
        ...(typeof raw.videoUrl === "string" ? { videoUrl: raw.videoUrl } : {}),
        ...(typeof raw.error === "string" ? { error: raw.error } : {}),
      };
      update(key, (value) => ({ ...value, renders: { ...value.renders, [raw.storyId as string]: state } }));
    };
    try {
      const { ok, result } = await streamJson<RenderResult>(`/api/stories/${current.setId}/render`, { storyIds, durationSec: current.durationSec }, onEvent, controller.signal);
      if (!ok || !Array.isArray(result.projects)) throw new Error(errorMessage(result, "The story video could not be rendered."));
      const projects = result.projects.filter(isProject);
      update(key, (value) => ({ ...value, status: "ready" }));
      setSelected((ids) => ids.filter((id) => !storyIds.includes(id)));
      if (projects.length) options.onProjects(projects);
    } catch (caughtError) {
      if (controller.signal.aborted) return;
      console.error("[stories] render failed", caughtError);
      update(key, (value) => ({
        ...value,
        status: "error",
        error: caughtError instanceof Error ? caughtError.message : "The story video could not be rendered.",
        renders: Object.fromEntries(Object.entries(value.renders).map(([id, state]) => [id, storyIds.includes(id) && !state.projectId ? { ...state, status: "failed" } : state])),
      }));
    }
  }

  function toggle(storyId: string) {
    setSelected((ids) => ids.includes(storyId) ? ids.filter((id) => id !== storyId) : [...ids, storyId]);
  }

  function dismiss() {
    abortRef.current?.abort();
    setSession(null);
    setSelected([]);
  }

  const isBusy = session?.status === "writing" || session?.status === "rendering";
  return { session, selected, toggle, start, render, dismiss, isBusy };
}

export type StoriesState = ReturnType<typeof useStories>;
