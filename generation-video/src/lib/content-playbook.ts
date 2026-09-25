/**
 * Content playbook shared by the script and shot writers: audience-first attention engineering (a hook in the first
 * 0.6–2 s stacked across picture, sound and words), "value shift" scene design, one production design, and the 5-7-10
 * matrix (sub-niche × psychological angle × visual format) with the 3-phase funnel (growth → connection → sale).
 * The rules are compact on purpose (small OpenRouter models); the long-form notes live in
 * knowledge/content-strategy.md and are retrieved by rag.ts. Pure functions, no I/O.
 */

export type ContentAngleId = "myth" | "versus" | "quick_hack" | "mistake" | "transformation" | "behind_the_scenes" | "contrarian";
export type ContentAngle = { id: ContentAngleId; label: string; instruction: string };
export type FunnelStage = "growth" | "connection" | "sale";
export type ContentPlan = { angle: ContentAngle; format: string; stage: FunnelStage };

/** The seven psychological angles of the 5-7-10 matrix. */
export const CONTENT_ANGLES: readonly ContentAngle[] = [
  { id: "myth", label: "The Myth", instruction: "open on a belief this audience holds, then show the moment that proves it wrong" },
  { id: "versus", label: "The Versus", instruction: "put the old way and the new way side by side and let the contrast decide; never name or show another company" },
  { id: "quick_hack", label: "The Quick Hack", instruction: "promise a fast, specific win and deliver it in one clear visible step" },
  { id: "mistake", label: "The Common Mistake", instruction: "show the mistake this audience is making right now, then the small fix" },
  { id: "transformation", label: "The Transformation", instruction: "start in the 'before' this audience recognises and land on the 'after' they want" },
  { id: "behind_the_scenes", label: "Behind the Scenes", instruction: "reveal the real process, the people and a small honest setback behind the result" },
  { id: "contrarian", label: "The Contrarian Truth", instruction: "state the unpopular belief the brand stands for and prove it with one real moment" },
];

/** The ten visual formats of the 5-7-10 matrix; all of them fit the house style (real phone footage, no text). */
export const VISUAL_FORMATS: readonly string[] = [
  "first-person POV with the viewer's own hands in frame",
  "day-in-the-life follow of one person",
  "hands-only process close-ups with satisfying detail",
  "before and after in the same framing",
  "a candid reaction: a face seeing the result for the first time",
  "walk-and-talk follow shot through a real place",
  "observational mini-documentary, the subject absorbed in the moment",
  "slow-motion detail of the key moment",
  "an unexpected angle: overhead, low to the ground or through an object",
  "the same routine shown twice with one thing changed",
];

export const FUNNEL_STAGES: Record<FunnelStage, { label: string; instruction: string }> = {
  growth: { label: "Growth", instruction: "attract new viewers with high value or entertainment; the brand stays in the background" },
  connection: { label: "Connection", instruction: "build trust with vulnerability and the story of the process: real people, effort and a small setback" },
  sale: { label: "Sale", instruction: "answer the viewer's main objection with proof, then give one clear call to action" },
};

const ANGLE_SIGNALS: [ContentAngleId, RegExp][] = [
  ["myth", /\b(?:myths?|mitos?|misconceptions?|truth about|verdad sobre)\b/i],
  ["versus", /\b(?:vs\.?|versus|compared?|comparison|comparaci[oó]n|frente a)\b/i],
  ["quick_hack", /\b(?:hacks?|tricks?|trucos?|tips?|consejos?|shortcuts?|atajos?)\b/i],
  ["mistake", /\b(?:mistakes?|errors?|errores?|stop doing|deja de)\b/i],
  ["transformation", /\b(?:before and after|antes y despu[eé]s|transform\w*|makeover|glow[- ]?up)\b/i],
  ["behind_the_scenes", /\b(?:behind the scenes|detr[aá]s de (?:c[aá]maras|escena)|how (?:it'?s|we) made|making of|proceso)\b/i],
  ["contrarian", /\b(?:unpopular|contrarian|nobody tells|nadie te dice|secrets?|secretos?|pol[eé]mic\w*)\b/i],
];

const STAGE_SIGNALS: [FunnelStage, RegExp][] = [
  ["sale", /\b(?:buy|order|sign[- ]?up|discount|offer|launch\w*|sale|promo\w*|pricing|compra\w*|oferta|descuento|lanzamiento|precio)\b/i],
  ["connection", /\b(?:founders?|our story|team|culture|behind|journey|mission|fundador\w*|historia|equipo|cultura|misi[oó]n)\b/i],
  ["growth", /\b(?:viral|reach|awareness|followers|educat\w*|entertain\w*|trend\w*|alcance|seguidores|tendencia\w*)\b/i],
];

export function detectAngle(brief: string): ContentAngle | undefined {
  const match = ANGLE_SIGNALS.find(([, pattern]) => pattern.test(brief));
  return match ? CONTENT_ANGLES.find((angle) => angle.id === match[0]) : undefined;
}

export function detectFunnelStage(brief: string): FunnelStage | undefined {
  return STAGE_SIGNALS.find(([, pattern]) => pattern.test(brief))?.[0];
}

/**
 * One cell of the 5-7-10 matrix for this brief: the angle and funnel stage the brief asks for, otherwise a random angle
 * (novelty across videos) and `defaultStage`; the visual format rotates at random. The sub-niche is left to the LLM.
 */
export function planContent(brief: string, options: { defaultStage?: FunnelStage; random?: () => number } = {}): ContentPlan {
  const random = options.random ?? Math.random;
  const pick = <T>(items: readonly T[]) => items[Math.min(items.length - 1, Math.floor(random() * items.length))];
  return {
    angle: detectAngle(brief) ?? pick(CONTENT_ANGLES),
    format: pick(VISUAL_FORMATS),
    stage: detectFunnelStage(brief) ?? options.defaultStage ?? "growth",
  };
}

/** Rules for script writers (headline + narration + visual per scene), plus the chosen matrix cell. */
export function scriptPlaybook(plan: ContentPlan) {
  const stage = FUNNEL_STAGES[plan.stage];
  return [
    "=== Content playbook (apply silently; never write these labels or technique names in the script) ===",
    "Audience first: every scene answers what this audience needs, is searching for, or is curious about; the brand is only the bridge to that answer. Never open on the brand talking about itself.",
    "Speak to one specific sub-niche implied by the brief, not the whole market.",
    "Hook in the first 0.6 to 2 seconds with a multihook: a visual jolt (sudden motion, an extreme close-up or a strong contrast), the sound of the moment and a spoken line that opens a curiosity loop the video closes at the end.",
    "Every scene turns a value through a small conflict (doubt to confidence, chaos to calm, belief to truth). A scene that only explains must be rewritten until something changes.",
    "One production design in every scene: the same wardrobe, props, palette and light, so the video reads as one piece.",
    `Angle: ${plan.angle.label}, ${plan.angle.instruction}. The angle never justifies invented facts.`,
    `Visual format: ${plan.format}, unless the brief asks for another format.`,
    `Funnel stage: ${stage.label}, ${stage.instruction}.`,
    "=== End playbook ===",
  ].join("\n");
}

/** Attention and scene-design rules for shot writers (keyframe + motion + sound); continuity is handled elsewhere. */
export function shotPlaybook() {
  return [
    "=== Attention and scene design (apply silently) ===",
    "The first 0.6 to 2 seconds must stop the scroll: open mid-action on a visual jolt (sudden motion, an extreme close detail, or a strong light or color contrast) that raises a question the video answers.",
    "Hook with picture and sound at once: the keyframe, the motion and the sound all land the opening moment together.",
    "Every shot turns one value through a small conflict (doubt to confidence, mess to order, alone to together); a shot that only illustrates is rewritten as a moment of change.",
    "=== End ===",
  ].join("\n");
}
