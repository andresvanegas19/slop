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
    "agent_context": TABLE_PREFIX + "_agent_context_events",  # CompanyContext rows from agent/
    "agent_run": TABLE_PREFIX + "_agent_run_events",          # AgentRunRecord rows from agent/
    "research": TABLE_PREFIX + "_research_events",            # ResearchEventRow rows from agent/research.py
    "video": TABLE_PREFIX + "_video_events",                  # video versions published by the web app (read-only here)
    "user_prompts": TABLE_PREFIX + "_user_prompts",           # user prompts logged by the web app (read-only here)
    "market_watch": TABLE_PREFIX + "_market_watches",         # MarketWatch rows (A: company + discovered competitors)
    "development": TABLE_PREFIX + "_market_developments",     # MarketDevelopment rows (B: grounded market events)
    "video_storyboard": TABLE_PREFIX + "_video_storyboards",  # VideoStoryboardRecord rows (B -> C: what the video renders)
}
