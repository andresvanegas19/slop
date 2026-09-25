"""Company agent CLI. RawTree = database, Liquid (OpenRouter) = brain, contracts/ = tools.

  python -m agent worker                      # loop + local trigger on 127.0.0.1:8765 (Ctrl-C to stop)
  python -m agent worker --run-core           # also run one core cycle per tick (new RawTree evidence -> beliefs)
  python -m agent worker --publish            # also deliver the outbox to RawTree (rows are PERMANENT)
  python -m agent once                        # one loop tick, print the context
  python -m agent ask "a launch video for our pricing change" --kind video
  python -m agent show                        # latest cached context
  python -m agent publish                     # deliver queued agent events to RawTree (permanent!)
  python -m agent research "a video for Coca-Cola" [--rounds 1] [--competitors]   # one research session, events printed

The worker also serves research sessions: POST /research {prompt} -> {session_id}; competitor research, the
storyline tool and first-prompt company detection live in agent/story_api.py. See agent/README.md.

Nothing is written to RawTree without --publish / publish. Keys come from the repository-root .env.
"""
import argparse
import json
import logging
import signal
import sys
import threading

from .config import load_settings
from .nimble_fetch import make_fetcher
from .react import CompanyAgent
from .research import ResearchManager
from .research_store import ResearchStore
from .store import AgentStore
from .story_api import StoryService
from .worker import AgentWorker, serve


def build(args):
    settings = load_settings(interval_s=getattr(args, "interval", None), port=getattr(args, "port", None))
    store = AgentStore(settings.agent_db)
    rawtree = None
    if settings.rawtree_key:
        from core.sources import RawTreeClient
        rawtree = RawTreeClient(settings.rawtree_key)
    llm = None
    if settings.llm_enabled and not getattr(args, "no_llm", False):
        from .llm import liquid_chat_model
        llm = liquid_chat_model(settings)
    agent = CompanyAgent(settings, llm, rawtree, store)
    coordinator = None
    if getattr(args, "run_core", False):
        if not (rawtree and settings.openrouter_key):
            sys.exit("--run-core needs RAWTREE_API_KEY and OPENROUTER_API_KEY in .env")
        from core.coordinator import Coordinator
        from core.liquid import LiquidAdapter
        from core.repository import StateRepository
        from core.sources import RawTreeSource
        coordinator = Coordinator(StateRepository(settings.state_db), RawTreeSource(rawtree),
                                  LiquidAdapter(settings.openrouter_key))
    if getattr(args, "publish", False) and rawtree is None:
        sys.exit("--publish needs RAWTREE_API_KEY in .env")
    publish = getattr(args, "publish", False)
    research_llm = None
    if settings.llm_enabled and not getattr(args, "no_llm", False):
        from .llm import liquid_chat_model

        def research_llm():
            return liquid_chat_model(settings, timeout_s=180, max_tokens=settings.research_max_tokens,
                                     reasoning=settings.research_reasoning)
    research = ResearchManager(settings, ResearchStore(settings.agent_db), llm_factory=research_llm, outbox=store,
                               rawtree=rawtree if publish else None, publish=publish, reader=rawtree,
                               fetcher_factory=make_fetcher)
    detect_llm = None
    if research_llm is not None:
        from .llm import liquid_chat_model

        def detect_llm():
            return liquid_chat_model(settings, timeout_s=30, max_tokens=2048, reasoning="low")
    story = StoryService(settings, research, llm_factory=research_llm, detect_llm_factory=detect_llm)
    worker = AgentWorker(settings, agent, store, coordinator, rawtree, publish=publish, research=research,
                         story=story)
    return settings, store, agent, worker


def run_research(worker, args):
    import time
    manager = worker.research
    sid = manager.start(args.prompt, looping=args.rounds > 1)
    session, after = manager.get(sid), 0
    while True:
        for e in manager.store.events(sid, after=after):
            after = e["seq"]
            print(json.dumps(e, ensure_ascii=False, default=str)[:600], flush=True)
        if session.state.stats.rounds >= args.rounds and session.state.looping:
            manager.set_looping(sid, False)
        if not session.alive() and manager.finished(sid):
            break
        time.sleep(0.5)
    if args.competitors and manager.store.load(sid).profile is not None:
        worker.story.start_competitors(sid)
        worker.story.jobs[sid].join()
        for e in manager.store.events(sid, after=after):
            after = e["seq"]
            print(json.dumps(e, ensure_ascii=False, default=str)[:600], flush=True)
    view = manager.view(sid)
    view.update(worker.story.extras(sid))
    print(json.dumps(view, indent=2, ensure_ascii=False, default=str))


def print_context(ctx, stale=None):
    print(json.dumps({"context": ctx.model_dump(mode="json"), **({} if stale is None else {"stale": stale})},
                     indent=2, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("worker", help="run the loop and the local HTTP trigger")
    w.add_argument("--interval", type=int, help="seconds between ticks (AGENT_INTERVAL_S, default 300)")
    w.add_argument("--port", type=int, help="local trigger port (AGENT_PORT, default 8765)")
    for p in (w, sub.add_parser("once", help="one loop tick")):
        p.add_argument("--run-core", action="store_true", help="run one core cycle per tick")
        p.add_argument("--publish", action="store_true", help="deliver the outbox to RawTree (permanent)")
        p.add_argument("--no-llm", action="store_true", help="deterministic brief only, no OpenRouter calls")
    a = sub.add_parser("ask", help="one prompt-triggered run")
    a.add_argument("prompt")
    a.add_argument("--kind", default="video")
    a.add_argument("--no-llm", action="store_true")
    r = sub.add_parser("research", help="run one research session in this process and print its events")
    r.add_argument("prompt")
    r.add_argument("--rounds", type=int, default=1, help="rounds (RESEARCH_MAX_ROUNDS caps it)")
    r.add_argument("--publish", action="store_true", help="write research events to RawTree (permanent)")
    r.add_argument("--competitors", action="store_true", help="then research the company's competitors (Nimble)")
    r.add_argument("--no-llm", action="store_true")
    sub.add_parser("show", help="print the latest cached context")
    sub.add_parser("publish", help="deliver queued agent events to RawTree (permanent)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    settings, store, agent, worker = build(args)
    if args.cmd == "show":
        ctx = store.latest_context()
        return print_context(ctx) if ctx else print("no context yet; run `python -m agent once`")
    if args.cmd == "publish":
        if worker.rawtree is None:
            sys.exit("Missing RAWTREE_API_KEY in .env")
        return print("published {} agent events to RawTree".format(store.deliver(worker.rawtree)))
    if args.cmd == "ask":
        ctx, run = agent.run("prompt", prompt=args.prompt, kind=args.kind)
        print_context(ctx)
        return print("steps {} · llm calls {} · tokens in/out {}/{}".format(
            run.steps, run.llm_calls, run.input_tokens, run.output_tokens), file=sys.stderr)
    if args.cmd == "research":
        return run_research(worker, args)
    if args.cmd == "once":
        summary = worker.tick()
        print(json.dumps(summary, indent=2))
        ctx = store.latest_context()
        return print_context(ctx) if ctx else None

    server = serve(worker, settings.port)
    print("company agent: model {} · llm {} · rawtree {} · trigger http://127.0.0.1:{}/context · every {}s".format(
        settings.model, "on" if agent.llm else "off", "on" if worker.rawtree else "off", settings.port,
        settings.interval_s))
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    worker.story.run_watcher(stop)  # starts competitor research once a new session has its company profile
    try:
        worker.run_forever(stop)  # main thread: core's SQLite connection is not shared across threads
    finally:
        server.shutdown()
        worker.pool.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
