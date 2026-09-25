import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env(path: Path = ROOT / ".env") -> None:
    """Load KEY=value lines into os.environ without overriding real env vars."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("\"'"))


def require(name: str) -> str:
    load_env()
    value = os.environ.get(name)
    if not value:
        raise SystemExit("Missing {} (set it in .env)".format(name))
    return value
