/**
 * Research storylines: the agent's `write_storyline` tool (agent/storyline.py) turns a research session — what the user
 * asked, the company's grounded findings and how it stands apart from its competitors — into one beat per scene of a
 * video template (a preset). The user reviews/edits it, then generate-preset renders it.
 *
 * Competitors only inform the differentiation: `avoid_terms` lists their names and domains, and no approved storyline
 * or generated scene may mention them (checked here and in the agent).
 */

export const MAX_BEATS = 8;

export type StorylineBeat = {
  index: number;
  role: string;
  goal?: string;
  message: string;
  visual: string;
  finding_ids?: string[];
};

export type Storyline = {
  storyline_id: string;
  session_id: string;
  template: string;
  duration_sec: number;
  title: string;
  logline: string;
  tone: string;
  audience: string;
  call_to_action: string;
  beats: StorylineBeat[];
  avoid_terms: string[];
  reason: string;
  source: "llm" | "partial" | "fallback" | "user";
  version: number;
  model?: string;
};

export type StorylineTemplate = { id: string; label: string; description: string; roles: { type: string; goal: string }[] };

const squash = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/** Terms that appear in `text` as whole words (case-insensitive; "-", "." and spaces are interchangeable). */
export function mentionsAny(text: string, terms: readonly string[]): string[] {
  const squashed = squash(text);
  const joined = squashed.replace(/ /g, "");
  return terms.filter((term) => {
    const t = squash(term).trim();
    return Boolean(t) && (squashed.includes(` ${t} `) || (t.includes(" ") && joined.includes(t.replace(/ /g, ""))));
  });
}

const isText = (value: unknown, min: number, max: number): value is string => typeof value === "string" && value.trim().length >= min && value.length <= max;

/**
 * Shape + safety check of a storyline sent back by the browser (it may have been edited). Returns the cleaned storyline
 * or a readable error. Beat count and template are checked against the preset by the caller.
 */
export function parseStoryline(value: unknown): { storyline: Storyline } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: '"storyline" must be an object from POST /api/research/{id}/storyline.' };
  const raw = value as Record<string, unknown>;
  if (!isText(raw.template, 1, 40)) return { error: '"storyline.template" is required.' };
  if (!isText(raw.title, 1, 120)) return { error: '"storyline.title" must be 1-120 characters.' };
  if (!isText(raw.logline, 1, 400)) return { error: '"storyline.logline" must be 1-400 characters.' };
  if (raw.call_to_action !== undefined && !isText(raw.call_to_action, 0, 120)) return { error: '"storyline.call_to_action" must be at most 120 characters.' };
  if (!Array.isArray(raw.beats) || raw.beats.length < 1 || raw.beats.length > MAX_BEATS) return { error: `"storyline.beats" must list 1-${MAX_BEATS} scenes.` };
  const avoid = Array.isArray(raw.avoid_terms) ? raw.avoid_terms.filter((term): term is string => typeof term === "string" && term.trim().length > 0 && term.length <= 120).slice(0, 60) : [];
  const beats: StorylineBeat[] = [];
  for (const [index, beat] of raw.beats.entries()) {
    const b = (beat && typeof beat === "object" ? beat : {}) as Record<string, unknown>;
    if (!isText(b.message, 3, 300)) return { error: `Scene ${index + 1}: "message" must be 3-300 characters.` };
    if (!isText(b.visual, 3, 300)) return { error: `Scene ${index + 1}: "visual" must be 3-300 characters.` };
    beats.push({
      index,
      role: typeof b.role === "string" ? b.role.slice(0, 40) : "",
      goal: typeof b.goal === "string" ? b.goal.slice(0, 400) : undefined,
      message: b.message.trim(),
      visual: b.visual.trim(),
      finding_ids: Array.isArray(b.finding_ids) ? b.finding_ids.filter((id): id is string => typeof id === "string").slice(0, 6) : [],
    });
  }
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const storyline: Storyline = {
    storyline_id: str(raw.storyline_id, 64),
    session_id: str(raw.session_id, 64),
    template: raw.template.trim(),
    duration_sec: typeof raw.duration_sec === "number" ? raw.duration_sec : 0,
    title: raw.title.trim(),
    logline: raw.logline.trim(),
    tone: str(raw.tone, 120),
    audience: str(raw.audience, 200),
    call_to_action: str(raw.call_to_action, 120),
    beats,
    avoid_terms: avoid,
    reason: str(raw.reason, 300),
    source: raw.source === "llm" || raw.source === "partial" || raw.source === "fallback" ? raw.source : "user",
    version: typeof raw.version === "number" ? raw.version : 1,
  };
  const texts: [string, string][] = [["title", storyline.title], ["logline", storyline.logline], ["call to action", storyline.call_to_action],
    ...beats.map((b): [string, string] => [`scene ${b.index + 1}`, `${b.message} ${b.visual}`])];
  for (const [label, text] of texts) {
    const named = mentionsAny(text, avoid);
    if (named.length) return { error: `The storyline's ${label} names a competitor (${named[0]}); the ad never names competitors.` };
  }
  return { storyline };
}

/** Brief for the script writer: follow the approved storyline scene by scene. */
export function storylineBrief(storyline: Storyline) {
  return [
    "Approved storyline (the user reviewed it): follow it scene by scene, keep each scene's meaning, and never name or show other companies.",
    `Title: ${storyline.title}`,
    `Logline: ${storyline.logline}`,
    ...(storyline.tone || storyline.audience ? [`Tone: ${storyline.tone || "brand voice"}; audience: ${storyline.audience || "the brand's customers"}`] : []),
    ...storyline.beats.map((beat) => `Scene ${beat.index + 1}${beat.role ? ` (${beat.role})` : ""}: says "${beat.message}"; shows: ${beat.visual}`),
    ...(storyline.call_to_action ? [`Call to action: ${storyline.call_to_action}`] : []),
  ].join("\n");
}

/** Scene text straight from a beat, used when the writer's line is missing or unusable. */
export function storylineSceneText(storyline: Storyline, index: number) {
  const beat = storyline.beats[index];
  const isCta = beat.role === "cta" || index === storyline.beats.length - 1;
  const headline = isCta && storyline.call_to_action ? storyline.call_to_action : beat.message.replace(/[.!?]+$/, "");
  return { headline, narration: beat.message, visual: beat.visual };
}
