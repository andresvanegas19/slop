import { promises as fs } from "node:fs";
import path from "node:path";

export type RagSource = { id: string; title: string; path: string; score: number };
export type RagContext = { text: string; sources: RagSource[] };

type EditExample = {
  projectId: string;
  kind: "clip" | "storyboard";
  instruction: string;
  previousPrompt: string;
  enhancedPrompt: string;
  reply?: string;
  at?: string;
};

type Chunk = {
  id: string;
  title: string;
  path: string;
  body: string;
  tags: string[];
  /** 0..1 recency rank for examples (1 = newest); 0 for docs. */
  recency: number;
  tokens: string[];
  termFreq: Map<string, number>;
};

type Index = {
  chunks: Chunk[];
  docFreq: Map<string, number>;
  avgLength: number;
  signature: string;
};

const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
const EXAMPLES_DIR = path.join(process.cwd(), "output", "knowledge");
const EXAMPLES_FILE = path.join(EXAMPLES_DIR, "edits.jsonl");
const MAX_EXAMPLES = 500;
const STAT_INTERVAL_MS = 2000;
const FALLBACK_CHUNK_CHARS = 800;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TAG_BOOST = 0.15;
const RECENCY_BOOST = 0.1;
/** Drop chunks scoring below this fraction of the best match (keeps small-model prompts focused). */
const MIN_RELATIVE_SCORE = 0.2;
const HEADER = "Guidance (from the studio knowledge base):";

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can could do does did for from had has have he her his how i if in into is it its " +
    "just me my no not of on or our she so some such than that the their them then there these they this those to too " +
    "us was we were what when where which while who why will with would you your it's i'm don't please make let"
  ).split(" "),
);

// ---------- tokenizer ----------

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ied")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && /(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().replace(/[^a-z0-9#\s-]+/g, " ").split(/[\s-]+/)) {
    const word = raw.replace(/^#+/, "");
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    out.push(stem(word));
  }
  return out;
}

// ---------- corpus loading ----------

async function listMarkdown(directory: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listMarkdown(full)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name.toLowerCase() !== "readme.md") files.push(full);
  }
  return files.sort();
}

function parseFrontMatter(content: string): { tags: string[]; body: string } {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(content);
  if (!match) return { tags: [], body: content };
  const tagLine = /^tags:\s*\[?([^\]\n]*)\]?\s*$/m.exec(match[1]);
  const tags = tagLine
    ? tagLine[1].split(",").map((tag) => tag.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter(Boolean)
    : [];
  return { tags, body: content.slice(match[0].length) };
}

function splitBySize(text: string, size: number): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > size) {
      pieces.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
    while (current.length > size * 1.5) {
      pieces.push(current.slice(0, size));
      current = current.slice(size);
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function makeChunk(fields: Omit<Chunk, "tokens" | "termFreq">): Chunk {
  const tokens = tokenize(`${fields.title} ${fields.title} ${fields.body} ${fields.tags.join(" ")}`);
  const termFreq = new Map<string, number>();
  for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
  return { ...fields, tokens, termFreq };
}

function chunkMarkdown(file: string, content: string): Chunk[] {
  const relative = path.relative(process.cwd(), file);
  const { tags, body } = parseFrontMatter(content.replace(/\r\n/g, "\n"));
  const docTitle = /^#\s+(.+)$/m.exec(body)?.[1].trim() ?? path.basename(file, ".md");
  const sections = body.split(/^(?=##\s)/m);
  const chunks: Chunk[] = [];
  const push = (title: string, text: string) => {
    const clean = text.replace(/^#\s+.+$/m, "").trim();
    if (!clean) return;
    for (const piece of clean.length > FALLBACK_CHUNK_CHARS * 2 ? splitBySize(clean, FALLBACK_CHUNK_CHARS) : [clean]) {
      chunks.push(makeChunk({ id: `${relative}#${chunks.length}`, title, path: relative, body: piece, tags, recency: 0 }));
    }
  };
  for (const section of sections) {
    const heading = /^##\s+(.+)$/m.exec(section);
    if (heading && section.startsWith("##")) {
      push(`${docTitle} — ${heading[1].trim()}`, section.slice(heading[0].length));
    } else {
      push(docTitle, section);
    }
  }
  return chunks;
}

function truncate(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function parseExamples(content: string): Chunk[] {
  const lines = content.split("\n").filter((line) => line.trim());
  const recent = lines.slice(-MAX_EXAMPLES);
  const chunks: Chunk[] = [];
  const relative = path.relative(process.cwd(), EXAMPLES_FILE);
  recent.forEach((line, index) => {
    try {
      const example = JSON.parse(line) as Partial<EditExample>;
      if (!example.instruction || !example.enhancedPrompt) return;
      const instruction = truncate(example.instruction, 200);
      const body =
        `"${instruction}" → "${truncate(example.enhancedPrompt, 400)}"` +
        (example.previousPrompt ? ` (previous prompt: "${truncate(example.previousPrompt, 200)}")` : "");
      chunks.push(
        makeChunk({
          id: `example:${lines.length - recent.length + index}`,
          title: `Example ${example.kind === "clip" ? "clip" : "frame"} edit`,
          path: relative,
          body,
          tags: ["example", example.kind === "clip" ? "clip" : "storyboard"],
          recency: recent.length > 1 ? index / (recent.length - 1) : 1,
        }),
      );
    } catch {
      // skip malformed line
    }
  });
  return chunks;
}

// ---------- index cache ----------

let cached: Index | null = null;
let lastCheck = 0;
let building: Promise<Index> | null = null;

async function computeSignature(): Promise<{ signature: string; files: string[] }> {
  const files = await listMarkdown(KNOWLEDGE_DIR);
  const parts: string[] = [];
  for (const file of [...files, EXAMPLES_FILE]) {
    try {
      const stat = await fs.stat(file);
      parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${file}:missing`);
    }
  }
  return { signature: parts.join("|"), files };
}

async function buildIndex(signature: string, files: string[]): Promise<Index> {
  const chunks: Chunk[] = [];
  for (const file of files) {
    try {
      chunks.push(...chunkMarkdown(file, await fs.readFile(file, "utf8")));
    } catch {
      // unreadable file: skip
    }
  }
  try {
    chunks.push(...parseExamples(await fs.readFile(EXAMPLES_FILE, "utf8")));
  } catch {
    // no examples yet
  }
  const docFreq = new Map<string, number>();
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.tokens.length;
    for (const term of chunk.termFreq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }
  return { chunks, docFreq, avgLength: chunks.length ? totalLength / chunks.length : 1, signature };
}

async function getIndex(): Promise<Index> {
  const now = Date.now();
  if (cached && now - lastCheck < STAT_INTERVAL_MS) return cached;
  if (building) return building;
  building = (async () => {
    try {
      const { signature, files } = await computeSignature();
      lastCheck = Date.now();
      if (!cached || cached.signature !== signature) cached = await buildIndex(signature, files);
      return cached;
    } finally {
      building = null;
    }
  })();
  return building;
}

// ---------- retrieval ----------

function score(index: Index, chunk: Chunk, queryTerms: string[]): number {
  const n = index.chunks.length;
  let total = 0;
  for (const term of queryTerms) {
    const tf = chunk.termFreq.get(term);
    if (!tf) continue;
    const df = index.docFreq.get(term) ?? 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    total += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * chunk.tokens.length) / index.avgLength));
  }
  return total;
}

function formatChunk(position: number, chunk: Chunk, budget: number): string {
  const body = chunk.body.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
  const prefix = `[${position}] ${chunk.title}: `;
  const full = prefix + body;
  if (full.length <= budget) return full;
  if (budget < prefix.length + 40) return "";
  const cut = full.slice(0, budget - 1);
  const sentenceEnd = cut.lastIndexOf(". ");
  return sentenceEnd > prefix.length + 40 ? cut.slice(0, sentenceEnd + 1) : `${cut.trimEnd()}…`;
}

/** Top-k chunks for the query, formatted as a compact "Guidance" block (≤ maxChars) ready to paste into a system prompt. Never throws; returns { text: "", sources: [] } on any failure. */
export async function retrieveContext(
  query: string,
  options?: { k?: number; maxChars?: number; tags?: string[] },
): Promise<RagContext> {
  try {
    const k = Math.max(1, Math.min(20, Math.floor(options?.k ?? 4)));
    const maxChars = Math.max(200, Math.floor(options?.maxChars ?? 2500));
    const wantedTags = new Set((options?.tags ?? []).map((tag) => tag.toLowerCase()));
    const queryTerms = [...new Set(tokenize(typeof query === "string" ? query : ""))];
    if (!queryTerms.length) return { text: "", sources: [] };

    const index = await getIndex();
    const ranked = index.chunks
      .map((chunk) => {
        const base = score(index, chunk, queryTerms);
        if (base <= 0) return { chunk, value: 0 };
        let multiplier = 1;
        if (wantedTags.size && chunk.tags.some((tag) => wantedTags.has(tag))) multiplier += TAG_BOOST;
        if (chunk.recency > 0) multiplier += RECENCY_BOOST * chunk.recency;
        return { chunk, value: base * multiplier };
      })
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value)
      .filter((entry, _, all) => entry.value >= all[0].value * MIN_RELATIVE_SCORE)
      .slice(0, k);
    if (!ranked.length) return { text: "", sources: [] };

    const lines: string[] = [];
    const sources: RagSource[] = [];
    let used = HEADER.length;
    for (const { chunk, value } of ranked) {
      const remaining = maxChars - used - 1;
      if (remaining <= 0) break;
      const line = formatChunk(lines.length + 1, chunk, remaining);
      if (!line) break;
      lines.push(line);
      used += line.length + 1;
      sources.push({ id: chunk.id, title: chunk.title, path: chunk.path, score: Math.round(value * 1000) / 1000 });
    }
    if (!lines.length) return { text: "", sources: [] };
    return { text: `${HEADER}\n${lines.join("\n")}`, sources };
  } catch {
    return { text: "", sources: [] };
  }
}

/** Appends a successful edit as a learning example (never throws). */
export async function recordEditExample(example: {
  projectId: string;
  kind: "clip" | "storyboard";
  instruction: string;
  previousPrompt: string;
  enhancedPrompt: string;
  reply?: string;
  at?: string;
}): Promise<void> {
  try {
    if (!example || typeof example.projectId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(example.projectId)) return;
    if (example.kind !== "clip" && example.kind !== "storyboard") return;
    const instruction = truncate(example.instruction, 500);
    const enhancedPrompt = truncate(example.enhancedPrompt, 2000);
    if (!instruction || !enhancedPrompt) return;
    const at = typeof example.at === "string" && !Number.isNaN(Date.parse(example.at)) ? example.at : new Date().toISOString();
    const record: EditExample = {
      projectId: example.projectId,
      kind: example.kind,
      instruction,
      previousPrompt: truncate(example.previousPrompt, 2000),
      enhancedPrompt,
      ...(example.reply ? { reply: truncate(example.reply, 1000) } : {}),
      at: truncate(at, 40),
    };
    await fs.mkdir(EXAMPLES_DIR, { recursive: true });
    await fs.appendFile(EXAMPLES_FILE, `${JSON.stringify(record)}\n`, "utf8");
    lastCheck = 0; // force a stat check on next retrieval
  } catch {
    // never throw
  }
}
