import type { QueryResponse } from "@rawtree/sdk";
import { getClient } from "@/lib/rawtree";

/** Every generated slop video is exactly this long. */
export const SHORT_DURATION_SEC = 5;
const TOTAL_MS = SHORT_DURATION_SEC * 1000;
const TITLE_MS = 1000;
const MAX_COMPETITOR_SCENES = 2;
const WORDS_PER_SECOND = 2.5;
const ROW_LIMIT = 200;
const DEFAULT_TABLE = "slop_human";

/** Test runs written while wiring up the scraper; excluded unless `includeTestRows` is set. */
export const IGNORED_RUN_ID_PREFIXES = ["run_20260925T1946", "run_20260925T1948"] as const;

/** House style: real, candid moments that feel filmed on a phone (see knowledge/storyboard-style.md). */
const STYLE_PREFIX = "Handheld smartphone footage, slight natural sway, available natural light, phone-lens shallow depth of field, true-to-life color with gentle warmth, candid real people, no text, letters or logos in frame.";
const STYLE = {
  prompt_prefix: STYLE_PREFIX,
  palette: ["#2B2521", "#C98B4F", "#E9DCC9", "#F8F4EE"],
  seed: 42,
  aspect_ratio: "16:9",
  resolution: "1920x1080",
} as const;

export class SlopConfigurationError extends Error {}
export class SlopNoDataError extends Error {
  constructor(message: string, readonly ignoredTestRows: number) {
    super(message);
  }
}

export type SlopPlan = { name: string; price: number | null; label: string };

type Observation = {
  obsId: string;
  runId: string;
  entityId: string;
  entityName: string;
  fetchedAt: string;
  status: string;
  url: string;
  pricingHash: string | null;
  plans: SlopPlan[];
  plansSource: "structured" | "markdown" | "none";
};

export type SlopEntitySummary = {
  entityId: string;
  entityName: string;
  observations: number;
  latestObsId: string;
  latestFetchedAt: string;
  status: string;
  url: string;
  pricingChanged: boolean;
  plans: SlopPlan[];
  plansSource: Observation["plansSource"];
};

export type SlopStoryboardScene = {
  scene: number;
  start_sec: number;
  duration_sec: number;
  type: "title" | "change" | "snapshot";
  narration: string;
  on_screen_text: { headline: string; sub?: string; competitor?: string; rank?: number };
  image_prompt: string;
  motion: "slow push in" | "slow zoom out" | "static";
  transition_out: string;
  change_ids: string[];
};

export type SlopStoryboard = {
  storyboard_id: string;
  source_cycle_id: string;
  source_table: string;
  title: string;
  total_duration_sec: number;
  style: typeof STYLE;
  scenes: SlopStoryboardScene[];
  voiceover_full: string;
  evidence_index: Record<string, string[]>;
  narration_warnings: never[];
  entities: SlopEntitySummary[];
  included_test_rows: boolean;
};

export function slopTable() {
  // getClient() loads ../.env, so read the override after touching it.
  const configured = process.env.RAWTREE_SLOP_TABLE?.trim();
  const table = configured || DEFAULT_TABLE;
  // Locked to slop_* tables: the RawTree database is shared with other teams.
  if (!/^slop_[A-Za-z0-9_]{1,60}$/.test(table)) {
    throw new SlopConfigurationError(`RAWTREE_SLOP_TABLE must look like "slop_<name>" (got "${table}").`);
  }
  return table;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

function testRowFilter() {
  return IGNORED_RUN_ID_PREFIXES.map((prefix) => `run_id NOT LIKE '${prefix}%'`).join(" AND ");
}

async function countTestRows(table: string) {
  const where = IGNORED_RUN_ID_PREFIXES.map((prefix) => `run_id LIKE '${prefix}%'`).join(" OR ");
  const result = await getClient().query<{ n: unknown }>({ sql: `SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}` });
  return Number(result.data[0]?.n ?? 0) || 0;
}

// ---------- plan parsing ----------

const PLAN_NAME_NOISE = /(recommended|most popular|popular|best value|new|beta)$/i;

function cleanPlanName(raw: string) {
  let name = raw.replace(/\\\*/g, "").replace(/[*_`]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
  for (let i = 0; i < 2; i += 1) name = name.replace(PLAN_NAME_NOISE, "").trim();
  return name;
}

function parsePriceLine(line: string): { price: number | null; label: string } | undefined {
  const clean = line.replace(/\\\*/g, "").trim();
  const money = clean.match(/^\$\s?(\d+(?:[.,]\d+)?)/);
  if (money) {
    const price = Number(money[1].replace(",", "."));
    const perMonth = /month|\/mo\b/i.test(clean);
    return { price, label: price === 0 ? "Free" : `$${money[1]}${perMonth ? "/mo" : ""}` };
  }
  if (/^(custom|contact)/i.test(clean)) return { price: null, label: "Custom pricing" };
  if (/^free\b/i.test(clean) && clean.split(/\s+/).length <= 4) return { price: 0, label: "Free" };
  return undefined;
}

export function parsePlansFromMarkdown(markdown: string): SlopPlan[] {
  const lines = markdown.split("\n");
  const plans: SlopPlan[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^#{2,4}\s+(.+?)\s*$/);
    if (!heading) continue;
    const name = cleanPlanName(heading[1]);
    // Plan names are short ("Plus", "Business"); FAQ headings like "What are automation limits?" are not.
    if (!name || name.endsWith("?") || name.split(/\s+/).length > 4 || seen.has(name.toLowerCase())) continue;
    // The price is the first non-empty line after the heading, within a few lines.
    for (let next = index + 1, checked = 0; next < lines.length && checked < 2; next += 1) {
      if (!lines[next].trim()) continue;
      checked += 1;
      if (/^#{1,6}\s/.test(lines[next])) break;
      const price = parsePriceLine(lines[next]);
      if (price) {
        plans.push({ name, ...price });
        seen.add(name.toLowerCase());
        break;
      }
    }
  }
  return plans;
}

function planFromStructured(value: unknown): SlopPlan | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const rawName = record.name ?? record.plan ?? record.tier ?? record.title;
  if (typeof rawName !== "string" || !rawName.trim()) return undefined;
  const name = cleanPlanName(rawName);
  const rawPrice = record.price ?? record.amount ?? record.monthly_price ?? record.price_monthly ?? record.price_usd;
  if (typeof rawPrice === "number" && Number.isFinite(rawPrice)) {
    return { name, price: rawPrice, label: rawPrice === 0 ? "Free" : `$${rawPrice}/mo` };
  }
  if (typeof rawPrice === "string") {
    const parsed = parsePriceLine(rawPrice.trim().startsWith("$") || /^(custom|contact|free)/i.test(rawPrice.trim())
      ? rawPrice
      : `$${rawPrice}`);
    if (parsed) return { name, ...parsed };
  }
  if (rawPrice === null || rawPrice === undefined) return { name, price: null, label: "Custom pricing" };
  return undefined;
}

/** Accepts `[...plans]`, `{ plans: [...] }`, `{ pricing: { plans | tiers: [...] } }`, or a JSON string of those. */
export function parsePlansFromStructured(value: unknown): SlopPlan[] {
  let data = value;
  if (typeof data === "string") {
    if (!data.trim()) return [];
    try {
      data = JSON.parse(data);
    } catch {
      return [];
    }
  }
  const candidates: unknown[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 3 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      candidates.push(node);
      return;
    }
    for (const key of ["plans", "tiers", "pricing", "prices"]) {
      if (key in node) visit((node as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(data, 0);
  for (const candidate of candidates) {
    const plans = (candidate as unknown[]).map(planFromStructured).filter((plan): plan is SlopPlan => Boolean(plan));
    if (plans.length > 0) return plans;
  }
  return [];
}

function toObservation(row: Record<string, unknown>): Observation | undefined {
  const obsId = text(row.obs_id);
  const entityId = text(row.entity_id);
  if (!obsId || !entityId) return undefined;
  const structured = parsePlansFromStructured(row.structured);
  const markdownPlans = structured.length > 0 ? [] : parsePlansFromMarkdown(text(row.markdown));
  const hash = text(row["section_hashes.pricing"]);
  return {
    obsId,
    runId: text(row.run_id),
    entityId,
    entityName: text(row.entity_name) || entityId,
    fetchedAt: text(row.fetched_at),
    status: text(row.status),
    url: text(row.url),
    pricingHash: hash || null,
    plans: structured.length > 0 ? structured : markdownPlans,
    plansSource: structured.length > 0 ? "structured" : markdownPlans.length > 0 ? "markdown" : "none",
  };
}

// ---------- storyboard ----------

const SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function spoken(value: number) {
  if (!Number.isInteger(value) || value < 0 || value >= 100) return String(value);
  if (value < 20) return SMALL_NUMBERS[value];
  return `${TENS[Math.floor(value / 10)]}${value % 10 ? `-${SMALL_NUMBERS[value % 10]}` : ""}`;
}

function spokenPrice(plan: SlopPlan) {
  if (plan.price === null) return "custom pricing";
  if (plan.price === 0) return "free";
  return Number.isInteger(plan.price) ? `${spoken(plan.price)} dollars` : `${plan.price} dollars`;
}

/** Keeps narration speakable within the scene (~2.5 words/second). */
function fitNarration(sentence: string, durationMs: number) {
  const maxWords = Math.max(2, Math.floor((durationMs / 1000) * WORDS_PER_SECOND));
  const words = sentence.trim().split(/\s+/);
  if (words.length <= maxWords) return sentence.trim();
  return `${words.slice(0, maxWords).join(" ").replace(/[,:;]$/, "")}.`;
}

/** The headline plan: the most expensive plan with a published price. */
function flagshipPlan(plans: SlopPlan[]) {
  const priced = plans.filter((plan) => plan.price !== null && plan.price > 0);
  return priced.sort((a, b) => (b.price ?? 0) - (a.price ?? 0))[0] ?? plans[0];
}

function describePriceChange(previous: SlopPlan[], latest: SlopPlan[]) {
  for (const plan of latest) {
    const before = previous.find((candidate) => candidate.name.toLowerCase() === plan.name.toLowerCase());
    if (before && before.price !== plan.price) return { plan, before };
  }
  return undefined;
}

function durations(count: number) {
  const remaining = TOTAL_MS - TITLE_MS;
  const base = Math.floor(remaining / count);
  return Array.from({ length: count }, (_, index) => (index === count - 1 ? remaining - base * (count - 1) : base));
}

export async function fetchSlopObservations(options: { includeTestRows?: boolean } = {}) {
  const client = getClient();
  const table = slopTable();
  const where = options.includeTestRows ? "" : ` WHERE ${testRowFilter()}`;
  // SELECT * so the optional `structured` column is read when the scraper starts filling it.
  const sql = `SELECT * FROM "${table}"${where} ORDER BY fetched_at DESC LIMIT ${ROW_LIMIT}`;
  const result: QueryResponse<Record<string, unknown>> = await client.query({ sql });
  const observations = result.data
    .map(toObservation)
    .filter((observation): observation is Observation => Boolean(observation))
    .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  if (observations.length === 0) {
    const ignored = options.includeTestRows ? 0 : await countTestRows(table);
    throw new SlopNoDataError(
      `No competitor observations in ${table} yet${ignored > 0 ? ` (${ignored} test rows ignored)` : ""}. Waiting for the scraper to write real runs.`,
      ignored,
    );
  }
  return { table, observations };
}

function summarize(observations: Observation[]): SlopEntitySummary[] {
  const groups = new Map<string, Observation[]>();
  for (const observation of observations) {
    groups.set(observation.entityId, [...(groups.get(observation.entityId) ?? []), observation]);
  }
  return [...groups.values()].map((group) => {
    const successful = group.filter((observation) => observation.status === "ok" || observation.plans.length > 0);
    const latest = successful.at(-1) ?? group.at(-1)!;
    const hashes = new Set(group.map((observation) => observation.pricingHash).filter(Boolean));
    return {
      entityId: latest.entityId,
      entityName: latest.entityName,
      observations: group.length,
      latestObsId: latest.obsId,
      latestFetchedAt: latest.fetchedAt,
      status: latest.status,
      url: latest.url,
      pricingChanged: hashes.size > 1,
      plans: latest.plans,
      plansSource: latest.plansSource,
    };
  });
}

export function buildSlopStoryboard(table: string, observations: Observation[], includeTestRows = false): SlopStoryboard {
  const entities = summarize(observations);
  const byEntity = (entityId: string) => observations.filter((observation) => observation.entityId === entityId);
  const ranked = [...entities].sort((a, b) =>
    Number(b.pricingChanged) - Number(a.pricingChanged)
    || Number(b.plans.length > 0) - Number(a.plans.length > 0)
    || b.latestFetchedAt.localeCompare(a.latestFetchedAt));
  const featured = ranked.slice(0, MAX_COMPETITOR_SCENES);
  const changedCount = entities.filter((entity) => entity.pricingChanged).length;
  const sceneDurations = durations(featured.length);
  const evidenceIndex: Record<string, string[]> = {};
  const latestFetch = observations.at(-1)?.fetchedAt ?? "";
  const cycle = latestFetch.replace(/[^0-9]/g, "").slice(0, 12) || "unknown";

  const titleHeadline = `Pricing watch: ${entities.length} competitor${entities.length === 1 ? "" : "s"}`;
  const scenes: SlopStoryboardScene[] = [{
    scene: 1,
    start_sec: 0,
    duration_sec: TITLE_MS / 1000,
    type: "title",
    narration: fitNarration("Pricing watch.", TITLE_MS),
    on_screen_text: {
      headline: titleHeadline,
      sub: `${changedCount} pricing change${changedCount === 1 ? "" : "s"} · ${observations.length} scrapes`,
    },
    image_prompt: `${STYLE_PREFIX} ${changedCount > 0
      ? "a product manager in a grey hoodie stands by her kitchen window at dawn, coffee in one hand, reading pricing news on her phone, her eyebrows rising, soft blue morning light on her face"
      : "a product manager in a grey hoodie leans on her kitchen counter at dawn, scrolling her phone calmly, steam rising from her coffee, soft blue morning light through the window"}`,
    motion: "slow zoom out",
    transition_out: "crossfade_0.3s",
    change_ids: [],
  }];

  let startMs = TITLE_MS;
  featured.forEach((entity, index) => {
    const durationMs = sceneDurations[index];
    const group = byEntity(entity.entityId);
    const flagship = entity.plans.length > 0 ? flagshipPlan(entity.plans) : undefined;
    const changeId = `chg_${String(index + 1).padStart(3, "0")}`;
    const previousWithPlans = [...group].reverse().find((observation) =>
      observation.obsId !== entity.latestObsId && observation.pricingHash !== null && observation.plans.length > 0);
    const priceChange = entity.pricingChanged && previousWithPlans
      ? describePriceChange(previousWithPlans.plans, entity.plans)
      : undefined;
    evidenceIndex[changeId] = entity.pricingChanged
      ? [...new Set(group.filter((observation) => observation.pricingHash !== null).map((observation) => observation.obsId))]
      : [entity.latestObsId];

    let headline: string;
    let narration: string;
    let visual: string;
    if (priceChange) {
      const cheaper = (priceChange.plan.price ?? 0) < (priceChange.before.price ?? 0);
      headline = `${entity.entityName} ${priceChange.plan.name}: ${priceChange.before.label} → ${priceChange.plan.label}`;
      narration = `${entity.entityName} ${priceChange.plan.name} now ${spokenPrice(priceChange.plan)}.`;
      visual = cheaper
        ? "a small product team huddles around a laptop in a sunlit office, one of them points at the screen and the others lean in, surprised and half-laughing"
        : "two colleagues at a standing desk exchange a knowing look over a laptop, one exhales and smiles, late-afternoon window light";
    } else if (entity.pricingChanged) {
      headline = flagship
        ? `${entity.entityName} ${flagship.name}: ${flagship.label}`
        : `${entity.entityName} updated its pricing page`;
      narration = `${entity.entityName} changed its pricing page.`;
      visual = "a designer at a café table turns her laptop toward a teammate, both leaning in to compare something, warm window light and a quick shared glance";
    } else if (flagship) {
      headline = `${entity.entityName} ${flagship.name}: ${flagship.label}`;
      narration = `${entity.entityName} ${flagship.name}: ${spokenPrice(flagship)}.`;
      visual = "a founder walks down a quiet hallway reading her phone, then slows and nods to herself, soft overhead office light and evening glow from the windows";
    } else {
      headline = `${entity.entityName}: pricing not captured`;
      narration = `${entity.entityName}: no pricing captured.`;
      visual = "a teammate refreshes a page on a laptop in a dim room at night, shrugs and rubs his eyes, the screen glow on his face and a desk lamp beside him";
    }
    const sub = entity.plans.length > 0
      ? entity.plans.slice(0, 4).map((plan) => (plan.label.toLowerCase() === plan.name.toLowerCase() ? plan.name : `${plan.name} ${plan.label}`)).join(" · ")
      : entity.pricingChanged ? "Pricing section hash changed" : undefined;

    scenes.push({
      scene: index + 2,
      start_sec: startMs / 1000,
      duration_sec: durationMs / 1000,
      type: entity.pricingChanged ? "change" : "snapshot",
      narration: fitNarration(narration, durationMs),
      on_screen_text: { headline, ...(sub ? { sub } : {}), competitor: entity.entityName, rank: index + 1 },
      image_prompt: `${STYLE_PREFIX} ${visual}`,
      motion: "slow push in",
      transition_out: index === featured.length - 1 ? "cut" : "crossfade_0.3s",
      change_ids: [changeId],
    });
    startMs += durationMs;
  });

  return {
    storyboard_id: `sb_slop_${cycle}`,
    source_cycle_id: observations.at(-1)?.runId || `cyc_${cycle}`,
    source_table: table,
    title: titleHeadline,
    total_duration_sec: SHORT_DURATION_SEC,
    style: STYLE,
    scenes,
    voiceover_full: scenes.map((scene) => scene.narration).join(" "),
    evidence_index: evidenceIndex,
    narration_warnings: [],
    entities,
    included_test_rows: includeTestRows,
  };
}

export async function buildSlopStoryboardFromRawTree(options: { includeTestRows?: boolean } = {}) {
  const { table, observations } = await fetchSlopObservations(options);
  return buildSlopStoryboard(table, observations, Boolean(options.includeTestRows));
}
