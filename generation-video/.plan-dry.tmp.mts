import { readFileSync } from "node:fs";
import { validateStoryboard } from "@/lib/storyboard";
import { writeCinematicPlan } from "@/lib/cinematic-prompts";

const dry = JSON.parse(readFileSync(process.argv[2], "utf8"));
const v = validateStoryboard(dry.storyboard);
if (!v.success) throw new Error(JSON.stringify(v.errors));
const sb = v.data;
(async () => {
const t0 = Date.now();
const plan = await writeCinematicPlan({
  brief: "A small seaside café next to an old lighthouse; the owners greet early walkers at golden hour",
  scenes: sb.scenes.map((scene) => ({
    durationSec: scene.timing.durationMs / 1000,
    narration: scene.narration,
    headline: scene.onScreenText[0]?.text,
    visual: scene.visualPrompt.startsWith(sb.style.visualPrompt) ? scene.visualPrompt.slice(sb.style.visualPrompt.length).trim() : scene.visualPrompt,
  })),
});
console.log(`elapsed ${Date.now() - t0}ms source=${plan.source} bible=${plan.bibleSource} guidance=${plan.guidanceSources.join(",")}`);
console.log("BIBLE:", plan.bibleText);
plan.shots.forEach((shot, i) => {
  console.log(`\n--- SHOT ${i + 1} [${shot.source}] camera=${shot.camera} beat=${shot.beat}`);
  console.log("KEYFRAME PROMPT:", shot.keyframePrompt);
  console.log("MOTION PROMPT:", shot.motionPrompt);
});
})();
