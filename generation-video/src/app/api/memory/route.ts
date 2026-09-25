import { NextResponse } from "next/server";
import { retrieveMemory, type MemoryKind } from "@/lib/memory";
import { parseUserId } from "@/lib/user-context";

export const dynamic = "force-dynamic";

const KINDS: MemoryKind[] = ["knowledge", "video", "user_prompt", "research", "example"];

/**
 * Debug: GET `?q=&userId=&projectId=&researchSessionId=&k=&maxChars=&tags=a,b&kinds=knowledge,video` → `{ text, sources }`,
 * exactly what the LLM calls receive. `userId` falls back to the X-Longform-User header.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  if (!query) return NextResponse.json({ error: "Missing q parameter." }, { status: 400 });
  const number = (name: string) => {
    const value = Number(url.searchParams.get(name));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const list = (name: string) => url.searchParams.get(name)?.split(",").map((item) => item.trim()).filter(Boolean);
  const userId = parseUserId(url.searchParams.get("userId") ?? request.headers.get("x-longform-user"));
  const kinds = list("kinds")?.filter((kind): kind is MemoryKind => KINDS.includes(kind as MemoryKind));
  const memory = await retrieveMemory(query, {
    userId,
    projectId: url.searchParams.get("projectId") ?? undefined,
    researchSessionId: url.searchParams.get("researchSessionId") ?? undefined,
    k: number("k"),
    maxChars: number("maxChars"),
    tags: list("tags"),
    ...(kinds?.length ? { kinds } : {}),
  });
  return NextResponse.json({ userId, ...memory }, { headers: { "Cache-Control": "no-store" } });
}
