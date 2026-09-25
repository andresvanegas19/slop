import { createChatCompletion, openRouterModel } from "@/lib/openrouter";
import { emitEvent, isStreaming } from "@/lib/progress";
import { copiesGuidance, dropUnrequestedStyle, styleTermsIn } from "@/lib/prompt-enhance";
import { retrieveContext } from "@/lib/rag";
import { logException, logInfo } from "@/lib/runtime-log";

/**
 * Cinematic prompt writer: turns storyboard scenes (or a quick-clip idea) into film-still keyframe prompts (FLUX image)
 * and motion prompts (FLUX 3 image-to-video). A short "continuity bible" (people + wardrobe, location, time/weather,
 * grade) is derived once per storyboard and prepended to every prompt so shots look like one film.
 * Never throws: any LLM failure falls back to deterministic templates.
 */

const LLM_TIMEOUT_MS = 45_000;
const KEYFRAME_MAX_WORDS = 80;
const MOTION_MAX_WORDS = 50;
const BIBLE_FIELD_MAX_WORDS = 32;

/**
 * House look: real footage filmed on a phone by someone who is there — not a presentation, not an illustration.
 * (Name kept for callers; it is the phone-footage look, not a film-stock look.)
 */
export const FILM_LOOK = "Handheld smartphone footage with slight natural sway and micro-jitter, available natural light, phone-lens shallow depth of field, true-to-life color with gentle warmth, candid and unposed";
export const HOUSE_LOOK = FILM_LOOK;

/** Phone-like camera moves: exactly one per shot. */
export const CAMERA_MOVES = [
  "walking follow",
  "slow push in by hand",
  "quick reframe",
  "over-the-shoulder",
  "handheld pan",
  "handheld hold",
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

const CAMERA_PATTERNS: [RegExp, CameraMove][] = [
  [/\bover[- ]the[- ]shoulder\b|\bOTS\b/i, "over-the-shoulder"],
  [/\bwalking\b|\bfollow(?:s|ing)?\b|\btracking\b/i, "walking follow"],
  [/\b(?:dolly|push(?:es|ing)?|mov(?:es|ing)?|step(?:s|ping)?|lean(?:s|ing)?)\s*(?:slowly\s*)?(?:in|forward|closer)\b|\bpush[- ]in\b|\bslow push\b/i, "slow push in by hand"],
  [/\breframe[sd]?\b|\bwhip\b|\bswings?\b/i, "quick reframe"],
  [/\bpan(?:s|ning)?\b|\bsweeps?\b/i, "handheld pan"],
  [/\bhand-?held\b|\bstatic\b|\blocked[- ]off\b|\bholds?\b|\bsteady\b/i, "handheld hold"],
];
const ANY_CAMERA_PHRASE = /\b(?:camera|phone|dolly|push(?:es|ing)?[- ]in|pull(?:s|ing)?[- ](?:out|back)|hand-?held|pans?|panning|crane[sd]?|tracking|reframe[sd]?|over[- ]the[- ]shoulder|locked[- ]off|static shot|tilt(?:s|ing)?|orbit(?:s|ing)?|zoom(?:s|ing)?)\b/i;

export type ContinuityBible = { characters: string; location: string; time: string; grade: string };

export type CinematicSceneInput = {
  durationSec: number;
  narration: string;
  headline?: string;
  /** The scene's visual idea (the storyboard style prefix already removed). */
  visual: string;
  /** Optional story-beat label ("hook", "who", "cta"...). */
  beat?: string;
};

export type CinematicShot = {
  /** Full FLUX image prompt for the keyframe still. */
  keyframePrompt: string;
  /** Full FLUX 3 i2v prompt (motion + one camera move + look + ambient audio). */
  motionPrompt: string;
  camera: CameraMove;
  beat: string;
  sound: string;
  source: "llm" | "fallback";
  /** The shot description before the bible/look were added (for logs and the UI). */
  keyframe: string;
  motion: string;
};

export type CinematicPlan = {
  bible: ContinuityBible;
  bibleText: string;
  bibleSource: "llm" | "fallback";
  shots: CinematicShot[];
  source: "llm" | "partial" | "fallback";
  guidanceSources: string[];
};

// ---------- helpers ----------

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
  if (parts.length <= max) return text;
  const cut = parts.slice(0, max).join(" ");
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return end > cut.length * 0.5 ? cut.slice(0, end + 1) : cut.replace(/[,;:\s]+$/, "");
}

function stripMarkup(raw: string) {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|[^|]*\|>/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\*\*|__|`|#+\s*/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const TEXT_SENTENCE = /\b(?:text|letters?|lettering|logos?|captions?|signs?|signage|typography|words?|headlines?|titles?|labels?|banners?|slogans?|written|writing|brand name)\b/i;
const JUNK = /\b(?:keyframe|motion|shot \d|scene \d)\s*:|\bas an ai\b|^sorry\b|^i (?:can(?:'|no)t|am unable)/i;

/** Cleans one LLM-written prose field: markup, quoted words, text/logo sentences and non-photographic styles removed. */
function cleanProse(raw: string | undefined, maxWords: number, minWords = 6, allowedStyleText = ""): string | undefined {
  if (!raw) return undefined;
  let text = stripMarkup(raw)
    .replace(/["“”][^"“”]*["“”]/g, "")
    .replace(/^\s*(?:keyframe|image|motion|sound|audio|shot\s*\d+)\s*[:\-–]\s*/i, "")
    .replace(/["“”]/g, "")
    .trim();
  if (!text || JUNK.test(text)) return undefined;
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  text = sentences.filter((sentence) => !TEXT_SENTENCE.test(sentence)).join(" ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  // The allowed style IS cinematic photography: drop sentences that bring in illustration/cartoon/vector looks.
  const photographic = dropUnrequestedStyle(text, allowedStyleText);
  if (!photographic) return undefined;
  text = capWords(photographic, maxWords).replace(/[,;:\s]+$/, "");
  return words(text).length >= minWords ? text.replace(/\.+$/, "") : undefined;
}

export function detectCameraMove(text: string): CameraMove | undefined {
  for (const [pattern, move] of CAMERA_PATTERNS) if (pattern.test(text)) return move;
  return undefined;
}

/** Removes every sentence that names a camera move, so the prompt can state exactly ONE move explicitly. */
function withoutCameraSentences(text: string) {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const kept = sentences.filter((sentence) => !ANY_CAMERA_PHRASE.test(sentence)).join(" ").replace(/\s+/g, " ").trim();
  return kept || text;
}

export function beatFor(index: number, count: number, label?: string) {
  const role = label ? `${label}: ` : "";
  if (count === 1) return `${role}a single moment: a hook that resolves into a small payoff`;
  if (index === 0) return `${role}hook: open on the world and its people, make the viewer curious`;
  if (index === count - 1) return `${role}payoff: a warm, satisfying closing image that leaves a feeling`;
  return `${role}build: a concrete human action that moves the story forward`;
}

function defaultCamera(index: number, count: number): CameraMove {
  if (count === 1) return "slow push in by hand";
  if (index === 0) return "walking follow";
  if (index === count - 1) return "slow push in by hand";
  return (["over-the-shoulder", "handheld hold", "quick reframe", "handheld pan"] as const)[(index - 1) % 4];
}

function defaultFraming(index: number, count: number) {
  if (count === 1) return "filmed on a phone at eye level, intimate medium shot, natural background blur";
  if (index === 0) return "filmed on a phone at chest height, medium-wide shot that shows the place, natural background blur";
  if (index === count - 1) return "filmed on a phone at eye level, close shot on faces and hands, soft background blur";
  return "filmed on a phone at eye level, intimate medium close shot, natural background blur";
}

const PEOPLE = /\b(?:people|person|owners?|team|staff|couple|family|friends?|customers?|guests?|walkers?|barista|chef|woman|women|man|men|kids?|children|founders?|employees?|colleagues?|workers?|hands?|smil\w*|greet\w*|portrait)\b/i;

function fallbackBible(brief: string, scenes: CinematicSceneInput[]): ContinuityBible {
  const all = `${brief} ${scenes.map((scene) => `${scene.visual} ${scene.narration}`).join(" ")}`;
  const lower = all.toLowerCase();
  const time = /\bnight\b/.test(lower) ? "night, clear and calm, warm practical lights glowing"
    : /\b(?:dawn|sunrise|early morning)\b/.test(lower) ? "early morning just after sunrise, low warm sun, light mist"
    : /\brain\w*\b/.test(lower) ? "soft overcast afternoon after rain, wet reflective ground"
    : /\bsnow\w*\b/.test(lower) ? "crisp winter afternoon, light snow, low sun"
    : "golden hour, low warm sun, clear sky with a light breeze";
  const place = brief.replace(/\s+/g, " ").replace(/^(?:make|create|generate)\s+(?:an?\s+)?/i, "").split(/[.;!?\n]/)[0]?.trim() ?? "";
  return {
    characters: PEOPLE.test(all)
      ? "the same two people in every shot: a woman in her thirties with dark hair tied back in an oatmeal knit sweater, and a man in his forties with a short grey beard in a navy canvas work jacket"
      : "none",
    location: capWords(place || "a real, lived-in place with natural textures", BIBLE_FIELD_MAX_WORDS).replace(/\.+$/, ""),
    time,
    grade: "true-to-life smartphone color, gentle warmth in the highlights, natural contrast, real skin tones",
  };
}

export function bibleToText(bible: ContinuityBible) {
  const people = /^(?:none|no one|nobody|n\/a)\b/i.test(bible.characters.trim()) ? "" : `Recurring people: ${bible.characters.replace(/\.+$/, "")}. `;
  return `${people}Location: ${bible.location.replace(/\.+$/, "")}. Time and weather: ${bible.time.replace(/\.+$/, "")}. Grade: ${bible.grade.replace(/\.+$/, "")}.`;
}

function tokenSink() {
  return isStreaming() ? (text: string) => emitEvent({ type: "token", field: "enhancedPrompt", text }) : undefined;
}

async function complete(system: string, user: string, maxTokens: number, temperature: number, stream: boolean) {
  const model = openRouterModel();
  const result = await withTimeout(createChatCompletion({
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    maxTokens,
    temperature,
    ...(stream ? { onToken: tokenSink() } : {}),
  }), LLM_TIMEOUT_MS);
  return result;
}

function guidanceSection(guidance: string) {
  return guidance ? `\n\n=== Guidance (general craft notes; never copy its sentences) ===\n${guidance}\n=== End guidance ===` : "";
}

// ---------- continuity bible ----------

const BIBLE_SYSTEM = [
  "You are directing a short, real-life video filmed on a phone by someone who is there. Read the script and decide the continuity that every shot must share.",
  "Write exactly four lines, each under 30 words:",
  "CHARACTERS: who appears in the film (age, hair, wardrobe with specific colors), or 'none' if no people appear",
  "LOCATION: the one real place and its visible landmarks and textures",
  "TIME: time of day, weather and the available light (golden hour, window light or street light)",
  "GRADE: color as a phone captures it (true-to-life, gentle warmth, natural contrast)",
  "Real people and real places only: never illustration, cartoon, vector or 3D. No text, signs or logos. Output ONLY the four lines, nothing else.",
].join("\n");

function parseBible(raw: string): Partial<ContinuityBible> {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const result: Partial<ContinuityBible> = {};
  const keys: Record<string, keyof ContinuityBible> = { characters: "characters", character: "characters", people: "characters", location: "location", setting: "location", time: "time", weather: "time", grade: "grade", look: "grade" };
  for (const line of text.split(/\n+/)) {
    const match = line.match(/^\W*(characters?|people|location|setting|time|weather|grade|look)\W*\s*[:\-–]\s*(.+)$/i);
    if (!match) continue;
    const key = keys[match[1].toLowerCase()];
    if (result[key]) continue;
    const value = stripMarkup(match[2]).replace(/["“”]/g, "").replace(/\.+$/, "").trim();
    if (!value || JUNK.test(value)) continue;
    if (key === "characters" && /^(?:none|no one|nobody|n\/a)\b/i.test(value)) {
      result.characters = "none";
      continue;
    }
    if (styleTermsIn(value).length || TEXT_SENTENCE.test(value)) continue;
    result[key] = capWords(value, BIBLE_FIELD_MAX_WORDS);
  }
  return result;
}

function scriptBlock(brief: string, scenes: CinematicSceneInput[], companyContext?: string) {
  return [
    companyContext ? `Company context (true facts; use only what fits, never as on-screen text):\n${companyContext}\n` : undefined,
    `Brief: ${brief}`,
    "Script:",
    ...scenes.map((scene, index) => `Scene ${index + 1} (${scene.durationSec}s): narration "${scene.narration}"; visual idea: ${scene.visual}`),
  ].filter(Boolean).join("\n");
}

async function writeBible(brief: string, scenes: CinematicSceneInput[], companyContext: string | undefined, stream: boolean) {
  const fallback = fallbackBible(brief, scenes);
  try {
    const result = await complete(BIBLE_SYSTEM, `${scriptBlock(brief, scenes, companyContext)}\n\nWrite the four continuity lines now.`, 1_500, 0.4, stream);
    const parsed = parseBible(result.content);
    const found = Object.keys(parsed).length;
    logInfo("cinematic_bible_written", { found, finishReason: result.finishReason, chars: result.content.length });
    if (found === 0) return { bible: fallback, source: "fallback" as const };
    return { bible: { ...fallback, ...parsed }, source: "llm" as const };
  } catch (error) {
    logException("cinematic_bible_failed", error);
    return { bible: fallback, source: "fallback" as const };
  }
}

// ---------- shots ----------

function shotSystem(count: number, guidance: string, keepStyle?: string) {
  return [
    `You write ${count === 1 ? "one shot" : `${count} shots`} of a short real-life video that feels filmed on a phone by someone who is there. An image model makes the opening frame and an image-to-video model makes the motion.`,
    count === 1 ? "The video is a single continuous shot." : "Each shot is one continuous handheld shot; together they tell one small story: hook, build, payoff.",
    "For EVERY shot write exactly three lines:",
    "KEYFRAME: one frame in 35 to 70 words, in this order: candid real people with a concrete action and a genuine emotion (a laugh, a glance, a hand on a shoulder); the place; the available natural light (golden hour, window light, street light); the framing (phone camera at eye level, intimate close or medium shot, natural background blur).",
    `MOTION: 15 to 40 words: what moves during the shot (people, hands, hair, light, water, steam) and exactly ONE phone-like camera move, chosen from: ${CAMERA_MOVES.join(", ")}.`,
    "SOUND: under 12 words of natural ambient sound (no music, no speech).",
    "Output format (repeat for each shot, nothing else):",
    "SHOT 1",
    "KEYFRAME: ...",
    "MOTION: ...",
    "SOUND: ...",
    "Rules: moments over products; show, don't tell — turn the narration into a visible human moment instead of illustrating words.",
    "Follow the continuity notes exactly: the same people, wardrobe, location, time of day, light direction and grade in every shot.",
    keepStyle
      ? `Keep the user's visual style (${keepStyle}).`
      : "Real footage only: never illustration, cartoon, vector, isometric, 3D render or painting, never posed studio shots.",
    "Never put text, letters, signs, screens with words, or logos in the picture. Describe what you want to see, not what to avoid.",
    "No markdown, no quotes, no explanations.",
  ].join("\n") + guidanceSection(guidance);
}

type ParsedShot = Partial<Record<"keyframe" | "motion" | "sound", string>>;

export function parseShots(raw: string, count: number): ParsedShot[] {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/\r/g, "");
  const field = /^\W*(keyframe|image|still|motion|movement|sound|audio)\W*\s*[:\-–]\s*(.+)$/i;
  const alias: Record<string, keyof ParsedShot> = { keyframe: "keyframe", image: "keyframe", still: "keyframe", motion: "motion", movement: "motion", sound: "sound", audio: "sound" };
  const result: ParsedShot[] = Array.from({ length: count }, () => ({}));
  const markers = [...text.matchAll(/^\W*(?:shot|scene)\s*(\d+)\b/gim)];
  if (markers.length >= Math.min(2, count) && markers.length > 0) {
    markers.forEach((marker, index) => {
      const shotIndex = Number(marker[1]) - 1;
      if (shotIndex < 0 || shotIndex >= count) return;
      const end = markers[index + 1]?.index ?? text.length;
      const block = text.slice((marker.index ?? 0) + marker[0].length, end);
      for (const line of block.split("\n")) {
        const match = line.match(field);
        if (match) result[shotIndex][alias[match[1].toLowerCase()]] ??= match[2].trim();
      }
    });
    return result;
  }
  const counters: Record<keyof ParsedShot, number> = { keyframe: 0, motion: 0, sound: 0 };
  for (const line of text.split("\n")) {
    const match = line.match(field);
    if (!match) continue;
    const key = alias[match[1].toLowerCase()];
    const index = counters[key]++;
    if (index < count) result[index][key] = match[2].trim();
  }
  return result;
}

function fallbackShot(scene: CinematicSceneInput, index: number, count: number, bible: ContinuityBible) {
  const visual = cleanProse(scene.visual, 45, 3) ?? "a quiet, human moment in the place";
  const light = /golden|sunset|sunrise|dawn/i.test(bible.time) ? "low golden-hour sun behind them, warm glow on hair and shoulders" : "available natural light, soft and warm";
  const keyframe = `${visual}, ${light}, ${defaultFraming(index, count)}`;
  const camera = defaultCamera(index, count);
  const motion = index === 0
    ? "Life is already happening: people move with small unhurried gestures, hair and clothes stir in the breeze, someone glances up"
    : index === count - 1
      ? "A genuine closing moment: a laugh, a shared glance or a hand on a shoulder, the light warm on their faces"
      : "The moment unfolds naturally, real gestures and hands at work, a quick look between them, light shifting gently";
  return { keyframe, motion, camera, sound: "soft natural ambience of the place, a light breeze" };
}

function assembleShot(
  parts: { keyframe: string; motion: string; camera: CameraMove; sound: string },
  bibleText: string,
  beat: string,
  source: "llm" | "fallback",
  look: string,
): CinematicShot {
  const lookSentence = look ? ` ${look}.` : "";
  const keyframePrompt = `${bibleText} ${parts.keyframe}.${lookSentence} A real, candid frame with clean, unbranded surfaces and no visible text.`.replace(/\s+/g, " ").trim();
  const motionPrompt = [
    bibleText,
    `${parts.motion.replace(/[.\s]*$/, ".")}`,
    `Camera: ${parts.camera}, held by hand like a phone, with slight natural sway; the opening frame is the given image and the same people, wardrobe, light and color hold throughout.`,
    look ? `${look}.` : "",
    `Audio: ${parts.sound.replace(/[.\s]*$/, "")}; no dialogue, no music.`,
    "No on-screen text, no cuts.",
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return { keyframePrompt, motionPrompt, camera: parts.camera, beat, sound: parts.sound, source, keyframe: parts.keyframe, motion: parts.motion };
}

function finishMotion(rawMotion: string | undefined, fallbackCamera: CameraMove) {
  const motion = cleanProse(rawMotion, MOTION_MAX_WORDS, 4);
  if (!motion) return undefined;
  const camera = detectCameraMove(motion) ?? fallbackCamera;
  const cleaned = withoutCameraSentences(`${motion}.`).replace(/\.+$/, "");
  return { motion: cleaned, camera };
}

/**
 * Writes the continuity bible + one keyframe/motion prompt pair per scene. Streams the model output as
 * `enhancedPrompt` tokens when the request is streaming.
 */
export async function writeCinematicPlan(input: {
  brief: string;
  scenes: CinematicSceneInput[];
  companyContext?: string;
  /** Film look appended to every prompt (default FILM_LOOK). */
  look?: string;
}): Promise<CinematicPlan> {
  const count = input.scenes.length;
  const stream = isStreaming();
  const look = input.look ?? FILM_LOOK;
  const rag = await retrieveContext(`${input.brief} phone footage handheld shot natural light camera move continuity story beats emotion`, { k: 3, maxChars: 1_400, tags: ["cinematic", "storytelling", "motion"] });
  const { bible, source: bibleSource } = await writeBible(input.brief, input.scenes, input.companyContext, stream);
  const bibleText = bibleToText(bible);
  const beats = input.scenes.map((scene, index) => beatFor(index, count, scene.beat));

  let parsed: ParsedShot[] | undefined;
  try {
    const user = [
      `Continuity notes (every shot): ${bibleText}`,
      "",
      scriptBlock(input.brief, input.scenes, input.companyContext),
      "",
      "Shots to write:",
      ...input.scenes.map((scene, index) => `SHOT ${index + 1} (${scene.durationSec}s) — beat: ${beats[index]}. Narration heard over it: "${scene.narration}". Visual idea: ${scene.visual}`),
      "",
      `Write all ${count} shots now.`,
    ].join("\n");
    let maxTokens = 2_400 + 300 * count;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await complete(shotSystem(count, rag.text), user, maxTokens, 0.5, stream && attempt === 0);
      const candidate = parseShots(result.content, count);
      const found = candidate.filter((shot) => shot.keyframe).length;
      logInfo("cinematic_shots_written", { attempt, found, count, finishReason: result.finishReason, chars: result.content.length });
      if (found > 0) {
        parsed = candidate;
        break;
      }
      if (result.finishReason === "length") maxTokens *= 2;
    }
  } catch (error) {
    logException("cinematic_shots_failed", error, { count });
  }

  let llmShots = 0;
  const shots = input.scenes.map((scene, index) => {
    const fallback = fallbackShot(scene, index, count, bible);
    const raw = parsed?.[index] ?? {};
    const ownText = `${input.brief} ${scene.visual} ${scene.narration} ${bibleText}`;
    let keyframe = cleanProse(raw.keyframe, KEYFRAME_MAX_WORDS, 8);
    if (keyframe && copiesGuidance(keyframe, rag.text, ownText)) {
      logInfo("cinematic_keyframe_copied_guidance", { index });
      keyframe = undefined;
    }
    const motion = finishMotion(raw.motion, fallback.camera);
    const sound = cleanProse(raw.sound, 14, 2) ?? fallback.sound;
    if (!keyframe) return assembleShot(fallback, bibleText, beats[index], "fallback", look);
    llmShots += 1;
    // A missing motion line keeps the LLM keyframe with the template motion.
    return assembleShot({ keyframe, motion: motion?.motion ?? fallback.motion, camera: motion?.camera ?? fallback.camera, sound }, bibleText, beats[index], "llm", look);
  });

  const source = llmShots === 0 ? "fallback" : llmShots === count ? "llm" : "partial";
  logInfo("cinematic_plan_ready", { count, source, bibleSource, guidance: rag.sources.length });
  if (stream) {
    emitEvent({ type: "prompt", enhancedPrompt: [`Continuity — ${bibleText}`, ...shots.map((shot, index) => `Shot ${index + 1} (${shot.camera}): ${shot.keyframe}`)].join("\n") });
  }
  return { bible, bibleText, bibleSource, shots, source, guidanceSources: rag.sources.map((item) => item.path) };
}

// ---------- quick clips (single shot, text-to-video) ----------

const SPECIFIC_TERMS = /\b(?:dolly|pan|handheld|crane|tracking|close-?up|wide shot|medium shot|\d{2}mm|lens|depth of field|bokeh|golden hour|backlit|rim light|soft light|film|grain|portra|anamorphic|lighting|phone|smartphone|over-the-shoulder)\b/gi;

/** Placeholder prompts ("From: <title>", "Uploaded video: <file>") or prompts that already direct the shot in detail. */
export function shouldBypassShotWriter(prompt: string) {
  const text = prompt.trim();
  if (/^(?:from|uploaded video):/i.test(text)) return true;
  const specific = new Set((text.match(SPECIFIC_TERMS) ?? []).map((term) => term.toLowerCase())).size;
  return words(text).length >= 70 && specific >= 3;
}

export type CinematicClipPrompt = { prompt: string; source: "llm" | "fallback" | "raw"; camera?: CameraMove };

/**
 * One cinematic shot for FLUX 3 text-to-video: subject/action/emotion, setting/time, light, lens, ONE camera move,
 * film look and ambient audio, in a single paragraph. Keeps a user-named style (e.g. anime) instead of the film look.
 */
export async function writeCinematicClipPrompt(idea: string, clipSeconds: number, options: { companyContext?: string } = {}): Promise<CinematicClipPrompt> {
  const clean = idea.replace(/\s+/g, " ").trim();
  if (shouldBypassShotWriter(clean)) {
    logInfo("cinematic_clip_prompt_bypassed", { length: clean.length });
    return { prompt: clean, source: "raw" };
  }
  const userStyles = styleTermsIn(clean);
  const keepStyle = userStyles.length ? userStyles.join(", ") : undefined;
  const look = keepStyle ? "" : FILM_LOOK;
  const scene: CinematicSceneInput = { durationSec: clipSeconds, narration: "", visual: clean };
  const bible = fallbackBible(clean, [scene]);
  const fallbackParts = fallbackShot(scene, 0, 1, bible);
  const assemble = (parts: { keyframe: string; motion: string; camera: CameraMove; sound: string }) => [
    `${parts.keyframe.replace(/[.\s]*$/, ".")}`,
    `${parts.motion.replace(/[.\s]*$/, ".")}`,
    `Camera: ${parts.camera}, held by hand like a phone, with slight natural sway.`,
    look ? `${look}.` : "",
    `Audio: ${parts.sound.replace(/[.\s]*$/, "")}.`,
    "No on-screen text.",
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const fallbackPrompt = () => assemble({ ...fallbackParts, keyframe: `${clean.replace(/[.\s]*$/, "")}, ${keepStyle ? "" : "available natural light with gentle warmth, "}${defaultFraming(0, 1)}` });
  try {
    const rag = await retrieveContext(`${clean} phone footage handheld shot natural light camera move emotion`, { k: 2, maxChars: 900, tags: ["cinematic", "motion"] });
    const user = [
      options.companyContext ? `Company context (use only where it fits; never as on-screen text):\n${options.companyContext}\n` : undefined,
      `Idea (keep everything the user asked for; ${clipSeconds} seconds; the key moment lands early): ${clean}`,
      "SHOT 1 — write it now.",
    ].filter(Boolean).join("\n");
    const result = await complete(shotSystem(1, rag.text, keepStyle), user, 1_600, 0.5, true);
    const parsed = parseShots(result.content, 1)[0] ?? {};
    // Style guard: the user's own style words are allowed; nothing else non-photographic.
    let keyframe = cleanProse(parsed.keyframe, KEYFRAME_MAX_WORDS, 8, keepStyle ? clean : "");
    if (keyframe && copiesGuidance(keyframe, rag.text, clean)) keyframe = undefined;
    if (!keyframe) {
      logInfo("cinematic_clip_prompt_fallback", { finishReason: result.finishReason, chars: result.content.length });
      const prompt = fallbackPrompt();
      emitEvent({ type: "prompt", enhancedPrompt: prompt });
      return { prompt, source: "fallback", camera: fallbackParts.camera };
    }
    const motion = finishMotion(parsed.motion, fallbackParts.camera);
    const parts = {
      keyframe: withoutCameraSentences(`${keyframe}.`).replace(/\.+$/, ""),
      motion: motion?.motion ?? fallbackParts.motion,
      camera: motion?.camera ?? fallbackParts.camera,
      sound: cleanProse(parsed.sound, 14, 2) ?? fallbackParts.sound,
    };
    const prompt = assemble(parts);
    logInfo("cinematic_clip_prompt_written", { length: prompt.length, camera: parts.camera, keepStyle });
    emitEvent({ type: "prompt", enhancedPrompt: prompt });
    return { prompt, source: "llm", camera: parts.camera };
  } catch (error) {
    logException("cinematic_clip_prompt_failed", error);
    const prompt = fallbackPrompt();
    emitEvent({ type: "prompt", enhancedPrompt: prompt });
    return { prompt, source: "fallback", camera: fallbackParts.camera };
  }
}
