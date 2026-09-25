import { createChatCompletion, openRouterModel } from "@/lib/openrouter";
import { userContextBlock } from "@/lib/user-context";
import { titleFromPrompt } from "@/lib/projects";
import { retrieveContext } from "@/lib/rag";
import { logException, logInfo } from "@/lib/runtime-log";

export const PRESET_IDS = ["ad", "company"] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const PRESET_DURATIONS = [5, 10, 15, 30] as const;
export type PresetDuration = (typeof PRESET_DURATIONS)[number];
/** Only 16:9 is supported: the storyboard renderer outputs a fixed 1920x1080 video. */
export const PRESET_ASPECTS = ["16:9"] as const;
export type PresetAspect = (typeof PRESET_ASPECTS)[number];

export const WORDS_PER_SECOND = 2.5;
const HEADLINE_MAX_WORDS = 6;
const HEADLINE_MAX_CHARS = 48;
const VISUAL_MIN_WORDS = 5;
const VISUAL_MAX_WORDS = 60;
const CROSSFADE = "crossfade_0.3s";
const MIN_SCENE_MS = 1_000;

export type PresetScene = {
  scene: number;
  start_sec: number;
  duration_sec: number;
  type: string;
  narration: string;
  on_screen_text: { headline: string };
  image_prompt: string;
  motion: "slow zoom out" | "slow push in";
  transition_out: string;
  change_ids: string[];
};

export type PresetStoryboard = {
  storyboard_id: string;
  preset: PresetId;
  title: string;
  prompt: string;
  total_duration_sec: number;
  style: { prompt_prefix: string; seed: number; aspect_ratio: PresetAspect; resolution: string };
  scenes: PresetScene[];
  voiceover_full: string;
  narration_warnings: never[];
};

export type PresetTextSource = "llm" | "partial" | "fallback";

type SceneText = { headline: string; narration: string; visual: string };
type Role = {
  type: string;
  /** What the scene must do, for the LLM. */
  goal: string;
  fallback: (subject: string) => SceneText;
};

type PresetDefinition = {
  label: string;
  titlePrefix: string;
  promptPrefix: string;
  ragTags: string[];
  ragQuery: string;
  roles: Record<PresetDuration, Role[]>;
};

// ---------- scene roles ----------

const ad = {
  hook: {
    type: "hook",
    goal: "HOOK: grab attention instantly with a bold, surprising image and a punchy line about the viewer's problem or desire.",
    fallback: (s: string) => ({
      headline: `Meet ${s}`,
      narration: `Meet ${s}.`,
      visual: `a striking hero close-up of ${s}, dramatic rim light, bold diagonal composition, subject on the left third`,
    }),
  },
  product: {
    type: "product",
    goal: "PRODUCT/OFFER: show the product clearly as the hero and say what it is in plain words.",
    fallback: (s: string) => ({
      headline: s,
      narration: `This is ${s}, made for you.`,
      visual: `${s} shown as the hero product on a clean pedestal, soft key light from the left, seamless backdrop`,
    }),
  },
  benefit: {
    type: "benefit",
    goal: "KEY BENEFIT: show the main result the customer gets (the outcome, not a feature list).",
    fallback: (s: string) => ({
      headline: "Made for your day",
      narration: `${s} makes every day easier.`,
      visual: `a smiling person enjoying ${s} in a bright, modern everyday setting, natural window light`,
    }),
  },
  benefit2: {
    type: "benefit",
    goal: "SECOND BENEFIT: show another clear, concrete benefit in a real-life moment.",
    fallback: (s: string) => ({
      headline: "Less effort, more life",
      narration: "Spend less time, get more done.",
      visual: `a relaxed person in a calm, sunlit room while ${s} sits nearby, warm tones, shallow depth of field`,
    }),
  },
  proof: {
    type: "proof",
    goal: "PROOF: show trust (happy customers, a quality detail, or a satisfying result).",
    fallback: (s: string) => ({
      headline: "Loved by customers",
      narration: "People love the difference.",
      visual: `a macro detail shot of ${s} highlighting quality materials and craftsmanship, glossy highlights`,
    }),
  },
  cta: {
    type: "cta",
    goal: "CALL TO ACTION: end with one clear, direct action for the viewer (try, buy, visit).",
    fallback: (s: string) => ({
      headline: "Try it today",
      narration: `Try ${s} today.`,
      visual: `${s} centered on a clean, vibrant backdrop with generous empty space around it, confident hero lighting`,
    }),
  },
} satisfies Record<string, Role>;

const company = {
  who: {
    type: "who",
    goal: "WHO WE ARE: introduce the company with its real people or place, warm and human.",
    fallback: (s: string) => ({
      headline: `Meet ${s}`,
      narration: `We are ${s}.`,
      visual: "a welcoming team standing together in a sunlit modern workspace, genuine smiles, medium-wide shot",
    }),
  },
  what: {
    type: "what",
    goal: "WHAT WE DO: show the work itself in action, concrete and specific.",
    fallback: () => ({
      headline: "What we do",
      narration: "We build things that help people.",
      visual: "hands at work on a real project at a wooden workbench, focused expression, soft natural side light",
    }),
  },
  what2: {
    type: "what",
    goal: "HOW WE WORK: show the team collaborating on the work, another concrete angle.",
    fallback: () => ({
      headline: "Built together",
      narration: "Every project is a team effort.",
      visual: "colleagues collaborating around a table covered with sketches and prototypes, candid moment, warm light",
    }),
  },
  why: {
    type: "why",
    goal: "WHY IT MATTERS: show the impact on customers or the community.",
    fallback: () => ({
      headline: "Why it matters",
      narration: "Because real people depend on it.",
      visual: "a happy customer using the result of the company's work in everyday life, golden hour light",
    }),
  },
  proof: {
    type: "proof",
    goal: "PROOF: show evidence of trust (customers, results, craftsmanship, growth).",
    fallback: () => ({
      headline: "Trusted every day",
      narration: "Customers trust us every day.",
      visual: "a busy, friendly storefront or office with customers being greeted by staff, documentary style",
    }),
  },
  people: {
    type: "people",
    goal: "OUR PEOPLE: a candid portrait moment of one team member who embodies the culture.",
    fallback: () => ({
      headline: "People first",
      narration: "Our people make the difference.",
      visual: "a candid portrait of a smiling team member at their workspace, shallow depth of field, soft window light",
    }),
  },
  cta: {
    type: "cta",
    goal: "CALL TO ACTION: invite the viewer to take one clear step (visit, join, get in touch).",
    fallback: (s: string) => ({
      headline: "Join us today",
      narration: `Discover ${s} today.`,
      visual: "the team waving goodbye at the entrance of their workplace, open doors, warm inviting light",
    }),
  },
} satisfies Record<string, Role>;

export const PRESETS: Record<PresetId, PresetDefinition> = {
  ad: {
    label: "New ad",
    titlePrefix: "Ad",
    promptPrefix:
      "Bold, clean commercial product photography, studio lighting, vibrant but controlled palette, shallow depth of field, NO text, NO letters, NO logos.",
    ragTags: ["ad", "video", "production"],
    ragQuery: "ad hook product benefit call to action pacing narration",
    roles: {
      5: [ad.hook, ad.cta],
      10: [ad.hook, ad.product, ad.benefit, ad.cta],
      15: [ad.hook, ad.product, ad.benefit, ad.benefit2, ad.cta],
      30: [ad.hook, ad.product, ad.benefit, ad.benefit2, ad.proof, ad.benefit, ad.cta],
    },
  },
  company: {
    label: "Company short",
    titlePrefix: "Company",
    promptPrefix:
      "Warm documentary-style brand photography, natural light, authentic people and workplaces, cohesive color grade, NO text, NO letters, NO logos.",
    ragTags: ["company", "video", "production"],
    ragQuery: "company brand short who what why call to action authentic people pacing",
    roles: {
      5: [company.who, company.cta],
      10: [company.who, company.what, company.why, company.cta],
      15: [company.who, company.what, company.why, company.proof, company.cta],
      30: [company.who, company.what, company.what2, company.why, company.proof, company.people, company.cta],
    },
  },
};

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

export function isPresetDuration(value: unknown): value is PresetDuration {
  return typeof value === "number" && (PRESET_DURATIONS as readonly number[]).includes(value);
}

// ---------- timing ----------

/**
 * Integer-ms durations that sum exactly to `totalMs`: hook/opening ~18%, CTA ~22%, middle scenes split evenly
 * (rounded to 50ms; the last middle scene absorbs the remainder). Two scenes split 40/60.
 */
export function planDurationsMs(totalMs: number, count: number): number[] {
  if (count <= 1) return [totalMs];
  if (count === 2) {
    const first = Math.round((totalMs * 0.4) / 50) * 50;
    return [first, totalMs - first];
  }
  const first = Math.max(MIN_SCENE_MS, Math.round((totalMs * 0.18) / 50) * 50);
  const last = Math.max(MIN_SCENE_MS, Math.round((totalMs * 0.22) / 50) * 50);
  const middleCount = count - 2;
  const middleTotal = totalMs - first - last;
  const each = Math.floor(middleTotal / middleCount / 50) * 50;
  const middles = Array.from({ length: middleCount }, () => each);
  middles[middleCount - 1] += middleTotal - each * middleCount;
  return [first, ...middles, last];
}

export function narrationWordBudget(durationMs: number) {
  return Math.max(2, Math.floor((durationMs / 1000) * WORDS_PER_SECOND));
}

// ---------- sanitizing ----------

function stripMarkup(raw: string) {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|[^|]*\|>/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\*\*|__|`|#+\s*/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”"]/g, "")
    .replace(/^\s*(?:scene\s*\d+\s*[:.\-–]?\s*)?/i, "")
    .replace(/^\s*(?:headline|narration|visual|voice ?over|hook|cta|call to action)\s*[:\-–]\s*/i, "")
    .replace(/^['\s]+|['\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeJunk(text: string) {
  return /\b(?:headline|narration|visual)\s*:|scene \d|\bas an ai\b|^sorry\b|^i (?:can(?:'|no)t|am unable)|≤|<=|\bwords?\)|\[.*\]|\{.*\}/i.test(text);
}

function words(text: string) {
  return text.split(/\s+/).filter(Boolean);
}

export function sanitizeHeadline(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let text = stripMarkup(raw).replace(/[.,;:]+$/, "");
  if (!text || looksLikeJunk(text)) return undefined;
  const parts = words(text);
  if (parts.length > HEADLINE_MAX_WORDS) text = parts.slice(0, HEADLINE_MAX_WORDS).join(" ").replace(/[,;:\-–]+$/, "");
  if (text.length > HEADLINE_MAX_CHARS) text = text.slice(0, HEADLINE_MAX_CHARS).replace(/\s+\S*$/, "");
  return /[a-z0-9]/i.test(text) ? text : undefined;
}

/** Trims narration to the scene's word budget (~2.5 words/sec) on a word boundary and ends it with punctuation. */
export function fitNarration(raw: string | undefined, durationMs: number): string | undefined {
  if (!raw) return undefined;
  const text = stripMarkup(raw);
  if (!text || looksLikeJunk(text)) return undefined;
  const budget = narrationWordBudget(durationMs);
  const parts = words(text);
  let fitted = parts.slice(0, budget).join(" ");
  if (parts.length > budget) {
    // Prefer ending on a complete sentence if one fits.
    const sentenceEnd = Math.max(fitted.lastIndexOf(". "), fitted.lastIndexOf("! "), fitted.lastIndexOf("? "));
    if (sentenceEnd > 0 && words(fitted.slice(0, sentenceEnd)).length >= 2) fitted = fitted.slice(0, sentenceEnd + 1);
  }
  fitted = fitted.replace(/[,;:\-–\s]+$/, "");
  if (!/[a-z0-9]/i.test(fitted)) return undefined;
  return /[.!?]$/.test(fitted) ? fitted : `${fitted}.`;
}

const TEXT_WORDS = /\b(?:text|texts|letters?|lettering|logos?|captions?|signs?|signage|typography|words?|headlines?|titles?|labels?|banners?|slogans?|writing|written)\b/gi;

/** A concrete, text-free visual description (quoted strings and text-ish words removed). */
export function sanitizeVisual(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let text = raw.replace(/["“”][^"“”]*["“”]/g, "");
  text = stripMarkup(text)
    .replace(/\b(?:with|showing|reading|that says|saying)\s+(?:the\s+)?(?:text|words?|slogan|logo)\b[^,.]*/gi, "")
    .replace(TEXT_WORDS, "")
    .replace(/\s+([,.])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .replace(/^[,.\s]+|[,\s]+$/g, "")
    .trim();
  if (!text || looksLikeJunk(text)) return undefined;
  const parts = words(text);
  if (parts.length < VISUAL_MIN_WORDS) return undefined;
  if (parts.length > VISUAL_MAX_WORDS) text = parts.slice(0, VISUAL_MAX_WORDS).join(" ").replace(/[,;:\s]+$/, "");
  return text.replace(/\.+$/, "");
}

function shingles(text: string, size = 6) {
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  const result = new Set<string>();
  for (let index = 0; index + size <= tokens.length; index += 1) result.add(tokens.slice(index, index + size).join(" "));
  return result;
}

/** True when `text` copies a 6-word run from the RAG guidance that the user didn't write themselves. */
function copiesGuidance(text: string, guidance: string, prompt: string) {
  if (!guidance) return false;
  const guide = shingles(guidance);
  const own = shingles(prompt);
  for (const shingle of shingles(text)) if (guide.has(shingle) && !own.has(shingle)) return true;
  return false;
}

/** Short subject for fallback templates: "An ad for Brewly, a smart kettle" → "Brewly". */
/** Drops request boilerplate: "Make a 10s ad for Brewly, ..." → "Brewly, ...". */
export function stripRequestPrefix(prompt: string): string {
  const stripped = prompt
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:please\s+)?(?:(?:make|create|generate|write|produce|build)\s+)?(?:me\s+)?(?:an?\s+|the\s+|our\s+)?(?:(?:\d+\s*s(?:ec(?:ond)?s?)?|short|quick|new|video|promo(?:tional)?|brand|company)\s+)*(?:ad(?:vert(?:isement)?)?|commercial|video|short|spot|promo|story|intro(?:duction)?)?\s*(?:for|about|of|introducing|on)\s+/i, "");
  return stripped.length >= 2 ? stripped : prompt.trim();
}

/** Short subject for fallback templates: "An ad for Brewly, a smart kettle" → "Brewly". */
export function subjectFromPrompt(prompt: string): string {
  const cleaned = stripRequestPrefix(prompt.replace(/["“”`*_#]/g, "")).replace(/^(?:an?|the|our|my)\s+/i, "");
  const clause = cleaned.split(/[,.;:!?()\n]| - | – | — |\s+(?:that|which|who|where|with|to)\s+/i)[0]?.trim() ?? "";
  const subject = words(clause).slice(0, 5).join(" ");
  return subject.length >= 2 ? subject : "our product";
}

// ---------- LLM ----------

function systemPrompt(definition: PresetDefinition, roles: Role[], durations: number[], guidance: string) {
  const sceneLines = roles.map((role, index) => {
    const seconds = durations[index] / 1000;
    return `Scene ${index + 1} (${seconds}s): ${role.goal} NARRATION at most ${narrationWordBudget(durations[index])} words.`;
  });
  return [
    `You write the script for a ${roles.length}-scene ${definition.label.toLowerCase()} video (${durations.reduce((a, b) => a + b, 0) / 1000} seconds).`,
    ...sceneLines,
    "For EVERY scene write exactly three lines:",
    "HEADLINE: on-screen text, at most 6 words",
    "NARRATION: one short spoken sentence, within the word limit",
    "VISUAL: one concrete photo description (subject, setting, lighting, framing). No text, letters, signs or logos in the picture.",
    "Output format (repeat for each scene, nothing else):",
    "SCENE 1",
    "HEADLINE: ...",
    "NARRATION: ...",
    "VISUAL: ...",
    "Do not add explanations, numbering other than SCENE, markdown, or quotes. Use only facts from the user's brief; do not invent prices, statistics or awards.",
    ...(guidance ? ["", `${guidance}`, "The guidance is general advice: never copy its sentences into the script."] : []),
  ].join("\n");
}

type ParsedScene = Partial<Record<"headline" | "narration" | "visual", string>>;

/** Parses "SCENE n / HEADLINE: / NARRATION: / VISUAL:" blocks; falls back to field order if SCENE markers are missing. */
export function parseSceneLines(raw: string, count: number): ParsedScene[] {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/\r/g, "");
  const field = /^\W*(headline|narration|visual)\W*\s*[:\-–]\s*(.+)$/i;
  const result: ParsedScene[] = Array.from({ length: count }, () => ({}));
  const markers = [...text.matchAll(/^\W*scene\s*(\d+)\b/gim)];
  if (markers.length >= Math.min(2, count)) {
    markers.forEach((marker, index) => {
      const sceneIndex = Number(marker[1]) - 1;
      if (sceneIndex < 0 || sceneIndex >= count) return;
      const end = markers[index + 1]?.index ?? text.length;
      const block = text.slice((marker.index ?? 0) + marker[0].length, end);
      // "SCENE 1 HEADLINE: x" on one line: keep whatever follows the marker on that line.
      for (const line of block.split("\n")) {
        const match = line.match(field);
        if (match) {
          const key = match[1].toLowerCase() as keyof ParsedScene;
          result[sceneIndex][key] ??= match[2].trim();
        }
      }
    });
    return result;
  }
  const counters = { headline: 0, narration: 0, visual: 0 };
  for (const line of text.split("\n")) {
    const match = line.match(field);
    if (!match) continue;
    const key = match[1].toLowerCase() as keyof typeof counters;
    const index = counters[key]++;
    if (index < count) result[index][key] = match[2].trim();
  }
  return result;
}

async function writeWithLlm(definition: PresetDefinition, roles: Role[], durations: number[], prompt: string, companyContext?: string) {
  const rag = await retrieveContext(`${prompt} ${definition.ragQuery}`, { k: 3, maxChars: 1_200, tags: definition.ragTags });
  const userContext = await userContextBlock({ maxChars: 800 });
  const messages = [
    { role: "system" as const, content: systemPrompt(definition, roles, durations, rag.text) + userContext },
    {
      role: "user" as const,
      content: `${companyContext ? `Company context (true, current facts; use what fits the brief, never invent numbers):\n${companyContext}\n\n` : ""}Brief: ${prompt}\n\nWrite all ${roles.length} scenes now.`,
    },
  ];
  try {
    // The default model reasons before answering (~900 hidden tokens), so the budget must cover reasoning + script.
    let maxTokens = 2_400 + 150 * roles.length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await createChatCompletion({ model: openRouterModel(), messages, maxTokens, temperature: 0.5 });
      const parsed = parseSceneLines(result.content, roles.length);
      const found = parsed.filter((scene) => scene.headline || scene.narration || scene.visual).length;
      if (found > 0 || attempt === 1) {
        logInfo("preset_llm_reply", { preset: definition.titlePrefix, scenesFound: found, finishReason: result.finishReason, chars: result.content.length });
        return { parsed, guidance: rag.text };
      }
      logInfo("preset_llm_unusable_retry", { preset: definition.titlePrefix, finishReason: result.finishReason, chars: result.content.length });
      if (result.finishReason === "length") maxTokens *= 2;
    }
    return { parsed: undefined, guidance: rag.text };
  } catch (error) {
    logException("preset_llm_failed", error, { preset: definition.titlePrefix, scenes: roles.length });
    return { parsed: undefined, guidance: rag.text };
  }
}

// ---------- storyboard ----------

export async function buildPresetStoryboard(input: {
  preset: PresetId;
  prompt: string;
  durationSec: PresetDuration;
  aspect?: PresetAspect;
  /** Optional company agent brief (see company-agent.ts) or research profile (see research-agent.ts). */
  companyContext?: string;
  /** Optional visual-only direction appended to every image prompt (no digits, no text/logos; see researchVisualHint). */
  visualHint?: string;
}): Promise<{ storyboard: PresetStoryboard; source: PresetTextSource }> {
  const definition = PRESETS[input.preset];
  const prompt = input.prompt.replace(/\s+/g, " ").trim();
  const roles = definition.roles[input.durationSec];
  const totalMs = input.durationSec * 1000;
  const durations = planDurationsMs(totalMs, roles.length);
  const subject = subjectFromPrompt(prompt);
  const { parsed, guidance } = await writeWithLlm(definition, roles, durations, prompt, input.companyContext);

  let llmFields = 0;
  let startMs = 0;
  const scenes = roles.map((role, index): PresetScene => {
    const durationMs = durations[index];
    const fallback = role.fallback(subject);
    const raw = parsed?.[index] ?? {};
    const pick = (value: string | undefined, fallbackValue: string) => {
      if (value && !copiesGuidance(value, guidance, prompt)) {
        llmFields += 1;
        return value;
      }
      return fallbackValue;
    };
    const headline = pick(sanitizeHeadline(raw.headline), sanitizeHeadline(fallback.headline) ?? "Watch this");
    const narration = pick(fitNarration(raw.narration, durationMs), fitNarration(fallback.narration, durationMs) ?? "Watch this.");
    const visual = pick(sanitizeVisual(raw.visual), sanitizeVisual(fallback.visual) ?? fallback.visual);
    const scene: PresetScene = {
      scene: index + 1,
      start_sec: startMs / 1000,
      duration_sec: durationMs / 1000,
      type: role.type,
      narration,
      on_screen_text: { headline },
      image_prompt: `${definition.promptPrefix} ${visual}${input.visualHint ?? ""}`,
      motion: index === 0 ? "slow zoom out" : "slow push in",
      transition_out: CROSSFADE,
      change_ids: [],
    };
    startMs += durationMs;
    return scene;
  });

  const total = roles.length * 3;
  const source: PresetTextSource = llmFields === 0 ? "fallback" : llmFields === total ? "llm" : "partial";
  logInfo("preset_storyboard_built", { preset: input.preset, scenes: scenes.length, source, llmFields, total });

  return {
    source,
    storyboard: {
      storyboard_id: `${input.preset}_${new Date().toISOString().replace(/[:.]/g, "-")}`,
      preset: input.preset,
      title: `${definition.titlePrefix}: ${titleFromPrompt(stripRequestPrefix(prompt), 6)}`,
      prompt,
      total_duration_sec: input.durationSec,
      style: { prompt_prefix: definition.promptPrefix, seed: 42, aspect_ratio: "16:9", resolution: "1920x1080" },
      scenes,
      voiceover_full: scenes.map((scene) => scene.narration).join(" "),
      narration_warnings: [],
    },
  };
}
