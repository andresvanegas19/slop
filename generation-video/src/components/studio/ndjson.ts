/* NDJSON parsing helpers (no imports, so they can be unit-tested in plain Node). */

export type StreamEvent =
  | { type: "stage"; stage: string; label?: string; at?: number }
  | { type: "intent"; action: string; detectedBy?: string; atEnd?: boolean; window?: unknown }
  | { type: "token"; field: "enhancedPrompt" | "reply"; text: string }
  | { type: "prompt"; enhancedPrompt: string }
  | { type: "preview"; imageUrl: string; label?: string }
  | { type: "progress"; stage?: string; status?: string; progress?: number; elapsedMs?: number }
  | { type: "done"; [key: string]: unknown }
  | { type: "error"; status?: number; error?: string };

export const NDJSON_TYPE = "application/x-ndjson";

/** Accumulates text chunks and returns the complete lines seen so far (a line may span several chunks). */
export function createLineSplitter() {
  let buffer = "";
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      return parts.map((line) => line.trim()).filter(Boolean);
    },
    /** Whatever is left after the stream ends (a final line without a trailing newline). */
    flush(): string[] {
      const rest = buffer.trim();
      buffer = "";
      return rest ? [rest] : [];
    },
  };
}

export function parseStreamLine(line: string): StreamEvent | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string" ? value as StreamEvent : null;
  } catch {
    console.error("[stream] ignoring a malformed progress line", line.slice(0, 200));
    return null;
  }
}

