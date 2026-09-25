"""Offline tests against recorded Nimble responses (tests/fixtures). No network."""
import dataclasses
from datetime import datetime, timezone

import pytest

from contracts import RetrievalStatus, SourceRecipe, SourceType
from acquisition import fixtures
from acquisition.classify import classify
from acquisition.envelope import build
from acquisition.nimble import NimbleResult
from acquisition.normalize import cards_hash, pricing_cards

SOURCES = ["notion-pricing", "linear-pricing", "jira-pricing"]


def load_all(source_id, root=fixtures.FIXTURE_DIR):
    paths = fixtures.all_for(source_id, root)
    assert paths, "no fixtures for {} in {}".format(source_id, root)
    return [fixtures.load(p) for p in paths]


def recipe(source_id="notion-pricing"):
    entity = source_id.split("-")[0]
    return SourceRecipe(source_id=source_id, watch_id="w", entity_id=entity, entity_name=entity.title(),
                        source_type=SourceType.pricing, seed_url="https://example.com/pricing",
                        parser_version="nimble-md-cards-v1")


def fake(**kw):
    base = dict(url="https://example.com/pricing", http_status=200, raw={"status": "success"},
                fetched_at=datetime(2026, 9, 25, tzinfo=timezone.utc))
    return NimbleResult(**{**base, **kw})


# --- the pricing hash: stable when nothing changed, different when a price did ---

@pytest.mark.parametrize("source_id", SOURCES)
def test_pricing_hash_is_stable_across_renders(source_id):
    hashes = set()
    for r in load_all(source_id):
        c = classify(r, SourceType.pricing)
        assert c.status == RetrievalStatus.ok, c.detail
        hashes.add(cards_hash(c.cards))
    assert len(hashes) == 1


def test_truncated_render_hashes_like_full_render():
    full = cards_hash(classify(load_all("notion-pricing")[0], SourceType.pricing).cards)
    truncated = [r for r in load_all("notion-pricing", fixtures.NOWAIT_DIR) if 3000 < len(r.markdown) < 5000]
    assert truncated
    assert cards_hash(classify(truncated[0], SourceType.pricing).cards) == full


def test_planted_price_change_changes_hash():
    r = load_all("notion-pricing")[0]
    changed = dataclasses.replace(r, markdown=r.markdown.replace("$10per member", "$8per member"))
    assert changed.markdown != r.markdown
    assert cards_hash(pricing_cards(changed.markdown)) != cards_hash(pricing_cards(r.markdown))


def test_feature_text_change_does_not_change_hash():
    r = load_all("linear-pricing")[0]
    changed = r.markdown.replace("Unlimited file uploads", "Unlimited uploads and more").replace("40,000", "50,000")
    assert changed != r.markdown
    assert cards_hash(pricing_cards(changed)) == cards_hash(pricing_cards(r.markdown))


@pytest.mark.parametrize("source_id,expected", [
    ("notion-pricing", {"free": "$0 per member/month", "plus": "$10 per member/month",
                        "business": "$20 per member/month", "enterprise": "custom pricing"}),
    ("linear-pricing", {"free": "$0", "basic": "$10 per user/month", "business": "$16 per user/month",
                        "enterprise": "custom"}),
    ("jira-pricing", {"free": "$0", "standard": "$7.91 per user/month", "premium": "$14.54 per user/month",
                      "enterprise": "contact sales"}),
])
def test_plan_cards(source_id, expected):
    cards = classify(load_all(source_id)[0], SourceType.pricing).cards
    assert {c.plan: c.price for c in cards} == expected


# --- status: bad renders must never look like evidence ---

def test_wrong_region_is_partial():
    eur = [r for r in load_all("notion-pricing", fixtures.NOWAIT_DIR) if "€" in r.markdown]
    assert eur
    c = classify(eur[0], SourceType.pricing, country="US")
    assert c.status == RetrievalStatus.partial and "currency" in c.detail


def test_half_render_is_empty():
    tiny = [r for r in load_all("notion-pricing", fixtures.NOWAIT_DIR) if len(r.markdown) < 100]
    assert tiny
    assert classify(tiny[0], SourceType.pricing).status == RetrievalStatus.empty


def test_page_without_prices_is_partial():
    no_prices = [r for r in load_all("jira-pricing", fixtures.NOWAIT_DIR) if len(r.markdown) > 10000]
    assert no_prices
    assert classify(no_prices[0], SourceType.pricing).status == RetrievalStatus.partial


@pytest.mark.parametrize("code", [401, 403, 429])
def test_block_codes(code):
    assert classify(fake(http_status=code, raw=None), SourceType.pricing).status == RetrievalStatus.blocked


def test_challenge_page_with_200_is_blocked():
    r = fake(markdown="Just a moment... Verify you are human by completing the action below. " * 20)
    assert classify(r, SourceType.pricing).status == RetrievalStatus.blocked


def test_transport_error():
    c = classify(fake(http_status=None, raw=None, error="ReadTimeout"), SourceType.pricing)
    assert c.status == RetrievalStatus.error


# --- envelope ---

def test_ok_envelope():
    r = load_all("linear-pricing")[0]
    env, _ = build(recipe("linear-pricing"), "run_dev_test", r)
    assert env.usable and env.section_hashes["pricing"] and env.markdown
    assert env.nimble_task_id == r.task_id and env.fetched_at == r.fetched_at
    assert env.obs_id == build(recipe("linear-pricing"), "run_dev_test", r)[0].obs_id   # same fetch, same id


def test_failed_envelope_carries_no_content():
    env, _ = build(recipe(), "run_dev_test", fake(http_status=403, raw=None))
    assert not env.usable
    assert env.markdown is None and env.section_hashes == {} and env.content_hash == ""


def test_partial_envelope_has_no_pricing_hash():
    eur = [r for r in load_all("notion-pricing", fixtures.NOWAIT_DIR) if "€" in r.markdown][0]
    env, _ = build(recipe(), "run_dev_test", eur)
    assert env.status == RetrievalStatus.partial and "pricing" not in env.section_hashes
