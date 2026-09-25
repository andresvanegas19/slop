from pathlib import Path

import yaml

from contracts import SourceRecipe, WatchBrief

from .env import ROOT

DEFAULT_WATCH = ROOT / "config" / "watch.yaml"


def load_watch(path: Path = DEFAULT_WATCH) -> tuple[WatchBrief, list[SourceRecipe]]:
    """watch.yaml holds the WatchBrief under `watch` and its SourceRecipes under `sources`."""
    doc = yaml.safe_load(path.read_text())
    watch = WatchBrief(**doc["watch"])
    sources = [SourceRecipe(watch_id=watch.watch_id, **s) for s in doc.get("sources", [])]
    unknown = {s.entity_id for s in sources} - set(watch.entities)
    if unknown:
        raise ValueError("sources reference entities not in the watch brief: {}".format(sorted(unknown)))
    ids = [s.source_id for s in sources]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate source_id in {}".format(path))
    return watch, sources
