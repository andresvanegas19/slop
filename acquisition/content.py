"""MarketWatch -> recent pages per entity (Nimble Search) -> fetched pages (Nimble Extract) -> EvidenceEnvelopes.

Pages are chosen per entity and the budget is dealt round-robin, so one noisy competitor with 30 news hits
can't crowd out the others. Every fetch becomes an envelope, failures included (status != ok): they are
recorded, never used as evidence.
"""
import asyncio
import dataclasses
import re
from collections import Counter
from dataclasses import dataclass
from typing import Optional

from contracts import EvidenceEnvelope, MarketWatch, RetrievalStatus, SourceRecipe, SourceType

from .discovery import TLD, mentions
from .envelope import build
from .normalize import clean_line, sha256
from .search import SearchHit, is_low_value, normalize_url

MAX_MARKDOWN = 40_000          # long articles are mostly comments and "related stories"; B reads the top
NEWS_PARSER = "nimble-search-v1"
PRICING_PARSER = "nimble-md-cards-v1"   # same plan-card hash as the configured pricing sources


@dataclass(frozen=True)
class Entity:
    entity_id: str
    name: str
    domain: Optional[str]
    is_self: bool = False


@dataclass(frozen=True)
class Planned:
    entity: Entity
    source_type: SourceType
    hit: SearchHit


def time_range_for(lookback_days: int) -> str:
    return "week" if lookback_days <= 7 else "month" if lookback_days <= 31 else "year"


def market_hint(category: str) -> str:
    """'CRM for small sales teams' -> 'CRM': disambiguates 'Monday' the company from Monday the day."""
    head = re.split(r"\s+(?:for|that|which|with|to)\s+|,", category.strip(), maxsplit=1)[0].split()
    return " ".join(head if len(head) <= 3 else head[-2:])


def entities(watch: MarketWatch, include_self: bool) -> list[Entity]:
    out = [Entity(c.entity_id, c.name, c.domain) for c in watch.competitors]
    if include_self:      # last, so a small budget goes to competitors first
        c = watch.company
        out.append(Entity(c.company_id, c.name, c.domain, is_self=True))
    return out


async def entity_hits(entity: Entity, hint: str, search, n: int, time_range: str) -> tuple[list[Planned], int]:
    """Candidate pages for one entity, best first: news, the pricing page, then launch/partnership pages."""
    news_q = '"{}" {}'.format(entity.name, hint).strip()
    general_q = '"{}" launches OR announces OR pricing OR partnership'.format(entity.name)
    jobs = [search.search(news_q, focus="news", max_results=n, time_range=time_range),
            search.search(general_q, max_results=n, time_range=time_range)]
    if entity.domain:
        jobs.append(search.search("{} pricing".format(entity.name), max_results=3, include_domains=[entity.domain]))
    results = await asyncio.gather(*jobs)
    news, general = results[0], results[1]
    pricing = results[2] if len(results) > 2 else []
    pricing = sorted(pricing, key=lambda h: "pricing" not in h.url.lower())[:1]

    ordered = [Planned(entity, SourceType.pricing, h) for h in pricing]
    for pair in zip_longest(news, general):
        ordered += [Planned(entity, SourceType.news, h) for h in pair if h]
    if len(ordered) > 1 and ordered[0].source_type == SourceType.pricing and news:
        ordered[0], ordered[1] = ordered[1], ordered[0]        # top news first, the pricing page second
    return ordered, len(jobs)


def zip_longest(a: list, b: list) -> list[tuple]:
    return [(a[i] if i < len(a) else None, b[i] if i < len(b) else None) for i in range(max(len(a), len(b)))]


def round_robin(per_entity: list[list[Planned]], max_pages: int) -> list[Planned]:
    """One page from each entity in turn until the budget runs out."""
    picked, i = [], 0
    while len(picked) < max_pages and any(i < len(q) for q in per_entity):
        for q in per_entity:
            if i < len(q) and len(picked) < max_pages:
                picked.append(q[i])
        i += 1
    return picked


def on_topic(name: str, h: SearchHit) -> bool:
    """The name must appear in the title or description; 'monday.com' must appear as written (not 'Monday')."""
    text = h.title + " " + h.description
    return name.lower() in text.lower() if re.search(TLD + "$", name.lower()) else mentions(name, text)


def article_hash(text: str) -> str:
    """Stable across renders of an unchanged article: formatting, links and blank lines don't count."""
    lines = (clean_line(l).lower() for l in text.splitlines())
    return sha256("\n".join(l for l in lines if l))


def source_id(p: Planned) -> str:
    return "{}-{}-{}".format(p.entity.entity_id, p.source_type.value, sha256(normalize_url(p.hit.url))[:8])


def envelope_for(watch: MarketWatch, p: Planned, run_id: str, result, country: str = "US") -> EvidenceEnvelope:
    recipe = SourceRecipe(source_id=source_id(p), watch_id=watch.watch_id, entity_id=p.entity.entity_id,
                          entity_name=p.entity.name, source_type=p.source_type, seed_url=p.hit.url,
                          parser_version=PRICING_PARSER if p.source_type == SourceType.pricing else NEWS_PARSER)
    if len(result.markdown) > MAX_MARKDOWN:
        result = dataclasses.replace(result, markdown=result.markdown[:MAX_MARKDOWN])
    env, _ = build(recipe, run_id, result, country)
    update = {"structured": {"title": p.hit.title, "query": p.hit.query, "search_description": p.hit.description,
                             "entity_type": p.hit.entity_type}}     # flat strings: RawTree flattens nested dicts
    if env.markdown and len(env.markdown) > MAX_MARKDOWN:
        update["markdown"] = env.markdown[:MAX_MARKDOWN]
    if p.source_type == SourceType.news and env.status == RetrievalStatus.ok:
        update["section_hashes"] = {"article": article_hash(update.get("markdown", env.markdown))}
    return env.model_copy(update=update)


async def collect_market_content(watch: MarketWatch, search, nimble, run_id: str, max_pages: int = 20,
                                 include_self: bool = True) -> tuple[list[EvidenceEnvelope], dict]:
    country = watch.company.region or "US"
    locale = "en-" + country
    hint = market_hint(watch.company.category)
    time_range = time_range_for(watch.lookback_days)
    ents = entities(watch, include_self)
    planned = await asyncio.gather(*(entity_hits(e, hint, search, watch.max_results_per_query, time_range)
                                     for e in ents))

    stats = {"queries": sum(n for _, n in planned), "hits": 0, "skipped_low_value": 0, "duplicates": 0,
             "skipped_off_topic": 0}
    seen: set[str] = set()
    per_entity: list[list[Planned]] = []
    for hits, _ in planned:
        kept = []
        for p in hits:
            stats["hits"] += 1
            key = normalize_url(p.hit.url)
            if is_low_value(p.hit.url):
                stats["skipped_low_value"] += 1
            elif key in seen:
                stats["duplicates"] += 1
            elif p.source_type == SourceType.news and not on_topic(p.entity.name, p.hit):
                stats["skipped_off_topic"] += 1      # "Monday" news that isn't about monday.com
            else:
                seen.add(key)
                kept.append(p)
        per_entity.append(kept)

    picked = round_robin(per_entity, max_pages)
    results = await asyncio.gather(*(nimble.extract(p.hit.url, country=country, locale=locale) for p in picked))
    envelopes = [envelope_for(watch, p, run_id, r, country) for p, r in zip(picked, results)]
    stats["fetched"] = len(envelopes)
    funnel = dict(stats)
    funnel["by_status"] = dict(Counter(e.status.value for e in envelopes))
    funnel["by_entity"] = dict(Counter(e.entity_id for e in envelopes))
    return envelopes, funnel
