"""NimbleResult + SourceRecipe -> EvidenceEnvelope (one row in RawTree `slop_human`)."""
from contracts import EvidenceEnvelope, RetrievalStatus, SourceRecipe, make_obs_id

from .classify import Classified, classify
from .nimble import NimbleResult
from .normalize import cards_hash, sha256


def build(recipe: SourceRecipe, run_id: str, result: NimbleResult, country: str = "US") -> tuple[EvidenceEnvelope, Classified]:
    """Build once per fetch and reuse it on delivery retries: obs_id includes fetched_at (DECISIONS D1)."""
    c = classify(result, recipe.source_type, country)
    has_content = c.status in (RetrievalStatus.ok, RetrievalStatus.partial)
    env = EvidenceEnvelope(
        obs_id=make_obs_id(recipe.source_id, recipe.seed_url, result.fetched_at),
        run_id=run_id,
        source_id=recipe.source_id,
        entity_id=recipe.entity_id,
        entity_name=recipe.entity_name,
        source_type=recipe.source_type,
        url=recipe.seed_url,
        fetched_at=result.fetched_at,
        status=c.status,
        http_status=result.http_status,
        parser_version=recipe.parser_version,
        content_hash=sha256(c.text) if has_content else "",   # never hash a block or error page
        section_hashes={"pricing": cards_hash(c.cards)} if c.status == RetrievalStatus.ok and c.cards else {},
        markdown=c.text if has_content else None,
        nimble_task_id=result.task_id,
    )
    return env, c
