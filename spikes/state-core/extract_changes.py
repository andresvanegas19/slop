"""Liquid step: evidence rows (RawTree `slop_human`) -> pricing facts (LFM via OpenRouter) -> diff vs state -> changes.json.

Usage:
  python3 extract_changes.py                    # read new rows from RawTree
  python3 extract_changes.py --local snapshots  # read snapshots/*.json instead (no RawTree key needed)

state.json   = the agent's memory: one belief per competitor fact. Raw pages never go in here.
changes.json = what changed this cycle; feed it to make_storyboard.py.

Noise guards (the same page scrapes differently every time):
  - facts are compared as numbers, never raw text
  - a new value must be seen CONFIRMATIONS times before it replaces a belief
  - a plan must be missing MISSING_TO_RETRACT times in a row before it's retracted
  - rows with status != ok are skipped: a blocked page is "no information", not "plan removed"
  - if the pricing section hash is unchanged, the last reading is reused instead of calling Liquid
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from smoke_test import RAWTREE_BASE, TABLE, load_env, post

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = os.environ.get("LIQUID_MODEL", "liquid/lfm-2.5-2.6b:free")
CONFIRMATIONS = int(os.environ.get("CONFIRMATIONS", "2"))
MISSING_TO_RETRACT = 2
MAX_PAGE_CHARS = 14000
# Test rows written during the spike. RawTree can't delete rows, so they're filtered out here.
EXCLUDED_RUNS = ("run_20260925T194641Z", "run_20260925T194801Z")

EXTRACT_PROMPT = """You extract pricing facts from a SaaS pricing page.
Return ONLY JSON, no commentary:
{{"plans": [{{"name": "<plan name exactly as on page>", "price_monthly_usd": <number or null>, "unit": "<per member/month, flat/month, custom>"}}]}}
Rules: if monthly and yearly prices are both shown, use the monthly-billing price. Use null for "Contact sales" or custom pricing.

Company: {competitor}
Page:
{content}
"""

WORDING_PROMPT = """Write copy for one competitor change. Return ONLY JSON, no commentary:
{{"headline": "<max 6 words, include the key number>", "summary": "<one sentence, max 25 words>", "spoken": "<max 10 words for a voiceover, numbers written as words>"}}
Change: {desc}
"""


def llm(prompt, key, max_tokens=4000):
    # LFM 2.5 always reasons before answering; max_tokens must cover reasoning + answer.
    body = {"model": MODEL, "messages": [{"role": "user", "content": prompt}],
            "temperature": 0, "max_tokens": max_tokens, "reasoning": {"effort": "low"}}
    for attempt in range(4):
        status, res, _ = post(OPENROUTER_URL, key, body)
        if status == 200:
            return res["choices"][0]["message"]["content"] or ""
        if status == 429:  # free tier rate limit
            time.sleep(8 * (attempt + 1))
            continue
        raise RuntimeError("OpenRouter HTTP {}: {}".format(status, res))
    raise RuntimeError("OpenRouter still rate-limited after retries")


def parse_json(text):
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        return None


def competitor_of(row):
    if row.get("entity_name") or row.get("competitor"):
        return row.get("entity_name") or row["competitor"]
    host = urlparse(row["url"]).hostname or row["url"]
    parts = [p for p in host.split(".") if p not in ("www", "app")]
    return parts[0].capitalize() if parts else host


def trim(content):
    i = content.find("$")  # pricing usually starts near the first price
    start = max(0, i - 2000) if i >= 0 else 0
    return content[start:start + MAX_PAGE_CHARS]


def page_text(row):
    return row.get("markdown") or row.get("content") or ""


def extract_facts(row, key):
    out = parse_json(llm(EXTRACT_PROMPT.format(competitor=competitor_of(row), content=trim(page_text(row))), key))
    facts = {}
    for p in (out or {}).get("plans", []):
        name = re.sub(r"[^a-z0-9 ]", "", str(p.get("name", "")).lower()).strip()  # "Plus*" -> "plus"
        price = p.get("price_monthly_usd")
        if not name:
            continue
        try:
            price = None if price is None else round(float(price), 2)
        except (TypeError, ValueError):
            price = None
        facts["pricing.{}.monthly_usd".format(name)] = {"value": price, "unit": p.get("unit")}
    return facts


def same(a, b):
    if a is None or b is None:
        return a == b
    return abs(a - b) < 0.01


def plan_of(field):
    return field.split(".")[1].title()


def describe(comp, cat, field, old, new):
    plan = plan_of(field)
    if cat == "new_plan":
        return "{} added a new {} plan at {}.".format(comp, plan, fmt(new))
    if cat == "deprecation":
        return "{} removed its {} plan (was {}).".format(comp, plan, fmt(old))
    return "{} changed its {} plan from {} to {} per month.".format(comp, plan, fmt(old), fmt(new))


def fmt(v):
    return "custom pricing" if v is None else "${:g}".format(v)


def score(cat, old, new):
    if cat in ("price_cut", "price_increase") and old:
        pct = abs(new - old) / old * 100
        return round(min(0.95, 0.5 + pct / 50), 2), pct
    return {"new_plan": 0.8, "deprecation": 0.85, "pricing_model": 0.7}.get(cat, 0.5), None


def word(change, key):
    """Liquid writes the copy; fall back to templates if the small model returns junk."""
    desc = describe(change["competitor"], change["category"], change["field"], change["old_value"], change["new_value"])
    copy = parse_json(llm(WORDING_PROMPT.format(desc=desc), key, max_tokens=1500)) or {}
    spoken = str(copy.get("spoken", ""))
    if not spoken or len(spoken.split()) > 10:
        spoken = "{} {}.".format(change["competitor"], {
            "price_cut": "cut {} pricing".format(plan_of(change["field"])),
            "price_increase": "raised {} pricing".format(plan_of(change["field"])),
            "new_plan": "launched a new {} plan".format(plan_of(change["field"])),
            "deprecation": "dropped its {} plan".format(plan_of(change["field"])),
        }.get(change["category"], "changed pricing"))
    change["headline"] = str(copy.get("headline") or desc)[:60]
    change["summary"] = str(copy.get("summary") or desc)
    change["spoken"] = spoken


def make_change(comp, cat, field, old, new, obs, evidence):
    importance, _ = score(cat, old, new)
    return {
        "change_id": "chg_{}_{}".format(re.sub(r"\W", "", comp.lower()), hashlib.sha1((field + str(new)).encode()).hexdigest()[:6]),
        "competitor": comp, "category": cat, "field": field, "old_value": old, "new_value": new,
        "evidence": evidence, "confidence": 0.9, "importance": importance,
        "opportunity": cat in ("price_increase", "deprecation"),
        "detected_at": obs["fetched_at"],
    }


def apply_observation(state, comp, facts, obs):
    """Diff one observation's facts against beliefs. Returns accepted changes."""
    beliefs = state["beliefs"].setdefault(comp, {})
    baseline = comp not in state["baselined"]
    obs_id, now = obs["obs_id"], obs["fetched_at"]
    changes = []

    for field, f in facts.items():
        b = beliefs.get(field)
        if b is None:
            # After the baseline, a new plan is unconfirmed until seen CONFIRMATIONS times.
            beliefs[field] = {"value": f["value"], "unit": f["unit"], "last_verified": now,
                              "evidence": [obs_id], "confirmations": 1, "missing": 0, "unconfirmed": not baseline}
            continue
        b["missing"] = 0
        if same(b["value"], f["value"]):
            b.update(last_verified=now, confirmations=b["confirmations"] + 1, evidence=(b["evidence"] + [obs_id])[-3:])
            b.pop("pending", None)
            if b.get("unconfirmed") and b["confirmations"] >= CONFIRMATIONS:
                b.pop("unconfirmed")
                changes.append(make_change(comp, "new_plan", field, None, b["value"], obs, list(b["evidence"])))
            continue
        # Value differs: hold it as pending until it's seen CONFIRMATIONS times.
        p = b.get("pending")
        if p and same(p["value"], f["value"]):
            p["seen"] += 1
            p["evidence"].append(obs_id)
        else:
            b["pending"] = p = {"value": f["value"], "seen": 1, "evidence": [obs_id]}
        if p["seen"] >= CONFIRMATIONS:
            old, new = b["value"], p["value"]
            if old is None or new is None:
                cat = "pricing_model"
            else:
                cat = "price_cut" if new < old else "price_increase"
            changes.append(make_change(comp, cat, field, old, new, obs, p["evidence"]))
            beliefs[field] = {"value": new, "unit": f["unit"], "last_verified": now,
                              "evidence": p["evidence"][-3:], "confirmations": p["seen"], "missing": 0}

    for field in list(beliefs):
        if field not in facts:
            if beliefs[field].get("unconfirmed"):  # a one-off misreading, never reported: just forget it
                del beliefs[field]
                continue
            beliefs[field]["missing"] = beliefs[field].get("missing", 0) + 1
            if beliefs[field]["missing"] >= MISSING_TO_RETRACT:
                changes.append(make_change(comp, "deprecation", field, beliefs[field]["value"], None, obs, [obs_id]))
                del beliefs[field]

    state["baselined"] = sorted(set(state["baselined"]) | {comp})
    return changes


def read_rawtree(key, since):
    sql = ("SELECT obs_id, entity_name, url, toString(fetched_at) AS fetched_at, status, markdown, "
           "`section_hashes.pricing` AS pricing_hash FROM {} "
           "WHERE toString(fetched_at) > '{}' AND toString(run_id) NOT IN ({}) ORDER BY fetched_at").format(
               TABLE, since, ", ".join("'{}'".format(r) for r in EXCLUDED_RUNS))
    status, res, _ = post(RAWTREE_BASE + "/query", key, {"sql": sql})
    if status != 200:
        sys.exit("RawTree query failed: HTTP {} {}".format(status, res))
    rows = res.get("data", []) if isinstance(res, dict) else res
    if rows and isinstance(rows[0], list):
        cols = [m["name"] for m in res.get("meta", [])]
        rows = [dict(zip(cols, r)) for r in rows]
    return rows


def read_local(folder, since):
    rows = [json.load(open(p)) for p in sorted(Path(folder).glob("*.json"))]
    return sorted([r for r in rows if str(r["fetched_at"]) > since], key=lambda r: str(r["fetched_at"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", help="folder of snapshot JSON files instead of RawTree")
    ap.add_argument("--market", default="Project management SaaS")
    ap.add_argument("--state", default="state.json")
    ap.add_argument("--out", default="changes.json")
    args = ap.parse_args()

    load_env()
    or_key = os.environ.get("OPENROUTER_API_KEY")
    if not or_key:
        sys.exit("Missing in .env: OPENROUTER_API_KEY (free at openrouter.ai/keys)")

    state_path = Path(args.state)
    state = json.load(open(state_path)) if state_path.exists() else \
        {"cursor": "1970-01-01 00:00:00", "baselined": [], "beliefs": {}}
    state.setdefault("last_reading", {})  # per competitor: pricing hash + facts it produced

    if args.local:
        rows = read_local(args.local, state["cursor"])
    else:
        rt_key = os.environ.get("RAWTREE_API_KEY")
        if not rt_key:
            sys.exit("Missing in .env: RAWTREE_API_KEY (or run with --local snapshots)")
        rows = read_rawtree(rt_key, state["cursor"])
    print("{} new observations since {}".format(len(rows), state["cursor"]))

    started = rows[0]["fetched_at"] if rows else state["cursor"]
    changes, noise, skipped, llm_calls = [], 0, 0, 0
    for row in rows:
        comp = competitor_of(row)
        state["cursor"] = str(row["fetched_at"])
        if row.get("status", "ok") != "ok":
            skipped += 1
            print("  {:<12} skipped (status={})".format(comp, row["status"]))
            continue
        last = state["last_reading"].get(comp)
        h = row.get("pricing_hash")
        if h and last and last["hash"] == h:
            facts, how = last["facts"], "same pricing section, reused last reading"
        else:
            facts, how = extract_facts(row, or_key), "read by Liquid"
            llm_calls += 1
            state["last_reading"][comp] = {"hash": h, "facts": facts}
        found = apply_observation(state, comp, facts, row)
        noise += 0 if found else 1
        changes += found
        print("  {:<12} {} plans ({}), {} changes".format(comp, len(facts), how, len(found)))

    for c in changes:
        word(c, or_key)

    state_json = json.dumps(state, indent=2)
    state_path.write_text(state_json)
    changed = {c["competitor"] for c in changes}
    out = {
        "cycle_id": "cyc_" + time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()),
        "market": args.market,
        "window": {"from": str(started), "to": state["cursor"]},
        "stats": {
            "competitors_tracked": len(state["beliefs"]),
            "observations_ingested": len(rows),
            "observations_discarded_as_noise": noise,
            "observations_skipped_bad_status": skipped,
            "liquid_calls": llm_calls,
            "state_tokens": len(state_json) // 4,
        },
        "changes": changes,
        "unchanged": sorted(set(state["beliefs"]) - changed),
    }
    json.dump(out, open(args.out, "w"), indent=2)
    print("wrote {}: {} changes, state is ~{} tokens".format(args.out, len(changes), len(state_json) // 4))


if __name__ == "__main__":
    main()
