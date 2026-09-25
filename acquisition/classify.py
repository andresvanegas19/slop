"""Decide RetrievalStatus for one fetch. Only `ok` may change beliefs (EvidenceEnvelope.usable)."""
import re
from dataclasses import dataclass, field

from contracts import RetrievalStatus, SourceType

from .nimble import NimbleResult
from .normalize import EXPECTED_CURRENCY, PlanPrice, html_to_text, pricing_cards

BLOCK_CODES = {401, 403, 429}
MIN_MARKDOWN = 1000     # shorter markdown is usually a half render: try the html text instead
MIN_CONTENT = 500       # still shorter after the fallback: empty
BLOCK_PAGE_MAX = 5000   # only short pages are checked for challenge text, so real pages mentioning "captcha" pass
BLOCK_MARKERS = re.compile(
    r"verify you are (a )?human|are you a robot|captcha|access denied|just a moment|attention required"
    r"|enable javascript and cookies|request blocked|unusual traffic", re.I)


@dataclass
class Classified:
    status: RetrievalStatus
    detail: str = ""
    text: str = ""                                  # markdown, or stripped html when markdown was a half render
    cards: list[PlanPrice] = field(default_factory=list)


def classify(result: NimbleResult, source_type: SourceType, country: str = "US") -> Classified:
    if result.http_status in BLOCK_CODES:
        return Classified(RetrievalStatus.blocked, "http {}".format(result.http_status))
    if result.raw is None:
        return Classified(RetrievalStatus.error, result.error or "no response")
    if result.http_status and result.http_status >= 400:
        return Classified(RetrievalStatus.error, "http {}".format(result.http_status))

    text = result.markdown
    if len(text) < MIN_MARKDOWN:
        fallback = html_to_text(result.html)
        if len(fallback) > len(text):
            text = fallback
    if len(text) < BLOCK_PAGE_MAX and BLOCK_MARKERS.search(text):
        return Classified(RetrievalStatus.blocked, "challenge page", text)
    if len(text) < MIN_CONTENT:
        return Classified(RetrievalStatus.empty, "{} chars".format(len(text)), text)

    if source_type != SourceType.pricing:
        return Classified(RetrievalStatus.ok, text=text)

    cards = pricing_cards(text)
    if not cards:
        return Classified(RetrievalStatus.partial, "no plan prices found", text)
    expected = EXPECTED_CURRENCY.get(country)
    wrong = sorted({c.currency for c in cards if c.currency and c.currency != expected})
    if expected and wrong:
        return Classified(RetrievalStatus.partial, "currency {} but region {}".format("".join(wrong), country),
                          text, cards)
    return Classified(RetrievalStatus.ok, text=text, cards=cards)
