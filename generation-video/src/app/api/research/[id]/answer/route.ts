import { NextResponse } from "next/server";
import { badSessionId, jsonBody, proxyJson } from "@/lib/research-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST `{ question_id: string, answer: string }` → `{ session_id, question_id, answered: true, video_brief }`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invalid = badSessionId(id);
  if (invalid) return invalid;
  const body = await jsonBody(request);
  if (body instanceof NextResponse) return body;
  if (typeof body.question_id !== "string" || !body.question_id) {
    return NextResponse.json({ error: '"question_id" is required (from the session\'s questions[].id).' }, { status: 400 });
  }
  if (typeof body.answer !== "string" || !body.answer.trim() || body.answer.length > 2_000) {
    return NextResponse.json({ error: '"answer" must be 1 to 2,000 characters.' }, { status: 400 });
  }
  return proxyJson("research_answer", `/research/${id}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question_id: body.question_id, answer: body.answer.trim() }),
  });
}
