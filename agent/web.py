"""Direct website fetching for research sessions: robots.txt, host allowlist, size/time caps, HTML -> clean text.

Rules (enforced here, never by the model):
- Only http(s) URLs on hosts the session allows: the company's verified site (and subdomains / redirect targets),
  plus hosts whose name contains the company slug (e.g. coca-colacompany.com for "Coca-Cola").
- robots.txt `Disallow` for our user agent (or `*`) is respected, with `*` and `$` wildcards.
- 10 s timeout, at most 1.5 MB per response, HTML / text / XML only.
"""
import html
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Dict, List, Optional, Tuple
from urllib.parse import urldefrag, urljoin, urlparse

import httpx

USER_AGENT = "LongformResearchBot/0.1 (+company research for a video studio; respects robots.txt)"
ROBOTS_AGENT = "longformresearchbot"
TIMEOUT_S = 10.0
MAX_BYTES = 1_500_000
MAX_TEXT_CHARS = 80_000
MAX_LINKS = 400
TEXT_TYPES = ("text/html", "application/xhtml+xml", "text/plain", "application/xml", "text/xml", "text/css")

SKIP_TAGS = {"script", "style", "noscript", "svg", "template", "iframe", "canvas", "select", "button"}
BLOCK_TAGS = {"p", "div", "section", "article", "main", "header", "footer", "aside", "nav", "li", "ul", "ol", "br",
              "tr", "table", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "figure", "figcaption", "dd", "dt"}
HEADINGS = {"h1": "# ", "h2": "## ", "h3": "### ", "h4": "#### "}
SKIP_LINK = re.compile(r"(^|/)(login|log-in|signin|sign-in|signup|register|cart|checkout|account|search|cookie|"
                       r"privacy|terms|legal|accessibility|sitemap|wp-admin|token-exchange|configuration)(/|$|\?|\.)",
                       re.I)
SKIP_EXT = re.compile(r"\.(png|jpe?g|gif|webp|svg|ico|css|js|json|pdf|zip|mp4|mp3|mov|webm|woff2?|ttf|xml|rss)$", re.I)
PRIORITY = [  # (weight, pattern on path + link text)
    (10, r"about|who-we-are|our-company|company|our-story|history|mission|purpose|overview"),
    (9, r"products?|brands?|drinks|beverages|portfolio|solutions|services|shop|menu|offerings"),
    (8, r"news|press|media|stories|newsroom|blog|updates|announcements"),
    (7, r"sustainab|esg|impact|responsib|community|environment|planet"),
    (6, r"pricing|plans|price"),
    (5, r"careers?|jobs|people|culture|team|leadership"),
    (4, r"investors?|annual-report|results"),
]
LOW_VALUE = re.compile(r"contact|faq|help|support|locator|locations|feedback|subscribe|newsletter|unsubscribe|"
                       r"cookie|accessib|sitemap|disclaimer|report-fraud|scam", re.I)
CATEGORIES = ["about", "products", "news", "sustainability", "pricing", "careers", "investors"]
HEX = r"#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b"
BRAND_VAR = re.compile(r"--([\w-]*(?:brand|primary|accent|main|theme|red|secondary)[\w-]*)\s*:\s*(" + HEX + ")", re.I)
DATE_RE = re.compile(r"\b(?:\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? "
                     r"\d{1,2},? \d{4}|\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4})\b")


def normalize_url(url: str, base: Optional[str] = None) -> Optional[str]:
    try:
        joined = urljoin(base, url.strip()) if base else url.strip()
        joined = urldefrag(joined)[0]
        p = urlparse(joined)
    except ValueError:
        return None
    if p.scheme not in ("http", "https") or not p.hostname:
        return None
    path = p.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    return "{}://{}{}{}".format(p.scheme, p.netloc.lower(), path, "?" + p.query if p.query else "")


def host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def site_of(host: str) -> str:
    """'www.coca-cola.com' -> 'coca-cola.com'; handles two-part public suffixes like co.uk loosely."""
    parts = host.lower().strip(".").split(".")
    if len(parts) >= 3 and parts[-2] in ("co", "com", "org", "net", "gov", "ac") and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def slugs(name: str) -> List[str]:
    """'Coca-Cola' -> ['coca-cola', 'cocacola']; 'Acme Corp.' -> ['acme-corp', 'acmecorp', 'acme']."""
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    out = [base, base.replace("-", "")]
    words = [w for w in base.split("-") if w not in ("inc", "corp", "co", "company", "llc", "ltd", "the", "group")]
    if words:
        out += ["-".join(words), "".join(words)]
    seen, result = set(), []
    for s in out:
        if len(s) >= 2 and s not in seen:
            seen.add(s)
            result.append(s)
    return result


def compact(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(text or "")).strip()


@dataclass
class Page:
    url: str
    status: int
    title: str = ""
    description: str = ""
    text: str = ""
    headings: List[str] = field(default_factory=list)
    links: List[Tuple[str, str]] = field(default_factory=list)  # (absolute url, anchor text)
    og_image: Optional[str] = None
    theme_color: Optional[str] = None
    colors: List[str] = field(default_factory=list)
    logo_url: Optional[str] = None
    stylesheets: List[str] = field(default_factory=list)
    content_type: str = ""

    def summary(self) -> Dict:
        return {"url": self.url, "title": self.title, "description": self.description, "headings": self.headings[:20]}


class _Extractor(HTMLParser):
    def __init__(self, base_url):
        super().__init__(convert_charrefs=True)
        self.base = base_url
        self.skip = 0
        self.in_title = False
        self.title = ""
        self.meta: Dict[str, str] = {}
        self.chunks: List[str] = []
        self.headings: List[str] = []
        self.heading_tag: Optional[str] = None
        self.heading_buf: List[str] = []
        self.links: List[Tuple[str, str]] = []
        self.link_href: Optional[str] = None
        self.link_buf: List[str] = []
        self.style_buf: List[str] = []
        self.in_style = False
        self.logo: Optional[str] = None
        self.icon: Optional[str] = None
        self.stylesheets: List[str] = []

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "title":
            self.in_title = True
        elif tag == "meta":
            key = (a.get("name") or a.get("property") or "").lower()
            if key and a.get("content"):
                self.meta.setdefault(key, a["content"])
        elif tag == "link":
            rel = a.get("rel", "").lower()
            if ("icon" in rel or "apple-touch-icon" in rel) and a.get("href") and not self.icon:
                self.icon = urljoin(self.base, a["href"])
            if "stylesheet" in rel and a.get("href") and len(self.stylesheets) < 6:
                self.stylesheets.append(urljoin(self.base, a["href"]))
        elif tag == "img" and not self.logo:
            marker = " ".join([a.get("src", ""), a.get("alt", ""), a.get("class", ""), a.get("id", "")]).lower()
            if "logo" in marker and a.get("src") and not a["src"].startswith("data:"):
                self.logo = urljoin(self.base, a["src"])
        if tag == "style":
            self.in_style = True
        if tag in SKIP_TAGS:
            self.skip += 1
            return
        if a.get("style"):
            self.style_buf.append(a["style"])
        if tag in BLOCK_TAGS:
            self.chunks.append("\n")
        if tag in HEADINGS and not self.skip:
            self.heading_tag, self.heading_buf = tag, []
            self.chunks.append(HEADINGS[tag])
        if tag == "li":
            self.chunks.append("- ")
        if tag == "a" and a.get("href"):
            self.link_href, self.link_buf = a["href"], []

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag == "style":
            self.in_style = False
        if tag in SKIP_TAGS:
            self.skip = max(0, self.skip - 1)
            return
        if tag == self.heading_tag:
            text = squash(" ".join(self.heading_buf))
            if text and text not in self.headings:
                self.headings.append(text[:200])
            self.heading_tag = None
        if tag == "a" and self.link_href is not None:
            url = normalize_url(self.link_href, self.base)
            if url and len(self.links) < MAX_LINKS:
                self.links.append((url, squash(" ".join(self.link_buf))[:120]))
            self.link_href = None
        if tag in BLOCK_TAGS:
            self.chunks.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if self.in_style:
            self.style_buf.append(data)
        if self.skip:
            return
        self.chunks.append(data)
        if self.heading_tag:
            self.heading_buf.append(data)
        if self.link_href is not None:
            self.link_buf.append(data)


def extract(url: str, body: str, content_type: str = "text/html", status: int = 200) -> Page:
    if "html" not in content_type and "<html" not in body[:2000].lower():
        text = body if content_type == "text/css" else body[:MAX_TEXT_CHARS]  # CSS: scanned for colors only
        return Page(url=url, status=status, text=text, content_type=content_type)
    parser = _Extractor(url)
    try:
        parser.feed(body)
        parser.close()
    except Exception:  # malformed markup: keep whatever was parsed
        pass
    lines = []
    for line in "".join(parser.chunks).split("\n"):
        line = re.sub(r"[ \t\r\f\v ]+", " ", line).strip()
        if line and line not in ("-", "#", "##", "###") and (not lines or lines[-1] != line):
            lines.append(line)
    text = "\n".join(lines)[:MAX_TEXT_CHARS]
    meta = parser.meta
    theme = meta.get("theme-color") or meta.get("msapplication-tilecolor")
    colors = css_colors(" ".join(parser.style_buf), [theme] if theme and re.fullmatch(HEX, theme.strip()) else [])
    og = meta.get("og:image") or meta.get("twitter:image")
    return Page(
        url=url, status=status, title=squash(parser.title)[:200] or squash(meta.get("og:title", ""))[:200],
        description=squash(meta.get("description") or meta.get("og:description") or "")[:500], text=text,
        headings=parser.headings[:60], links=parser.links, og_image=urljoin(url, og) if og else None,
        theme_color=theme.strip().lower() if theme else None, colors=colors[:6],
        logo_url=parser.logo or parser.icon, stylesheets=parser.stylesheets, content_type=content_type)


def saturated(hex_color: str) -> bool:
    """True for real brand colors; greys, near-white and near-black are layout, not identity."""
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    try:
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except ValueError:
        return False
    hi, lo = max(r, g, b), min(r, g, b)
    return hi > 0.15 and lo < 0.92 and (hi - lo) / hi > 0.3


def css_colors(css: str, first=()) -> List[str]:
    """Theme color, brand custom properties, then the most used saturated hex colors."""
    colors: List[str] = [c.strip().lower() for c in first]
    brand_vars = sorted(BRAND_VAR.findall(css or ""), key=lambda nv: "brand" not in nv[0].lower())  # stable
    for _, c in brand_vars:
        c = c.strip().lower()
        if saturated(c) and c not in colors:
            colors.append(c)
    counts: Dict[str, int] = {}
    for c in re.findall(HEX, css or ""):
        c = c.lower()
        if saturated(c):
            counts[c] = counts.get(c, 0) + 1
    for c, _ in sorted(counts.items(), key=lambda kv: -kv[1]):
        if len(colors) >= 6:
            break
        if c not in colors:
            colors.append(c)
    return colors[:6]


def link_score(url: str, text: str) -> int:
    hay = (urlparse(url).path + " " + text).lower()
    score = max([w for w, pat in PRIORITY if re.search(pat, hay)] or [0])
    return score - 8 if LOW_VALUE.search(hay) else score


def link_category(url: str, text: str = "") -> str:
    """Which PRIORITY bucket a link belongs to (by the last matching path segment), for crawl diversity."""
    hay = (urlparse(url).path + " " + text).lower()
    best, best_pos = "other", -1
    for (_, pat), name in zip(PRIORITY, CATEGORIES):
        for m in re.finditer(pat, hay):
            if m.start() > best_pos:
                best, best_pos = name, m.start()
    return best


def prioritized_links(page: Page, allowed, visited=(), limit=40) -> List[Dict]:
    seen, out = set(visited), []
    for url, text in page.links:
        if url in seen or not allowed(url) or SKIP_LINK.search(urlparse(url).path) or SKIP_EXT.search(url):
            continue
        seen.add(url)
        out.append({"url": url, "text": text, "score": link_score(url, text)})
    out.sort(key=lambda d: (-d["score"], len(d["url"])))
    return out[:limit]


# --- robots.txt --------------------------------------------------------------------------------------------------
def parse_robots(text: str) -> List[Tuple[str, bool]]:
    """Rules (pattern, allow) of the group for our agent, else the `*` group."""
    groups: Dict[str, List[Tuple[str, bool]]] = {}
    agents: List[str] = []
    last_was_agent = False
    for raw in (text or "").splitlines():
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        key, value = [x.strip() for x in line.split(":", 1)]
        key = key.lower()
        if key == "user-agent":
            if not last_was_agent:
                agents = []
            agents.append(value.lower())
            for a in agents:
                groups.setdefault(a, [])
            last_was_agent = True
            continue
        last_was_agent = False
        if key in ("allow", "disallow") and agents:
            for a in agents:
                if value or key == "allow":
                    groups[a].append((value, key == "allow"))
    for name, rules in groups.items():
        if name != "*" and name in ROBOTS_AGENT:
            return rules
    return groups.get("*", [])


def robots_allows(rules: List[Tuple[str, bool]], path: str) -> bool:
    best, allowed = -1, True
    for pattern, allow in rules:
        if not pattern:
            continue
        regex = "^" + re.escape(pattern).replace(r"\*", ".*")
        if regex.endswith(r"\$"):
            regex = regex[:-2] + "$"
        if re.match(regex, path) and (len(pattern) > best or (len(pattern) == best and allow)):
            best, allowed = len(pattern), allow
    return allowed


class FetchError(Exception):
    pass


class WebFetcher:
    """One per session. `client` is injectable (tests use httpx.MockTransport)."""

    def __init__(self, client: Optional[httpx.Client] = None):
        self.client = client or httpx.Client(timeout=TIMEOUT_S, follow_redirects=False,
                                             headers={"User-Agent": USER_AGENT, "Accept": "text/html,*/*;q=0.5"})
        self.robots: Dict[str, List[Tuple[str, bool]]] = {}

    def close(self):
        self.client.close()

    def _robots(self, url: str):
        p = urlparse(url)
        key = "{}://{}".format(p.scheme, p.netloc)
        if key not in self.robots:
            rules: List[Tuple[str, bool]] = []
            try:
                r = self.client.get(key + "/robots.txt", timeout=TIMEOUT_S, follow_redirects=True)
                if r.status_code in (401, 403):
                    rules = [("/", False)]
                elif r.status_code == 200:
                    rules = parse_robots(r.text[:200_000])
            except httpx.HTTPError:
                rules = []
            self.robots[key] = rules
        return self.robots[key]

    def allowed_by_robots(self, url: str) -> bool:
        p = urlparse(url)
        return robots_allows(self._robots(url), (p.path or "/") + ("?" + p.query if p.query else ""))

    def fetch(self, url: str, allowed=None, max_redirects=5) -> Page:
        """GET with manual redirects (each hop must be allowed and robots-clean), streamed and capped."""
        current = normalize_url(url) or url
        for _ in range(max_redirects + 1):
            if allowed is not None and not allowed(current):
                raise FetchError("host not allowed for this company: {}".format(host_of(current)))
            if not self.allowed_by_robots(current):
                raise FetchError("robots.txt disallows {}".format(urlparse(current).path or "/"))
            with self.client.stream("GET", current, timeout=TIMEOUT_S) as r:
                if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                    nxt = normalize_url(r.headers["location"], current)
                    if not nxt:
                        raise FetchError("bad redirect")
                    current = nxt
                    continue
                ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
                if r.status_code == 200 and ctype and not ctype.startswith(TEXT_TYPES):
                    raise FetchError("not a text page ({})".format(ctype))
                length = int(r.headers.get("content-length") or 0)
                if length > MAX_BYTES:
                    raise FetchError("page too large ({} bytes)".format(length))
                buf = bytearray()
                for chunk in r.iter_bytes():
                    buf.extend(chunk)
                    if len(buf) > MAX_BYTES:
                        break
                encoding = r.encoding or "utf-8"
                body = bytes(buf[:MAX_BYTES]).decode(encoding, errors="replace")
                page = extract(current, body, ctype or "text/html", r.status_code)
                return page
        raise FetchError("too many redirects")


def find_dates(text: str) -> List[str]:
    return DATE_RE.findall(text or "")
