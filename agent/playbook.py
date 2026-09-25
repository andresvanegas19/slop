"""Content playbook for the storyline writer: the same audience-first rules as
generation-video/src/lib/content-playbook.ts (a 0.6-2 s multihook, one value shift per beat, one production design,
one psychological angle of the 5-7-10 matrix, and the growth / connection / sale funnel), phrased for Liquid's small
context. Long-form notes: generation-video/knowledge/content-strategy.md.
"""

ANGLES = ("the myth", "the versus (old way against new way, never naming anyone)", "the quick hack",
          "the common mistake", "the transformation", "behind the scenes", "the contrarian truth")

STORY_RULES = (
    "Storytelling playbook (apply silently; never write these labels in beats, title or logline): "
    "start from what the audience needs, is searching for or is curious about; the brand is the bridge to that answer, "
    "never the topic of the first beat, and the story speaks to one specific sub-niche of that audience. "
    "Beat 1 is the hook for the first 0.6 to 2 seconds: a visual jolt (sudden motion, an extreme close-up or a strong "
    "contrast) plus a message that opens a question the last beat answers. "
    "Every beat turns a value through a small conflict (doubt to confidence, chaos to calm, belief to truth); a beat "
    "that only explains is rewritten. Keep one production design (wardrobe, props, palette, light) in every visual. "
    "Build the whole story on ONE angle: " + ", ".join(ANGLES) + "; name the angle in \"reason\". "
    "Match the funnel stage: an ad sells (answer the main objection with proof, one call to action); a company video "
    "connects (trust through real people, the process and a small honest setback); an awareness request grows the "
    "audience (high value or entertainment, brand in the background)."
)
