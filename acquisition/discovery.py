"""Prompt -> CompanyBrief -> competitors (CompetitorCandidate) -> MarketWatch, using Nimble Search.

Every step has a deterministic fallback: the free Liquid model is rate-limited and flaky, so the LLM may only
improve a result, never be required for one. LLM-proposed competitor names are also grounded: a name that no
search result mentions is dropped, so provenance (`seen_in`) always points at real pages.
"""
import asyncio
import json
import re
from collections import Counter, defaultdict
from datetime import datetime
from typing import Callable, Optional

from contracts import CompanyBrief, CompetitorCandidate, MarketWatch, slugify

from .search import LOW_VALUE_HOSTS, SearchHit, domain_label, is_low_value, normalize_url, registered_domain

LLM = Callable[[str], str]    # sync prompt -> text; run in a thread so it never blocks the event loop

TLD = r"\.(?:com|io|ai|app|co|so|net|org|dev|work|hq|us)"
WORD = r"[A-Z0-9][\w&'’-]*(?:\.[\w-]+)*"            # dots only inside a word: "Harvest. It's" is not a name
NAME = r"(?:" + WORD + r"(?:[ \t]+" + WORD + r"){0,3}|[a-z][\w-]*" + TLD + r")"
LEADS = (r"(?i:we\s*['’]?re|we\s+are|i\s+run|i\s+own|i\s+work\s+(?:at|for)|i['’]?m\s+(?:the\s+)?\w+\s+(?:of|at)"
         r"|my\s+company\s+is|our\s+company\s+is|my\s+startup\s+is|our\s+startup\s+is|this\s+is"
         r"|we\s+(?:make|build|run|sell))\s+")
LEAD_RE = re.compile(LEADS + "(" + NAME + ")")
SUBJECT_RE = re.compile(r"^\s*(" + NAME + r")\s+(?i:is|makes|builds|sells|offers|provides)\b")
DOMAIN_RE = re.compile(r"\b((?:[a-z0-9-]+\.)+(?:com|io|ai|app|co|so|dev|net|org))\b", re.I)
CATEGORY_LEAD = re.compile(r"(?i)^(?:and\s+|,\s*)?(?:we\s+(?:make|build|sell|offer|provide|do|are)|which\s+(?:makes|is)"
                           r"|that\s+(?:makes|is)|is|are|makes|builds|sells|offers|a|an|the)\s+")

# Title Case titles and sentence-initial words make capitalized-phrase extraction noisy; these never name a company.
STOPWORDS = set("""
a an and or the of for to in on at by with from vs vs. versus is are was be it its this that these those here there
i we you my our your their me us who which what why how when where not no yes all any each more most other some such
best top free paid new cheap cheapest better good great easy simple ultimate complete full quick expert expert's
alternative alternatives competitor competitors comparison compare compared comparisons review reviews reviewed
rated ranked tested tried picked picks pick list lists guide guides features feature pricing price prices plans plan
pros cons overview options option vendors vendor companies company products product brands brand tools tool apps app
software solution solutions platform platforms service services system systems suite sites site
discover find looking explore read learn see get try start want need have has choose check use using compared
january february march april may june july august september october november december
monday's today yesterday week month year years
ai saas crm erp api b2b b2c smb sme it hr seo web mobile online cloud desktop ios android iphone mac windows linux
gantt kanban agile scrum faq faqs blog news press update updates
""".split())
GENERIC = set("""
project projects management manager work workflow team teams business businesses enterprise small sales marketing
ai crm software tool tools app apps platform platforms solution solutions system suite hub cloud online
video messaging invoicing invoice invoices accounting finance payments payroll email chat support help desk service
os one pro plus collaboration productivity data
""".split())
PUBLISHER_SPLIT = re.compile(r"\s+[|–—-]\s+")
VS_RE = re.compile(r"([\w.&'’-]+)\s+(?i:vs\.?|versus)\s+([\w.&'’-]+(?:\s+[A-Z][\w&'’-]*)?)")
SLUG_VS_RE = re.compile(r"([a-z0-9]+)-vs-([a-z0-9]+)")
TOKEN_RE = re.compile(r"[A-Za-z0-9][\w&'’.-]*")
SENTENCE_END = re.compile(r"[.!?:;]\s+|\s+[|–—-]\s+|\(")
LIST_SPLIT = re.compile(r",\s*|\s+(?:and|or)\s+")


# --- names ---

def name_core(name: str) -> str:
    """'Monday.com' -> 'monday', 'Zoho CRM' -> 'zoho crm'. The text we look for in results."""
    core = re.sub(TLD + r"$", "", name.strip().lower())
    return re.sub(r"[^a-z0-9]+", " ", core).strip()


def name_key(name: str) -> str:
    """Alias key: 'Monday', 'monday.com' and 'Monday.com' are one entity."""
    return name_core(name).replace(" ", "")


def mentions(name: str, text: str) -> bool:
    core = name_core(name)
    if not core:
        return False
    pattern = r"(?<![a-z0-9])" + r"[\s.-]*".join(re.escape(w) for w in core.split()) + r"(?![a-z0-9])"
    return re.search(pattern, text.lower()) is not None


def resembles(name: str, label: str) -> bool:
    """Does a domain label look like this company's? 'hubspot' ~ 'HubSpot', 'zoho' ~ 'Zoho CRM', 'getjobber' ~ 'Jobber'."""
    key, label = name_key(name), label.lower().replace("-", "")
    if not key or not label:
        return False
    if key == label or label in {"get" + key, "try" + key, "use" + key, key + "app", key + "hq", key + "inc"}:
        return True
    return len(key) >= 4 and len(label) >= 4 and (key.startswith(label) or label.startswith(key))


def is_generic(word: str) -> bool:
    w = word.lower().strip(".'’")
    return w in GENERIC or w in STOPWORDS or (w.endswith("s") and (w[:-1] in GENERIC or w[:-1] in STOPWORDS))


def strip_generic_tail(name: str) -> str:
    """'monday AI Work Platform' -> 'monday'; keeps the name if every word is generic."""
    words = name.split()
    while len(words) > 1 and is_generic(words[-1]):
        words.pop()
    return " ".join(words)


# --- company ---

def parse_json_block(text: Optional[str], opener: str = "{"):
    """First {...} (or [...]) block: Liquid wraps JSON in code fences and sometimes adds prose."""
    closer = "}" if opener == "{" else "]"
    m = re.search(re.escape(opener) + r".*" + re.escape(closer), text or "", re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        return None


def parse_prompt(prompt: str) -> tuple[Optional[str], str, Optional[str]]:
    """Heuristic (name, category, domain) from "We're Acme, we make invoicing software for freelancers"."""
    text = " ".join(prompt.split())
    domain_m = DOMAIN_RE.search(text)
    domain = domain_m.group(1).lower() if domain_m else None
    m = LEAD_RE.search(text) or SUBJECT_RE.search(text)
    if not m:
        return (domain.split(".")[0].title() if domain else None), "", domain
    name = m.group(1).rstrip(".,")
    rest = text[m.end():]
    rest = re.sub(r"^[\s,:;-]+", "", rest)
    for _ in range(3):
        rest = CATEGORY_LEAD.sub("", rest).lstrip(" ,")
    category = re.split(r"[.!?\n]|,\s+(?:and\s+)?(?:we|our|i)\b", rest)[0].strip(" ,")
    return name, category[:120], domain


COMPANY_PROMPT = """Extract the user's company from their message. Return ONLY JSON, no commentary:
{{"name": "<company name exactly as written>", "description": "<one sentence: what they do>", "category": "<short search phrase for their market, e.g. invoicing software for freelancers>"}}

Message: {prompt}
"""


async def ask(llm: Optional[LLM], prompt: str) -> Optional[str]:
    if llm is None:
        return None
    try:
        return await asyncio.to_thread(llm, prompt)
    except Exception:            # the LLM is optional: any failure means "use the fallback"
        return None


def pick_domain(name: str, hits: list[SearchHit]) -> Optional[str]:
    """First non-low-value host that looks like the name; else a result titled with the name ('Jira | Atlassian')."""
    fallback = None
    for h in hits:
        if is_low_value(h.url):
            continue
        if resembles(name, domain_label(h.url)):
            return registered_domain(h.url)
        lead = PUBLISHER_SPLIT.split(h.title)[0].strip()
        if fallback is None and name_key(lead).startswith(name_key(name)) and len(lead.split()) <= 3:
            fallback = registered_domain(h.url)
    return fallback


async def resolve_domain(name: str, search, query: str = "{} official site") -> Optional[str]:
    return pick_domain(name, await search.search(query.format(name), max_results=5))


async def resolve_company(prompt: str, search, llm: Optional[LLM] = None) -> CompanyBrief:
    name, category, domain = parse_prompt(prompt)
    description = " ".join(prompt.split())
    data = parse_json_block(await ask(llm, COMPANY_PROMPT.format(prompt=prompt)))
    if isinstance(data, dict):
        llm_name = str(data.get("name") or "").strip()
        if llm_name and llm_name.lower() in prompt.lower():      # grounded in the user's words, or ignored
            name = llm_name
        category = str(data.get("category") or "").strip() or category
        description = str(data.get("description") or "").strip() or description
    if not name:
        raise ValueError("couldn't find a company name in the prompt; try \"We're <Company>, we make ...\"")
    if not domain:
        domain = await resolve_domain(name, search)
    return CompanyBrief(company_id=slugify(name), name=name[:120], domain=domain, description=description[:600],
                        category=category[:120], prompt=prompt[:4000])


# --- competitors ---

def discovery_queries(company: CompanyBrief) -> list[str]:
    queries = ["{} competitors".format(company.name), "{} vs".format(company.name)]
    queries.append("best {}".format(company.category) if company.category else "{} alternatives".format(company.name))
    return queries


def hit_text(h: SearchHit) -> str:
    """Title minus its publisher suffix ('... - Forbes Advisor'), description, and URL path words."""
    parts = PUBLISHER_SPLIT.split(h.title)
    title = " ".join(parts[:-1]) if len(parts) > 1 and len(parts[-1].split()) <= 4 else h.title
    path = re.sub(r"[-_/]+", " ", re.sub(r"^https?://[^/]+", "", h.url))
    return " ".join([title, h.description, path])


def is_brandish(token: str, sentence_start: bool) -> bool:
    if token.lower().strip(".'’") in STOPWORDS or token[0].isdigit():
        return False
    if re.search(TLD + r"$", token.lower()) or re.search(r"[a-z][A-Z]", token):    # monday.com, ClickUp
        return True
    return token[0].isupper() and not sentence_start


def phrases(chunk: str, sentence_start: bool) -> list[str]:
    """Runs of up to 3 brand-like tokens: 'Microsoft Planner', 'Zoho CRM', 'ClickUp'."""
    out, phrase = [], []
    for i, tok in enumerate(TOKEN_RE.findall(chunk)):
        tok = tok.rstrip(".,'’")
        if tok and is_brandish(tok, sentence_start and i == 0) and len(phrase) < 3:
            phrase.append(tok)
            continue
        if phrase:
            out.append(" ".join(phrase))
        phrase = []
    return out + ([" ".join(phrase)] if phrase else [])


def candidate_names(hits: list[SearchHit]) -> list[str]:
    """Fallback name extraction: 'X vs Y' patterns (titles, descriptions, URL slugs) + capitalized phrases in
    descriptions. Title Case titles are only mined for 'vs' pairs: every word in them is capitalized."""
    names = []
    for h in hits:
        for text in (h.title, h.description):
            for a, b in VS_RE.findall(text):
                names += [a, b]
        for a, b in SLUG_VS_RE.findall(h.url.lower()):
            names += [a, b]
        for sentence in SENTENCE_END.split(h.description):
            for j, chunk in enumerate(LIST_SPLIT.split(sentence)):     # "ClickUp, Teamwork.com, and monday"
                names += phrases(chunk, sentence_start=j == 0)
    out = []
    for n in names:
        n = strip_generic_tail(n.strip(".,:;'’\"()"))
        if len(name_key(n)) >= 2 and not re.fullmatch(r"\d+", name_key(n)) and not all(map(is_generic, n.split())):
            out.append(n)
    return out


COMPETITOR_PROMPT = """These are web search results about competitors of {name} ({category}).
List the companies or products that compete with {name}. Return ONLY JSON, no commentary:
{{"competitors": ["<name as written in the results>", ...]}}
Rules: at most 8 names, most frequently mentioned first. Only names that appear in the results below.
Do not include {name} itself, review sites (G2, Capterra), publishers (Forbes, PCMag) or generic phrases.

Results:
{results}
"""


def llm_names(text: Optional[str]) -> list[str]:
    data = parse_json_block(text) if text and "{" in text else None
    items = data.get("competitors") if isinstance(data, dict) else parse_json_block(text, "[")
    return [str(x).strip() for x in items or [] if isinstance(x, (str, int)) and str(x).strip()]


def score_candidates(names: list[str], hits: list[SearchHit], company: CompanyBrief,
                     strong: set[str] = frozenset()) -> list[CompetitorCandidate]:
    """Group aliases, count distinct results mentioning each, drop the user's company and noise.
    A name must be in >= 2 results unless it came from a strong source (a 'vs' pair or the LLM)."""
    excluded = {name_key(company.name), slugify(company.name).replace("-", "")}
    if company.domain:
        excluded.add(domain_label(company.domain))
    excluded |= {h.split(".")[0] for h in LOW_VALUE_HOSTS}
    forms: dict[str, Counter] = defaultdict(Counter)
    for n in names:
        n = strip_generic_tail(n)                 # "HubSpot CRM" -> "HubSpot": results say it both ways
        key = name_key(n)
        if all(map(is_generic, n.split())):       # the LLM also proposes "CRMs", "Project Management"
            continue
        if key and key not in excluded and not resembles(company.name, key):
            forms[key][n] += 1
    texts = {h.url: hit_text(h) for h in hits}
    candidates = []
    for key, counter in forms.items():
        display = max(counter, key=lambda f: (counter[f], any(c.isupper() for c in f), len(f)))
        seen = [url for url, text in texts.items()     # a result on the competitor's own site counts too
                if any(mentions(f, text) or resembles(f, domain_label(url)) for f in counter)]
        if not seen or (len(seen) < 2 and key not in strong):
            continue
        example = next(h.title for h in hits if h.url == seen[0])
        candidates.append(CompetitorCandidate(
            entity_id=slugify(display), name=display[:120], score=round(len(seen) / max(len(texts), 1), 3),
            mentions=len(seen), seen_in=seen[:5],
            reason="named in {} of {} search results, e.g. {!r}".format(len(seen), len(texts), example)[:300]))
    candidates.sort(key=lambda c: (-c.mentions, c.name.lower()))
    return candidates


async def discover_competitors(company: CompanyBrief, search, llm: Optional[LLM] = None,
                               max_competitors: int = 4) -> list[CompetitorCandidate]:
    batches = await asyncio.gather(*(search.search(q, max_results=10) for q in discovery_queries(company)))
    hits, seen_urls = [], set()
    for h in (h for batch in batches for h in batch):
        if normalize_url(h.url) not in seen_urls:
            seen_urls.add(normalize_url(h.url))
            hits.append(h)

    fallback = candidate_names(hits)
    strong = {name_key(n) for h in hits for pair in VS_RE.findall(h.title + " " + h.description) for n in pair}
    strong |= {name_key(n) for h in hits for pair in SLUG_VS_RE.findall(h.url.lower()) for n in pair}
    lines = "\n".join("{}. {} -- {}".format(i + 1, h.title, h.description[:300]) for i, h in enumerate(hits[:30]))
    proposed = llm_names(await ask(llm, COMPETITOR_PROMPT.format(name=company.name, category=company.category or "?",
                                                                 results=lines)))
    names = proposed + fallback if proposed else fallback
    candidates = score_candidates(names, hits, company, strong | {name_key(n) for n in proposed})
    if proposed:     # LLM picks first (still grounded by score_candidates), then the fallback's best
        order = {name_key(n): i for i, n in enumerate(proposed)}
        candidates.sort(key=lambda c: (order.get(name_key(c.name), len(order)), -c.mentions))

    chosen: list[CompetitorCandidate] = []
    pool = iter(candidates)
    while len(chosen) < max_competitors:
        batch = [c for _, c in zip(range(max_competitors - len(chosen)), pool)]
        if not batch:
            break
        domains = await asyncio.gather(*(competitor_domain(c.name, hits, search) for c in batch))
        for c, d in zip(batch, domains):
            if d and company.domain and registered_domain(d) == registered_domain(company.domain):
                continue       # an alias of the user's own company ("Asana Work Graph")
            if d and any(x.domain == d for x in chosen):
                continue       # two names, one company ("Monday" and "monday Work Management")
            chosen.append(c.model_copy(update={"domain": d}))
    return chosen


async def competitor_domain(name: str, hits: list[SearchHit], search) -> Optional[str]:
    """Reuse a discovery result's host when it's clearly the competitor's (monday.com/blog/...); else search."""
    for h in hits:
        if not is_low_value(h.url) and resembles(name, domain_label(h.url)):
            return registered_domain(h.url)
    return await resolve_domain(name, search, "{} official website")


def build_watch(company: CompanyBrief, competitors: list[CompetitorCandidate], now: datetime,
                lookback_days: int = 30) -> MarketWatch:
    competitors = [c for c in competitors if c.entity_id != company.company_id]
    if not competitors:
        raise ValueError("no competitors found for {}".format(company.name))
    return MarketWatch(watch_id=MarketWatch.make_id(company.company_id), company=company,
                       competitors=competitors[:8], lookback_days=lookback_days, created_at=now)

