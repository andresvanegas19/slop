"""A text ReAct agent on LangChain primitives. Liquid LFM (free) has no reliable native tool calling, so the model
writes `Action:` / `Action Input:` lines, code runs the tool, and the result comes back as an `Observation:`.

The final answer is validated into a contracts CompanyContext and grounded: claims may only cite beliefs and
evidence ids the run actually saw. If the model fails, a deterministic brief is built from the same tools.
"""
import ast
import hashlib
import json
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Optional, Tuple

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from contracts import AgentRunRecord, AgentToolCall, CompanyContext, ContextClaim, ModelCallRecord
from contracts.agent import MAX_BRIEF_CHARS
from core.liquid import parse_json

from .tools import CompanyTools

MAX_PROMPT_CHARS = 2000
MAX_CLAIMS = 8
STOP = ["\nObservation:", "\nObservation :"]

ACTION_RE = re.compile(r"^\s*(?:\*\*)?Action(?:\*\*)?\s*:\s*(?:\*\*)?\s*`?([A-Za-z_][A-Za-z0-9_]*)`?", re.M)
INPUT_RE = re.compile(r"^\s*(?:\*\*)?Action Input(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)", re.M | re.S)
NATIVE_RE = re.compile(r"<\|tool_call_start\|>(.*?)(?:<\|tool_call_end\|>|$)", re.S)
SPECIAL_TOKEN_RE = re.compile(r"<\|[a-z_]+\|>")
FINAL_RE = re.compile(r"(?:\*\*)?Final Answer(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)", re.S)

SYSTEM = """You are the company intelligence agent of a video studio. RawTree is your database and the tools below read it.
Your job: gather what is true about the tracked companies right now so a video writer can use it.

Tools:
{tools}

Answer in this exact format, one tool per turn:
Thought: <one short sentence>
Action: <tool name>
Action Input: <JSON object with the arguments, {{}} if none>

Then STOP and wait for the Observation. When you know enough, answer:
Thought: I can answer.
Final Answer: {{"brief": "<plain prose, at most 900 characters>", "entities": ["<entity_id>"], "claims": [{{"text": "<one fact>", "belief_key": "<belief_key from an observation>", "evidence_ids": ["<id from an observation>"]}}]}}

Rules:
- Use only facts from Observations. Never invent numbers, companies or ids.
- Copy belief_key and evidence ids exactly as they appear.
- The brief says who is tracked, what is true now and what changed recently, in words a narrator can say.
"""

LOOP_TASK = ("Refresh the company context. Look at the current beliefs and the recent changes (use several tools), "
             "then write the Final Answer.")

PROMPT_TASK = """A user is about to create a {kind} with this request:
\"\"\"{prompt}\"\"\"
Gather the company facts that are relevant to it with the tools (get_recent_videos shows what was made before, get_user_context what this user asked for before), then write the Final Answer focused on what this {kind} should say or show."""

MEMORY = "\nYour latest brief (may be stale, verify with tools): {brief}"


def _now():
    return datetime.now(timezone.utc)


def describe_tools(tools):
    lines = []
    for t in tools:
        props = t.args_schema.model_json_schema().get("properties", {}) if t.args_schema else {}
        args = ", ".join("{}: {}".format(k, v.get("description", v.get("type", ""))) for k, v in props.items())
        lines.append("- {}({}): {}".format(t.name, args, t.description))
    return "\n".join(lines)


def loose_json(text: str):
    """parse_json, plus repair of what small models emit: a truncated object or a wrong closer (`])` for `]}`)."""
    got = parse_json(text)
    if isinstance(got, dict):
        return got
    start = (text or "").find("{")
    if start < 0:
        return None
    stack, out, in_str, escape = [], [], False, False
    for ch in text[start:]:
        if in_str:
            out.append(ch)
            escape = ch == "\\" and not escape
            if ch == '"' and not escape:
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}])":
            if not stack:
                break
            ch = stack.pop()
        out.append(ch)
        if not stack:
            break
    candidate = "".join(out) + ('"' if in_str else "") + "".join(reversed(stack))
    try:
        got = json.loads(candidate)
    except ValueError:
        return None
    return got if isinstance(got, dict) else None


def parse_native_call(text: str):
    """LFM's own tool syntax: `<|tool_call_start|>[get_current_beliefs(entity_id="notion")]<|tool_call_end|>`.
    Parsed with ast (literals only, never evaluated). Returns (name, args) for the first call, or None."""
    m = NATIVE_RE.search(text or "")
    if not m:
        return None
    body = m.group(1).strip()
    try:
        tree = ast.parse(body if body.startswith("[") else "[{}]".format(body), mode="eval")
    except SyntaxError:
        return None
    calls = [c for c in getattr(tree.body, "elts", []) if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)]
    if not calls:
        return None
    args = {}
    for kw in calls[0].keywords:
        try:
            if kw.arg:
                args[kw.arg] = ast.literal_eval(kw.value)
        except ValueError:
            continue
    return calls[0].func.id, args


def parse_step(text: str):
    """Returns ("action", name, args) | ("final", payload) | ("none",). Tolerates markdown bold and stray text,
    and LFM's native tool-call tokens."""
    text = text or ""
    native = parse_native_call(text)
    if native:
        return ("action", native[0], native[1])
    action, final = ACTION_RE.search(text), FINAL_RE.search(text)
    if action and (not final or action.start() < final.start()):
        m = INPUT_RE.search(text, action.end())
        raw = m.group(1).strip() if m else ""
        args = parse_json(raw) if "{" in raw else {}
        return ("action", action.group(1), args if isinstance(args, dict) else {})
    if final:
        body = final.group(1).strip()
        payload = loose_json(body)
        if not isinstance(payload, dict) or not payload.get("brief"):
            payload = {"brief": body}
        return ("final", payload)
    return ("none",)


def _text(message) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, list):
        content = "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return content or ""


class CompanyAgent:
    def __init__(self, settings, llm, rawtree=None, store=None):
        self.settings, self.llm, self.rawtree, self.store = settings, llm, rawtree, store

    # --- public -------------------------------------------------------------
    def run(self, trigger="loop", prompt: Optional[str] = None, kind: Optional[str] = None,
            is_test=False, user_id: Optional[str] = None) -> Tuple[CompanyContext, AgentRunRecord]:
        started = _now()
        run = AgentRunRecord(agent_run_id=("test_" if is_test else "agent_") + uuid.uuid4().hex[:16],
                             trigger=trigger, started_at=started, is_test=is_test)
        tools = CompanyTools(self.settings, self.rawtree, self.store, user_id=user_id)
        payload = None
        if self.llm is not None:
            try:
                payload = self._react(tools, run, prompt, kind)
            except Exception as e:  # network / provider failure: fall back, never crash the loop
                run.ok, run.error = False, "{}: {}".format(type(e).__name__, str(e)[:300])
        if payload is None:
            payload = self._fallback(tools, run)
        ctx = self._context(payload, tools, run, trigger, kind)
        run = run.model_copy(update={"finished_at": _now(), "context_id": ctx.context_id})
        if self.store is not None:
            self.store.save_context(ctx)
            self.store.record_run(run)
        return ctx, run

    # --- ReAct loop ------------------------------------------------------------
    def _react(self, tools: CompanyTools, run: AgentRunRecord, prompt, kind):
        lc_tools = {t.name: t for t in tools.langchain_tools()}
        task = LOOP_TASK if not prompt else PROMPT_TASK.format(kind=kind or "video", prompt=prompt[:MAX_PROMPT_CHARS])
        last = self.store.latest_context() if self.store is not None else None
        if last is not None:
            task += MEMORY.format(brief=last.brief)
        messages = [SystemMessage(SYSTEM.format(tools=describe_tools(lc_tools.values()))), HumanMessage(task)]
        used_chars, nudged = 0, False

        for step in range(1, self.settings.max_steps + 2):
            text = self._call(messages, run)
            parsed = parse_step(text)
            if parsed[0] == "final":
                return parsed[1]
            if parsed[0] == "none":
                if nudged:
                    prose = SPECIAL_TOKEN_RE.sub("", text).strip()
                    return {"brief": prose} if len(prose) >= 40 else None
                nudged = True
                messages += [AIMessage(text), HumanMessage("Reply with an Action line or a Final Answer line.")]
                continue

            _, name, args = parsed
            if step > self.settings.max_steps or used_chars >= self.settings.context_chars:
                messages += [AIMessage(text), HumanMessage("Tool budget reached. Write the Final Answer now.")]
                continue
            run.steps = step
            observation, call = self._tool(lc_tools, name, args, step)
            run.tool_calls.append(call)
            observation = observation[: max(0, self.settings.context_chars - used_chars)] or '{"error": "budget"}'
            used_chars += len(observation)
            # Replay the step in canonical ReAct form so the model sees one consistent format.
            messages += [AIMessage("Action: {}\nAction Input: {}".format(name, json.dumps(args, default=str))),
                         HumanMessage("Observation: " + observation)]

        messages.append(HumanMessage("Stop using tools. Write the Final Answer now."))
        parsed = parse_step(self._call(messages, run))
        return parsed[1] if parsed[0] == "final" else None

    def _call(self, messages, run: AgentRunRecord) -> str:
        t0 = time.time()
        error, message = None, None
        try:
            message = self.llm.invoke(messages, stop=STOP)
        except Exception as e:
            error = "{}: {}".format(type(e).__name__, str(e)[:200])
        usage = getattr(message, "usage_metadata", None) or {}
        details = usage.get("output_token_details") or {}
        run.llm_calls += 1
        run.input_tokens += usage.get("input_tokens", 0) or 0
        run.output_tokens += usage.get("output_tokens", 0) or 0
        if self.store is not None:
            self.store.record_model_call(ModelCallRecord(
                call_id=hashlib.sha256("{}|{}|{}".format(run.agent_run_id, run.llm_calls, t0).encode())
                .hexdigest()[:24],
                run_id=run.agent_run_id, purpose="agent_react", model=self.settings.model,
                input_tokens=usage.get("input_tokens", 0) or 0, output_tokens=usage.get("output_tokens", 0) or 0,
                reasoning_tokens=details.get("reasoning", 0) or 0, latency_ms=int((time.time() - t0) * 1000),
                ok=error is None, error=error))
        if error:
            raise RuntimeError(error)
        return _text(message)

    def _tool(self, lc_tools, name, args, step):
        tool = lc_tools.get(name)
        if tool is None:
            obs = json.dumps({"error": "unknown tool {!r}; use one of {}".format(name, sorted(lc_tools))})
            return obs, AgentToolCall(step=step, tool=name[:64], ok=False, error="unknown tool")
        try:
            obs = tool.invoke(args or {})
        except Exception as e:  # argument validation errors
            obs = json.dumps({"error": "bad arguments: {}".format(str(e)[:300])})
        ok = '"error"' not in obs[:20]
        return obs, AgentToolCall(step=step, tool=name, ok=ok, input_chars=len(json.dumps(args or {})),
                                  output_chars=len(obs), error=None if ok else obs[:200])

    # --- grounding & fallback -----------------------------------------------------
    def _fallback(self, tools: CompanyTools, run: AgentRunRecord):
        """No LLM (or it failed): a deterministic brief from beliefs and the watch brief."""
        names = {}
        try:
            names = tools.entity_names()
            objective = tools.watch()[0].objective
        except Exception:
            objective = ""
        claims = []
        try:
            for s in tools.get_current_beliefs()["slices"]:
                for b in s["beliefs"]:
                    if b.get("value") is None:
                        continue
                    claims.append({"text": "{} {}: {} {}".format(
                        names.get(s["entity_id"], s["entity_id"]), b["attribute"].split(".")[1].title()
                        if b["attribute"].count(".") >= 2 else b["attribute"], b["value"], b.get("unit") or "").strip(),
                        "belief_key": b["belief_key"], "evidence_ids": b.get("evidence_ids", [])[-2:]})
        except Exception as e:
            run.error = run.error or "fallback: {}".format(str(e)[:200])
        run.tool_calls.append(AgentToolCall(step=0, tool="get_current_beliefs", ok=True))
        facts = "; ".join(c["text"] for c in claims[:MAX_CLAIMS])
        made = ""
        try:
            videos = tools.get_recent_videos(3)["videos"]
            made = "; ".join("{} ({}s)".format(v.get("title") or v.get("prompt", "untitled"),
                                               v.get("duration_sec", "?")) for v in videos)
            if videos:
                run.tool_calls.append(AgentToolCall(step=0, tool="get_recent_videos", ok=True))
        except Exception:
            made = ""
        brief = " ".join(filter(None, [
            objective, "Tracked: {}.".format(", ".join(names.values())) if names else "",
            "Current facts: {}.".format(facts) if facts else "", "Recently made: {}.".format(made) if made else ""]))
        return {"brief": brief or "No company data is available yet.", "claims": claims[:MAX_CLAIMS],
                "entities": list(names), "_deterministic": True}

    def _context(self, payload, tools: CompanyTools, run: AgentRunRecord, trigger, kind) -> CompanyContext:
        claims = []
        for c in payload.get("claims") or []:
            if not isinstance(c, dict) or not str(c.get("text", "")).strip():
                continue
            key = c.get("belief_key") if c.get("belief_key") in tools.seen_beliefs else None
            evidence = [e for e in (c.get("evidence_ids") or []) if isinstance(e, str) and e in tools.seen_evidence]
            if key and not evidence:
                evidence = tools.seen_beliefs[key].evidence_ids[-2:]
            claims.append(ContextClaim(text=str(c["text"]).strip()[:280], belief_key=key, evidence_ids=evidence))
            if len(claims) >= MAX_CLAIMS:
                break
        try:
            known = tools.entity_ids()
        except Exception:
            known = []
        entities = [e for e in (payload.get("entities") or []) if e in known] or sorted(
            {b.entity_id for b in tools.seen_beliefs.values()})
        brief = re.sub(r"\s+", " ", SPECIAL_TOKEN_RE.sub("", str(payload.get("brief", "")))).strip()
        brief = brief[:MAX_BRIEF_CHARS] or "No brief."
        at = _now()
        state_version = tools.state_version
        return CompanyContext(context_id=CompanyContext.make_id(trigger, at, brief), generated_at=at, trigger=trigger,
                              kind=kind, entities=entities, brief=brief, claims=claims, state_version=state_version,
                              tools_used=sorted({t.tool for t in run.tool_calls if t.error != "unknown tool"}), model=self.settings.model
                              if self.llm is not None and run.llm_calls and not payload.get("_deterministic")
                              else "deterministic")
