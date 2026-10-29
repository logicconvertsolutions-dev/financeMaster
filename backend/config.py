"""Filesystem locations. Everything lives inside the project folder.

Set FINANCE_HOME to point statements/, data/ and backups/ somewhere else (used by tests and the demo).
Set FINANCE_STATEMENTS_DIR to read statements from another folder, e.g. G:\\My Drive\\Finance\\statements,
while the database stays on this PC (a live SQLite file in a sync folder can be corrupted).
"""
import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
ROOT = Path(os.environ["FINANCE_HOME"]).resolve() if os.environ.get("FINANCE_HOME") else APP_DIR
_STATEMENTS_ENV = os.environ.get("FINANCE_STATEMENTS_DIR", "").strip().strip('"')
STATEMENTS_DIR = Path(_STATEMENTS_ENV).expanduser().resolve() if _STATEMENTS_ENV else ROOT / "statements"
DATA_DIR = ROOT / "data"
BACKUP_DIR = ROOT / "backups"
DB_PATH = DATA_DIR / "finance.db"
FRONTEND_DIST = APP_DIR / "frontend" / "dist"

HOST = "127.0.0.1"
PORT = 8765

STATEMENT_EXTENSIONS = {".pdf", ".csv", ".xlsx", ".xls"}


def rel_path(path: Path) -> str:
    """How the database stores a file: "statements/..." wherever the statements folder really is."""
    try:
        return "statements/" + path.relative_to(STATEMENTS_DIR).as_posix()
    except ValueError:
        return path.relative_to(ROOT).as_posix()


def abs_path(rel: str) -> Path:
    """Inverse of rel_path."""
    if rel.startswith("statements/"):
        return STATEMENTS_DIR / rel[len("statements/"):]
    return ROOT / rel


def code_version() -> float:
    """Newest modification time of the app's code (backend + built dashboard), to spot stale servers."""
    files = list((APP_DIR / "backend").rglob("*.py")) + list(FRONTEND_DIST.rglob("*"))
    return max((f.stat().st_mtime for f in files if f.is_file()), default=0.0)
