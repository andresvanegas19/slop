import { randomInt, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BflError, generateBflVideoDetailed, type Flux3Keyframe, type VideoQuality } from "@/lib/bfl";
import { HOUSE_LOOK } from "@/lib/cinematic-prompts";
import { generateFrameImage } from "@/lib/clip";
import { retrieveMemory } from "@/lib/memory";
import { createChatCompletion, openRouterModel } from "@/lib/openrouter";
import { ClientAbortedError, emitEvent, isStreaming } from "@/lib/progress";
import { dropUnrequestedStyle } from "@/lib/prompt-enhance";
import { createProject, frameImageUrl, frameFilePath, videoUrl, type Project, type ProjectFrame } from "@/lib/projects";
import { logException, logInfo } from "@/lib/runtime-log";
import { SEGMENT_FORMAT, concatSegments, videosDirectory } from "@/lib/segments";
import { schedulePublish } from "@/lib/video-store";

/**
 * "Stories" flow: the LLM writes N different 3-beat micro-stories (setup → moment → payoff) for a prompt, FLUX makes
 * one realistic still per beat, and a chosen story becomes ONE continuous FLUX 3 image-to-video shot with the three
 * stills pinned at 0, d/2 and d. Each rendered story is saved as a normal `kind: "clip"` project (three segments, one
 * per beat) so the editor, timeline, range edits, append and publishing all work on it.
 */

export const STORY_COUNTS = [3, 4] as const;
export const STORY_DURATIONS = [5, 10] as const;
export type StoryCount = (typeof STORY_COUNTS)[number];
export type StoryDuration = (typeof STORY_DURATIONS)[number];

const BEATS = 3;
const IMAGE_CONCURRENCY = 4;
const RENDER_CONCURRENCY = 2;
const LLM_TIMEOUT_MS = 45_000;
const STILL_SIZE = { width: 1920, height: 1088 };
const HI_RES = { width: 1920, height: 1080 };
const SET_ID = /^set_[A-Za-z0-9-]{8,64}$/;

export class StoryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type StoryContinuity = { characters: string; place: string; time: string; light: string };
export type StoryBeat = {
  caption: string;
  keyframe_prompt: string;
  motion_to_next: string;
  imageUrl?: string;
  error?: string;
};
export type Story = {
  id: string;
  title: string;
  logline: string;
  continuity: StoryContinuity;
  beats: StoryBeat[];
  source: "llm" | "fallback";
};
export type StoryRender = { storyId: string; projectId: string; videoUrl: string; hiResVideoUrl: string; durationSec: number; pins: number[]; bfl: string; at: string; pinPsnr?: number[] };
export type StorySet = {
  id: string;
  prompt: string;
  createdAt: string;
  aspect: "16:9";
  durationSec: StoryDuration;
  stories: Story[];
  renders: StoryRender[];
  memorySources?: string[];
};

export function isStorySetId(value: unknown): value is string {
  return typeof value === "string" && SET_ID.test(value);
}

function storiesDirectory() {
  return path.join(process.cwd(), "output", "stories");
}

export async function saveStorySet(set: StorySet) {
  await mkdir(storiesDirectory(), { recursive: true });
  const file = path.join(storiesDirectory(), `${set.id}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(set, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export async function loadStorySet(id: string): Promise<StorySet> {
  if (!isStorySetId(id)) throw new StoryError(`Story set id "${id}" is invalid.`, 400);
  try {
    return JSON.parse(await readFile(path.join(storiesDirectory(), `${id}.json`), "utf8")) as StorySet;
  } catch {
    throw new StoryError(`Story set "${id}" was not found.`, 404);
  }
}

// ---------- helpers ----------

function createLimiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function words(text: string) {
  return text.split(/\s+/).filter(Boolean);
}

function capWords(text: string, max: number) {
  const parts = words(text);
  return parts.length <= max ? text : parts.slice(0, max).join(" ").replace(/[,;:\-–\s]+$/, "");
}

const TEXT_WORDS = /\b(?:text|letters?|lettering|logos?|captions?|signs?|signage|typography|words?|headlines?|titles?|labels?|banners?|slogans?|written|writing)\b/i;

function clean(raw: string | undefined, maxWords: number, minWords = 1): string | undefined {
  if (!raw) return undefined;
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\*\*|__|`|#+\s*/g, "")
    .replace(/["“”][^"“”]*["“”]/g, (quoted) => quoted.length > 40 ? "" : quoted.replace(/["“”]/g, ""))
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /\bas an ai\b|^sorry\b/i.test(text)) return undefined;
  text = capWords(text, maxWords).replace(/\.+$/, "");
  return words(text).length >= minWords ? text : undefined;
}

/** A visual prompt field: drops text/logo sentences and non-photographic styles (house style is real phone footage). */
function cleanVisual(raw: string | undefined, maxWords: number, minWords: number) {
  const text = clean(raw, maxWords * 2, 1);
  if (!text) return undefined;
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const kept = sentences.filter((sentence) => !TEXT_WORDS.test(sentence)).join(" ").trim();
  const photographic = kept ? dropUnrequestedStyle(kept, "") : undefined;
  if (!photographic) return undefined;
  const capped = capWords(photographic, maxWords).replace(/[.\s]+$/, "");
  return words(capped).length >= minWords ? capped : undefined;
}

async function complete(system: string, user: string, maxTokens: number, temperature: number) {
  return withTimeout(createChatCompletion({
    model: openRouterModel(),
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    maxTokens,
    temperature,
  }), LLM_TIMEOUT_MS);
}

// ---------- writing ----------

const FALLBACK_ANGLES = [
  "the people who run it, starting their day before anyone arrives",
  "a regular whose small daily ritual happens here",
  "a first-time visitor who discovers it by chance",
  "two old friends who meet here again after a long time",
];

function anglesSystem(count: number) {
  return [
    `Write ${count} DIFFERENT short story ideas for a real-life video about the user's subject.`,
    "Each idea has different people and a different situation (for example: the owner, a regular, a newcomer, two friends, a family).",
    `Output exactly ${count} numbered lines, each under 20 words: who it is about and what small moment happens.`,
    "Real life only. No explanations, no titles, nothing else.",
  ].join("\n");
}

function parseAngles(raw: string, count: number) {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, "").replace(/\*\*/g, "").trim())
    .filter((line) => words(line).length >= 4 && !/^(?:here|sure|story ideas?)\b/i.test(line))
    .slice(0, count);
}

const STORY_SYSTEM = [
  "You write a 3-beat micro-story for a short real-life video that feels filmed on a phone by someone who is there.",
  "The three beats are three moments of ONE continuous handheld shot, a few seconds apart: SETUP, then MOMENT, then PAYOFF. Same people, same place, same light in all three.",
  "Write exactly these lines, each starting with its label:",
  "TITLE: 2 to 5 words",
  "LOGLINE: at most 15 words",
  "CHARACTERS: who appears, with age, hair and wardrobe colors",
  "PLACE: the one place and its visible details",
  "TIME: time of day and weather",
  "LIGHT: the available natural light (golden hour, window light, street light)",
  "BEAT 1 CAPTION: at most 8 words",
  "BEAT 1 KEYFRAME: 30 to 60 words describing one candid frame: the people, what they do, the emotion on their faces, and the framing (phone at eye level, close or medium shot, natural background blur)",
  "BEAT 1 MOTION: 10 to 30 words: how the people and the handheld phone camera move from this moment to the next",
  "BEAT 2 CAPTION: ...",
  "BEAT 2 KEYFRAME: ...",
  "BEAT 2 MOTION: ...",
  "BEAT 3 CAPTION: ...",
  "BEAT 3 KEYFRAME: ...",
  "BEAT 3 MOTION: how the shot settles at the end",
  "Rules: real footage only, never illustration or cartoon; no text, signs or logos in the picture; genuine emotion (a laugh, a glance, a hand on a shoulder); moments over products; describe what you want to see.",
  "Output ONLY these lines. No markdown, no explanations.",
].join("\n");

type ParsedStory = {
  title?: string;
  logline?: string;
  characters?: string;
  place?: string;
  time?: string;
  light?: string;
  beats: Partial<Record<"caption" | "keyframe" | "motion", string>>[];
};

export function parseStory(raw: string): ParsedStory {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/\r/g, "");
  const result: ParsedStory = { beats: Array.from({ length: BEATS }, () => ({})) };
  const counters = { caption: 0, keyframe: 0, motion: 0 };
  for (const line of text.split("\n")) {
    const beat = line.match(/^\W*beat\s*(\d)\W*\s*(caption|keyframe|image|still|motion|movement)\W*\s*[:\-–]\s*(.+)$/i);
    if (beat) {
      const index = Number(beat[1]) - 1;
      const field = /caption/i.test(beat[2]) ? "caption" : /motion|movement/i.test(beat[2]) ? "motion" : "keyframe";
      if (index >= 0 && index < BEATS) result.beats[index][field] ??= beat[3].trim();
      continue;
    }
    const plain = line.match(/^\W*(title|logline|characters?|people|place|location|setting|time|weather|light|lighting|caption|keyframe|image|motion|movement)\W*\s*[:\-–]\s*(.+)$/i);
    if (!plain) continue;
    const key = plain[1].toLowerCase();
    const value = plain[2].trim();
    if (key === "title") result.title ??= value;
    else if (key === "logline") result.logline ??= value;
    else if (/^(?:characters?|people)$/.test(key)) result.characters ??= value;
    else if (/^(?:place|location|setting)$/.test(key)) result.place ??= value;
    else if (/^(?:time|weather)$/.test(key)) result.time ??= value;
    else if (/^light/.test(key)) result.light ??= value;
    else {
      // Unnumbered CAPTION/KEYFRAME/MOTION lines: assign in order.
      const field = key === "caption" ? "caption" : /motion|movement/.test(key) ? "motion" : "keyframe";
      const index = counters[field]++;
      if (index < BEATS) result.beats[index][field] ??= value;
    }
  }
  return result;
}

function subjectOf(prompt: string) {
  return prompt.replace(/\s+/g, " ").trim().replace(/^(?:make|create|generate)\s+(?:an?\s+)?(?:video|story|stories)\s+(?:about|of|for)\s+/i, "").split(/[.;!?\n]/)[0]?.trim() || prompt;
}

function fallbackStory(prompt: string, angle: string, index: number): Story {
  const place = capWords(subjectOf(prompt), 24);
  const people = [
    "a woman in her forties with dark curly hair in a mustard cardigan, and a man in his forties with a short beard in a navy work jacket",
    "a man in his seventies with white hair in a tweed flat cap and a grey wool coat",
    "a woman in her twenties with a short bob in a green rain jacket, carrying a canvas backpack",
    "two friends in their thirties: a tall man in a denim jacket and a woman with long braids in a rust-orange sweater",
  ][index % 4];
  const titles = ["Before Opening", "The Usual", "First Time Here", "Again, At Last"];
  return {
    id: `story_${randomUUID().slice(0, 8)}`,
    title: titles[index % 4],
    logline: capWords(`${angle.charAt(0).toUpperCase()}${angle.slice(1)}.`, 15),
    continuity: { characters: people, place, time: "golden hour, clear sky, a light breeze", light: "low warm sun from the side, soft glow on faces" },
    beats: [
      { caption: "The day begins", keyframe_prompt: `The people arrive and settle into ${place}, a small anticipating smile, filmed on a phone at chest height, medium shot, natural background blur`, motion_to_next: "The handheld camera drifts closer as they turn toward each other" },
      { caption: "A small moment", keyframe_prompt: "A close, candid moment: a shared glance and a quiet laugh, hands busy with something small, filmed on a phone at eye level, close shot, soft background blur", motion_to_next: "The phone reframes gently as one of them leans in, the laugh growing" },
      { caption: "It feels like home", keyframe_prompt: "A warm payoff: a hand on a shoulder and a relaxed smile toward the light, the place glowing around them, filmed on a phone at eye level, medium close shot", motion_to_next: "The camera settles and holds as the light warms their faces" },
    ],
    source: "fallback",
  };
}

async function writeOneStory(prompt: string, angle: string, index: number, memory: string): Promise<Story> {
  const fallback = fallbackStory(prompt, angle, index);
  try {
    const user = [
      memory ? `${memory}\n` : undefined,
      `Subject: ${prompt}`,
      `This story is about: ${angle}`,
      "Write the story now.",
    ].filter(Boolean).join("\n");
    let parsed: ParsedStory | undefined;
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      const result = await complete(STORY_SYSTEM, user, 2_400, 0.7);
      const candidate = parseStory(result.content);
      const keyframes = candidate.beats.filter((beat) => beat.keyframe).length;
      logInfo("story_written", { index, attempt, keyframes, finishReason: result.finishReason, chars: result.content.length });
      if (keyframes >= 2 || attempt === 1) parsed = candidate;
    }
    if (!parsed) return fallback;
    const beats = fallback.beats.map((beatFallback, beatIndex) => {
      const raw = parsed.beats[beatIndex] ?? {};
      return {
        caption: clean(raw.caption, 8, 1) ?? beatFallback.caption,
        keyframe_prompt: cleanVisual(raw.keyframe, 70, 8) ?? beatFallback.keyframe_prompt,
        motion_to_next: cleanVisual(raw.motion, 35, 4) ?? beatFallback.motion_to_next,
      };
    });
    const llmBeats = parsed.beats.filter((beat) => cleanVisual(beat.keyframe, 70, 8)).length;
    return {
      id: fallback.id,
      title: clean(parsed.title, 6, 1) ?? fallback.title,
      logline: clean(parsed.logline, 15, 3) ?? fallback.logline,
      continuity: {
        characters: cleanVisual(parsed.characters, 40, 3) ?? fallback.continuity.characters,
        place: cleanVisual(parsed.place, 35, 2) ?? fallback.continuity.place,
        time: clean(parsed.time, 20, 1) ?? fallback.continuity.time,
        light: cleanVisual(parsed.light, 25, 2) ?? fallback.continuity.light,
      },
      beats,
      source: llmBeats >= 2 ? "llm" : "fallback",
    };
  } catch (error) {
    if (error instanceof ClientAbortedError) throw error;
    logException("story_write_failed", error, { index });
    return fallback;
  }
}

export function continuityPrefix(story: Story) {
  const { characters, place, time, light } = story.continuity;
  return `Same people throughout: ${characters.replace(/\.+$/, "")}. Place: ${place.replace(/\.+$/, "")}. Time: ${time.replace(/\.+$/, "")}. Light: ${light.replace(/\.+$/, "")}.`;
}

export function stillPrompt(story: Story, beatIndex: number) {
  return `${continuityPrefix(story)} ${story.beats[beatIndex].keyframe_prompt.replace(/[.\s]*$/, ".")} ${HOUSE_LOOK}. A real, candid frame with clean, unbranded surfaces and no visible text.`;
}

/** Public story shape for the UI/stream (no internal fields). */
export function publicStory(story: Story) {
  return { id: story.id, title: story.title, logline: story.logline, continuity: story.continuity, beats: story.beats, source: story.source };
}

// ---------- stills ----------

const referenceStills = () => process.env.STORY_REFERENCE_STILLS?.trim() !== "0";

async function generateStills(story: Story, imageLimit: ReturnType<typeof createLimiter>, counter: { images: number }) {
  const seed = randomInt(0, 2 ** 31 - 1);
  const makeStill = async (beatIndex: number, referencePath?: string) => {
    const beat = story.beats[beatIndex];
    try {
      const prompt = referencePath
        ? `${stillPrompt(story, beatIndex)} Same people, wardrobe, place and light as the reference image, a few seconds later in the same scene.`
        : stillPrompt(story, beatIndex);
      counter.images += 1;
      const image = await imageLimit(() => generateFrameImage(prompt, { ...STILL_SIZE, ...(referencePath ? { inputImagePath: referencePath } : { seed }) }));
      beat.imageUrl = frameImageUrl(image.filename);
      delete beat.error;
      emitEvent({ type: "preview", imageUrl: beat.imageUrl, label: `${story.title} · ${beat.caption}`, storyId: story.id, beat: beatIndex });
      return frameFilePath(beat.imageUrl);
    } catch (error) {
      if (error instanceof ClientAbortedError) throw error;
      beat.error = error instanceof Error ? error.message.slice(0, 300) : String(error);
      logException("story_still_failed", error, { storyId: story.id, beat: beatIndex });
      emitEvent({ type: "story", story: { ...publicStory(story), failedBeat: beatIndex } });
      return undefined;
    }
  };
  if (referenceStills()) {
    // Beat 1 first, then beats 2 and 3 conditioned on it so the people and place stay the same.
    const first = await makeStill(0);
    await Promise.all([makeStill(1, first), makeStill(2, first)]);
  } else {
    await Promise.all([0, 1, 2].map((beatIndex) => makeStill(beatIndex)));
  }
}

/** Writes `count` different stories and generates their stills; streams `story` + `preview` events. */
export async function createStorySet(input: { prompt: string; count: StoryCount; durationSec: StoryDuration }): Promise<{ set: StorySet; callCounts: { llm: number; images: number }; elapsedMs: number }> {
  const startedAt = Date.now();
  const prompt = input.prompt.replace(/\s+/g, " ").trim();
  const memory = await retrieveMemory(`${prompt} real life story moments phone footage emotion`, { k: 4, maxChars: 1_000, tags: ["cinematic", "storytelling", "story"] });
  let llmCalls = 0;
  let angles: string[] = [];
  try {
    llmCalls += 1;
    const result = await complete(anglesSystem(input.count), `${memory.text ? `${memory.text}\n\n` : ""}Subject: ${prompt}\nWrite the ${input.count} story ideas now.`, 1_600, 0.9);
    angles = parseAngles(result.content, input.count);
    logInfo("story_angles_written", { found: angles.length, count: input.count });
  } catch (error) {
    if (error instanceof ClientAbortedError) throw error;
    logException("story_angles_failed", error);
  }
  while (angles.length < input.count) angles.push(FALLBACK_ANGLES[angles.length % FALLBACK_ANGLES.length]);

  const set: StorySet = {
    id: `set_${randomUUID()}`,
    prompt,
    createdAt: new Date().toISOString(),
    aspect: "16:9",
    durationSec: input.durationSec,
    stories: [],
    renders: [],
    memorySources: memory.sources.map((source) => source.title),
  };
  const imageLimit = createLimiter(IMAGE_CONCURRENCY);
  const counter = { images: 0 };
  const stories = await Promise.all(angles.map(async (angle, index) => {
    llmCalls += 1;
    const story = await writeOneStory(prompt, angle, index, memory.text);
    if (isStreaming()) emitEvent({ type: "story", story: { ...publicStory(story), index } });
    await generateStills(story, imageLimit, counter);
    return story;
  }));
  set.stories = stories;
  await saveStorySet(set);
  const elapsedMs = Date.now() - startedAt;
  logInfo("story_set_created", { setId: set.id, stories: stories.length, images: counter.images, llm: llmCalls, elapsedMs });
  return { set, callCounts: { llm: llmCalls, images: counter.images }, elapsedMs };
}

// ---------- rendering ----------

function run(command: string, args: string[], action: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new StoryError(`${command} is unavailable: ${error.message}`, 500)));
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new StoryError(`${command} could not ${action} (${stderr.trim().slice(-500) || `exit code ${code}`}).`, 500)));
  });
}

async function probe(file: string) {
  const output = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], "read the story video");
  const parsed = JSON.parse(output) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  return { width: video?.width ?? 0, height: video?.height ?? 0, duration: Number(parsed.format?.duration) || 0, hasAudio: Boolean(parsed.streams?.some((stream) => stream.codec_type === "audio")) };
}

function rejectedFractional(error: unknown) {
  return error instanceof BflError && error.status !== undefined && error.status >= 400 && error.status < 500
    && ![401, 402, 403, 429].includes(error.status) && /keyframe|timestamp|second|integer|int\b|float|time/i.test(error.message);
}

// Which pin format BFL accepted last in this process.
let pinFormat: "fractional" | "whole" | undefined;

/**
 * The i2v prompt for a story. The stills are pinned, so the prompt only directs the motion BETWEEN them; naming a new
 * opening ("it opens on steam rising…") made FLUX 3 invent a close-up insert and hard-cut into the pinned frames.
 */
export function storyVideoPrompt(story: Story) {
  const [first, second, third] = story.beats;
  const motion = (text: string) => text.replace(/[.\s]*$/, ".");
  return [
    "One continuous handheld phone shot with no cuts, no inserts and no cutaways: the video starts exactly on the first keyframe image, passes through the second keyframe at the middle and ends exactly on the third keyframe image, with smooth natural motion between them.",
    continuityPrefix(story),
    `From the first frame: ${motion(first.motion_to_next)}`,
    `Then: ${motion(second.motion_to_next)}`,
    `At the end: ${motion(third.motion_to_next)}`,
    `${HOUSE_LOOK}.`,
    "Audio: natural ambient sound of the place; no music, no dialogue. No on-screen text.",
  ].join(" ").replace(/\s+/g, " ").trim();
}

/** PSNR (dB) of a video frame at `atSec` against an image, both scaled to 480x270 (diagnostics for the pins). */
async function framePsnr(video: string, atSec: number, image: string) {
  const scale = "scale=480:270:force_original_aspect_ratio=increase,crop=480:270,format=yuv420p";
  const output = await new Promise<string>((resolve) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-ss", atSec.toFixed(3), "-i", video, "-i", image, "-lavfi", `[0:v]${scale}[a];[1:v]${scale}[b];[a][b]psnr`, "-frames:v", "1", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(stderr));
  });
  const match = output.match(/average:(inf|[\d.]+)/);
  return match ? (match[1] === "inf" ? 100 : Math.round(Number(match[1]) * 10) / 10) : 0;
}

function segmentFilter(startFrame: number, endFrame: number) {
  const { width, height, fps } = SEGMENT_FORMAT;
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p,trim=start_frame=${startFrame}:end_frame=${endFrame},setpts=PTS-STARTPTS`;
}

async function cutSegment(source: string, startSec: number, endSec: number, fps: number) {
  const { sampleRate } = SEGMENT_FORMAT;
  const filename = `${randomUUID()}.mp4`;
  const output = path.join(videosDirectory(), filename);
  const startFrame = Math.round(startSec * fps);
  const endFrame = Math.round(endSec * fps);
  await run("ffmpeg", [
    "-y", "-i", source,
    "-filter_complex", `[0:v]${segmentFilter(startFrame, endFrame)}[v];[0:a]aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=${(startFrame / fps).toFixed(4)}:end=${(endFrame / fps).toFixed(4)},asetpts=PTS-STARTPTS[a]`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "aac", "-b:a", "128k", "-ar", String(sampleRate), "-ac", "2", "-movflags", "+faststart", output,
  ], "cut a story segment");
  return filename;
}

/** One continuous FLUX 3 i2v shot through the story's three stills → a clip project with one segment per beat. */
async function renderStory(set: StorySet, story: Story, durationSec: StoryDuration, quality: VideoQuality, status: (state: string, extra?: Partial<{ projectId: string; videoUrl: string; error: string }>) => void) {
  const stills = story.beats.map((beat) => beat.imageUrl ? frameFilePath(beat.imageUrl) : undefined);
  if (stills.some((still) => !still)) throw new StoryError(`Story "${story.title}" is missing a still; regenerate the stories.`, 409);
  const images = await Promise.all(stills.map(async (still) => (await readFile(still as string)).toString("base64")));
  const d = durationSec;
  const prompt = storyVideoPrompt(story);
  await mkdir(videosDirectory(), { recursive: true });
  const id = randomUUID();
  const source = path.join(videosDirectory(), `${id}.source.mp4`);
  const hiResFilename = `${id}.hires.mp4`;
  const hiRes = path.join(videosDirectory(), hiResFilename);

  const attempt = async (format: "fractional" | "whole") => {
    const middle = format === "fractional" ? d / 2 : Math.round(d / 2);
    const keyframes: Flux3Keyframe[] = [[0, images[0]], [middle, images[1]], [d, images[2]]];
    status(`generating video (${format} pins 0 / ${middle} / ${d}s)`);
    const result = await generateBflVideoDetailed({ prompt, keyframes, durationSec: d, quality, generateAudio: true });
    return { result, pins: [0, middle, d] };
  };
  let generated: Awaited<ReturnType<typeof attempt>>;
  if (pinFormat === "whole") {
    generated = await attempt("whole");
  } else {
    try {
      generated = await attempt("fractional");
      pinFormat = "fractional";
    } catch (error) {
      if (!rejectedFractional(error)) throw error;
      logInfo("story_fractional_pins_rejected", { reason: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      generated = await attempt("whole");
      pinFormat = "whole";
    }
  }

  try {
    status("downloading");
    const response = await fetch(generated.result.url);
    if (!response.ok) throw new BflError(`BFL video download failed (HTTP ${response.status}).`, response.status);
    await writeFile(source, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
    const info = await probe(source);
    const { fps, sampleRate } = SEGMENT_FORMAT;
    const length = Math.min(d, info.duration || d);
    status("cutting segments");
    // Full-resolution master (1920x1080, generated ambient audio kept).
    await run("ffmpeg", [
      "-y", "-i", source,
      ...(info.hasAudio ? [] : ["-f", "lavfi", "-i", `anullsrc=r=${sampleRate}:cl=stereo`]),
      "-filter_complex", `[0:v]scale=${HI_RES.width}:${HI_RES.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${HI_RES.width}:${HI_RES.height},setsar=1,fps=${fps},format=yuv420p,trim=duration=${length.toFixed(3)},setpts=PTS-STARTPTS[v];${info.hasAudio ? "[0:a]" : "[1:a]"}aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${length.toFixed(3)},afade=t=in:d=0.2,afade=t=out:st=${Math.max(0, length - 0.4).toFixed(3)}:d=0.4[a]`,
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "192k", "-ar", String(sampleRate), "-ac", "2", "-movflags", "+faststart", hiRes,
    ], "write the story master");
    // One segment per beat: [0, pin2), [pin2, d − d/4), [d − d/4, d] — the last segment ends on the third still.
    const middle = generated.pins[1];
    // Diagnostics: how closely the delivered frames match the pinned stills (≳20 dB = the still is there).
    const pinPsnr = await Promise.all([[0, 0], [middle, 1], [Math.max(0, length - 1 / fps), 2]].map(([at, beat]) => framePsnr(hiRes, at, stills[beat] as string)));
    logInfo("story_pin_check", { storyId: story.id, pins: generated.pins.join("/"), psnr: pinPsnr.join("/") });
    const tail = Math.max(middle + 0.5, length - d / 4);
    const bounds = [0, middle, tail, length];
    const segmentFiles: string[] = [];
    for (let index = 0; index < BEATS; index += 1) segmentFiles.push(await cutSegment(hiRes, bounds[index], bounds[index + 1], fps));
    const concatenated = await concatSegments(segmentFiles.map((file) => path.join(videosDirectory(), file)));
    let start = 0;
    const frames: ProjectFrame[] = story.beats.map((beat, index) => {
      const frame: ProjectFrame = {
        index,
        imageUrl: beat.imageUrl as string,
        prompt: stillPrompt(story, index),
        startSec: Math.round(start * 1000) / 1000,
        durationSec: concatenated.segmentDurations[index],
        segmentUrl: videoUrl(segmentFiles[index]),
        source: "generated",
      };
      start += concatenated.segmentDurations[index];
      return frame;
    });
    status("saving project");
    const project: Project = await createProject({
      kind: "clip",
      title: story.title,
      videoUrl: videoUrl(concatenated.filename),
      durationSeconds: concatenated.durationSeconds,
      frames,
    });
    schedulePublish(project, "generated");
    const render: StoryRender = {
      storyId: story.id, projectId: project.id, videoUrl: project.videoUrl, hiResVideoUrl: videoUrl(hiResFilename), durationSec: d,
      pins: generated.pins, bfl: `${generated.result.resolution}${generated.result.draft ? " draft" : ""}`, at: new Date().toISOString(), pinPsnr,
    };
    logInfo("story_rendered", { setId: set.id, storyId: story.id, projectId: project.id, delivered: `${info.width}x${info.height}`, bfl: render.bfl, pins: generated.pins.join("/") });
    return { project, render, delivered: `${info.width}x${info.height}` };
  } finally {
    await rm(source, { force: true });
  }
}

/** Renders the chosen stories of a set (parallel, 2 at a time); streams `story_status` events. */
export async function renderStories(input: { setId: string; storyIds: string[]; durationSec?: StoryDuration; quality: VideoQuality }) {
  const set = await loadStorySet(input.setId);
  const chosen = input.storyIds.map((storyId) => {
    const story = set.stories.find((item) => item.id === storyId);
    if (!story) throw new StoryError(`Story "${storyId}" is not in set ${set.id}.`, 404);
    return story;
  });
  const durationSec = input.durationSec ?? set.durationSec;
  const limit = createLimiter(RENDER_CONCURRENCY);
  const startedAt = Date.now();
  const results = await Promise.all(chosen.map((story) => limit(async () => {
    const began = Date.now();
    const status = (state: string, extra: Partial<{ projectId: string; videoUrl: string; error: string }> = {}) => {
      emitEvent({ type: "story_status", storyId: story.id, status: state, elapsedMs: Date.now() - began, ...extra });
      emitEvent({ type: "stage", stage: "video", label: `${story.title} · ${state} · ${Math.round((Date.now() - began) / 1000)}s` });
    };
    try {
      const rendered = await renderStory(set, story, durationSec, input.quality, status);
      status("done", { projectId: rendered.project.id, videoUrl: rendered.project.videoUrl });
      return { storyId: story.id, project: rendered.project, render: rendered.render, delivered: rendered.delivered, elapsedMs: Date.now() - began };
    } catch (error) {
      if (error instanceof ClientAbortedError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logException("story_render_failed", error, { setId: set.id, storyId: story.id });
      status("failed", { error: message.slice(0, 300) });
      return { storyId: story.id, error: message, elapsedMs: Date.now() - began };
    }
  })));
  const latest = await loadStorySet(set.id).catch(() => set);
  latest.renders.push(...results.flatMap((result) => "render" in result && result.render ? [result.render] : []));
  await saveStorySet(latest);
  return { set: latest, results, elapsedMs: Date.now() - startedAt };
}
