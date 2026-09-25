import { badSessionId, proxyJson } from "@/lib/research-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET → `{ session_id, status, looping, running, company, domain, profile, questions: [{ id, topic, question, options,
 * answered, answer }], answers, findings, pages, stats: { pages, findings, tokens, … }, error }`.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return badSessionId(id) ?? proxyJson("research_get", `/research/${id}`);
}
