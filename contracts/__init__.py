"""Shared data contracts. A -> B: evidence.py. B internal: state.py, events.py. B -> C: output.py."""
from .common import SCHEMA_VERSION, TABLES
from .evidence import EvidenceEnvelope, RetrievalStatus, SourceRecipe, SourceType, WatchBrief, make_obs_id
from .events import EventType, ModelCallRecord, OutboxEvent, RunRecord
from .output import Claim, MediaJob, MediaStatus, Scene, SceneType, Storyboard, StoryboardRecord, StyleGuide
from .state import Belief, BeliefStatus, OpType, Patch, PatchDecision, PatchOp, PatchOrigin, StateSlice, belief_key
