import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { validateStoryboard } from "@/lib/storyboard";
import { renderStoryboard } from "@/lib/storyboard-renderer";
(async () => {
  const v = validateStoryboard(JSON.parse(readFileSync(process.argv[2], "utf8")));
  if (!v.success) throw new Error(JSON.stringify(v.errors));
  const runId = randomUUID();
  const t0 = Date.now();
  const result = await renderStoryboard(v.data, runId, { brief: "A small seaside café next to an old lighthouse; the owners greet early walkers at golden hour" });
  const { plan, ...rest } = result as Record<string, unknown> & { plan?: unknown };
  console.log("RESULT", JSON.stringify({ ...rest, planSource: (plan as { source?: string } | undefined)?.source, totalMs: Date.now() - t0 }));
})().catch((error) => { console.error("FAILED", error); process.exit(1); });
