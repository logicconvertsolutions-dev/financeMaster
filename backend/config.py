"""Filesystem locations. Everything lives inside the project folder.

Set FINANCE_HOME to point statements/, data/ and backups/ somewhere else (used by tests and the demo).
"""
import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
ROOT = Path(os.environ["FINANCE_HOME"]).resolve() if os.environ.get("FINANCE_HOME") else APP_DIR
STATEMENTS_DIR = ROOT / "statements"
DATA_DIR = ROOT / "data"
BACKUP_DIR = ROOT / "backups"
DB_PATH = DATA_DIR / "finance.db"
FRONTEND_DIST = APP_DIR / "frontend" / "dist"

HOST = "127.0.0.1"
PORT = 8765

STATEMENT_EXTENSIONS = {".pdf", ".csv", ".xlsx", ".xls"}


def code_version() -> float:
    """Newest modification time of the app's code (backend + built dashboard), to spot stale servers."""
    files = list((APP_DIR / "backend").rglob("*.py")) + list(FRONTEND_DIST.rglob("*"))
    return max((f.stat().st_mtime for f in files if f.is_file()), default=0.0)
