"""Turn a rendered page into stable text and section hashes.

`section_hashes["pricing"]` gates B's Liquid call, so it must stay identical across renders of an
unchanged page and change when a price does. Hashing a window of page text fails that: the same page
arrives with different nav, testimonials, footers and lengths. Instead we hash only the plan cards:
each heading followed within a few lines by a price.
"""
import hashlib
import re
from dataclasses import dataclass

AMOUNT = re.compile(r"^([$€£])\s?(\d[\d,]*(?:\.\d+)?)(.*)$")
WORD_PRICE = re.compile(r"^(custom|contact sales|free)\b(?![$€£\d])", re.I)   # not "Free$0 per seat" table rows; not footer "Contact us"
WORD_PRICE_MAX_LEN = 40            # "Custom pricing" yes; "Free plan comes with 150 steps..." no
LINES_AFTER_HEADING = 4            # Jira puts a tagline between the plan name and its price
BADGES = re.compile(r"(most popular|recommended|best value|popular|new)$", re.I)
EXPECTED_CURRENCY = {"US": "$", "GB": "£"}


@dataclass(frozen=True, order=True)
class PlanPrice:
    plan: str                      # normalized: "plus", "business"
    price: str                     # normalized: "$10 per member/month", "custom pricing"

    @property
    def currency(self) -> str | None:
        return self.price[0] if self.price[:1] in "$€£" else None


def clean_line(line: str) -> str:
    line = re.sub(r"!\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]", "", line)      # images
    line = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", line)              # links -> their text
    line = re.sub(r"[*_`\\]", "", line)                               # emphasis and escapes ("Plus\*")
    return re.sub(r"\s+", " ", line).strip()


def normalize_plan(heading: str) -> str:
    name = clean_line(heading.lstrip("#")).lower()
    name = BADGES.sub("", name)                                       # "BusinessRecommended" -> "business"
    return re.sub(r"[^a-z0-9 ]", "", name).strip()


def normalize_price(line: str) -> str:
    m = AMOUNT.match(line)
    if not m:
        return line.lower()
    symbol, amount, rest = m.groups()
    rest = re.sub(r"\s*/\s*", "/", rest.lower()).strip()              # "per member / month" -> "per member/month"
    return "{}{} {}".format(symbol, amount.replace(",", ""), rest).strip()


def pricing_cards(markdown: str) -> list[PlanPrice]:
    raw = [l for l in markdown.splitlines() if l.strip()]
    lines = [clean_line(l) for l in raw]
    cards = set()
    for i, orig in enumerate(raw):
        if not orig.lstrip().startswith("#"):
            continue
        plan = normalize_plan(orig)
        if not plan:
            continue
        window = []
        for nxt_orig, nxt in zip(raw[i + 1:i + 1 + LINES_AFTER_HEADING], lines[i + 1:i + 1 + LINES_AFTER_HEADING]):
            if nxt_orig.lstrip().startswith("#"):
                break
            window.append(nxt)
        price = next((l for l in window if AMOUNT.match(l)), None)
        if price is None:
            price = next((l for l in window if WORD_PRICE.match(l) and len(l) <= WORD_PRICE_MAX_LEN), None)
        if price:
            cards.add(PlanPrice(plan, normalize_price(price)))
    return sorted(cards)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def cards_hash(cards: list[PlanPrice]) -> str:
    return sha256("\n".join("{}={}".format(c.plan, c.price) for c in sorted(cards)))


def html_to_text(html: str) -> str:
    html = re.sub(r"<(script|style|noscript)\b.*?</\1>", " ", html, flags=re.S | re.I)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()
