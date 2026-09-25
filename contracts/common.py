SCHEMA_VERSION = "0.1"

# RawTree is shared by every hackathon team: all our tables start with this prefix.
TABLE_PREFIX = "slop_human"
TABLES = {
    "observation": TABLE_PREFIX,                   # EvidenceEnvelope rows (already exists)
    "patch": TABLE_PREFIX + "_patch_events",
    "run": TABLE_PREFIX + "_run_events",
    "model_call": TABLE_PREFIX + "_model_call_events",
    "media": TABLE_PREFIX + "_media_events",
    "evaluation": TABLE_PREFIX + "_evaluation_events",
    "storyboard": TABLE_PREFIX + "_build",         # B -> C handoff: StoryboardRecord rows
}
