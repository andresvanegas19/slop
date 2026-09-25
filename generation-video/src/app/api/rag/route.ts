import { NextResponse } from "next/server";
import { retrieveContext } from "@/lib/rag";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  if (!query) return NextResponse.json({ error: "Missing q parameter." }, { status: 400 });
  const kParam = Number(url.searchParams.get("k"));
  const maxParam = Number(url.searchParams.get("maxChars"));
  const tags = url.searchParams.get("tags")?.split(",").map((tag) => tag.trim()).filter(Boolean);
  const context = await retrieveContext(query, {
    k: Number.isFinite(kParam) && kParam > 0 ? kParam : undefined,
    maxChars: Number.isFinite(maxParam) && maxParam > 0 ? maxParam : undefined,
    tags,
  });
  return NextResponse.json(context);
}
