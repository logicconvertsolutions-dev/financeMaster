"""Family members and groups.

A member is a top-level folder under statements\\ (statements\\Sam\\2026-09\\...). Files directly in
statements\\ or in a statements\\YYYY-MM\\ folder belong to the primary member until they choose a
folder name for themselves (move_primary_files).
"""
import json
import re
import shutil
import sqlite3
from pathlib import Path

from .config import ROOT, STATEMENTS_DIR

_MONTH_FOLDER = re.compile(r"^\d{4}-\d{2}$")
RESERVED = {"_deleted"}
PALETTE = ["#4f7d3a", "#2a78d6", "#b0703a", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7", "#e34948"]


def primary_id(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT id FROM members WHERE is_primary = 1").fetchone()["id"]


def folder_of(path: Path) -> str | None:
    """The member folder a statement file sits in, or None for the top level."""
    try:
        parts = path.resolve().relative_to(STATEMENTS_DIR.resolve()).parts
    except ValueError:
        return None
    if len(parts) < 2 or parts[0] in RESERVED or _MONTH_FOLDER.match(parts[0]):
        return None
    return parts[0]


def member_for_path(conn: sqlite3.Connection, path: Path) -> int:
    """Member owning a statement file; a new folder name creates a new member."""
    folder = folder_of(path)
    if folder is None:
        return primary_id(conn)
    row = conn.execute("SELECT id FROM members WHERE lower(folder) = lower(?)", (folder,)).fetchone()
    if row:
        return row["id"]
    row = conn.execute("SELECT id FROM members WHERE lower(name) = lower(?) AND folder IS NULL", (folder,)).fetchone()
    if row:  # a member created by hand before their folder existed
        conn.execute("UPDATE members SET folder = ? WHERE id = ?", (folder, row["id"]))
        return row["id"]
    name = folder
    while conn.execute("SELECT 1 FROM members WHERE name = ?", (name,)).fetchone():
        name += " (2)"
    n = conn.execute("SELECT count(*) FROM members").fetchone()[0]
    return conn.execute("INSERT INTO members(name, folder, color) VALUES (?, ?, ?)",
                        (name, folder, PALETTE[n % len(PALETTE)])).lastrowid


def list_members(conn: sqlite3.Connection) -> list[dict]:
    out = []
    for m in conn.execute("SELECT * FROM members ORDER BY is_primary DESC, name COLLATE NOCASE"):
        stats = conn.execute(
            "SELECT count(DISTINCT a.id) accounts, count(t.id) transactions FROM accounts a "
            "LEFT JOIN transactions t ON t.account_id = a.id WHERE a.member_id = ?", (m["id"],)).fetchone()
        folder = f"statements\\{m['folder']}" if m["folder"] else "statements (top level)"
        out.append({**dict(m), "accounts": stats["accounts"], "transactions": stats["transactions"],
                    "folder_path": folder})
    return out


def create_member(conn: sqlite3.Connection, name: str, folder: str | None) -> int:
    name = name.strip()
    folder = _clean_folder(folder or name)
    n = conn.execute("SELECT count(*) FROM members").fetchone()[0]
    mid = conn.execute("INSERT INTO members(name, folder, color) VALUES (?, ?, ?)",
                       (name, folder, PALETTE[n % len(PALETTE)])).lastrowid
    (STATEMENTS_DIR / folder).mkdir(parents=True, exist_ok=True)
    return mid


def update_member(conn: sqlite3.Connection, member_id: int, name: str | None, color: str | None) -> None:
    if name is not None:
        conn.execute("UPDATE members SET name = ? WHERE id = ?", (name.strip(), member_id))
    if color is not None:
        conn.execute("UPDATE members SET color = ? WHERE id = ?", (color, member_id))


def delete_member(conn: sqlite3.Connection, member_id: int) -> None:
    """Only for members with no accounts (e.g. a folder created by mistake)."""
    m = conn.execute("SELECT is_primary FROM members WHERE id = ?", (member_id,)).fetchone()
    if m is None:
        raise KeyError(member_id)
    if m["is_primary"]:
        raise ValueError("The primary member can't be removed.")
    if conn.execute("SELECT 1 FROM accounts WHERE member_id = ?", (member_id,)).fetchone():
        raise ValueError("Move or delete this person's accounts first.")
    conn.execute("DELETE FROM members WHERE id = ?", (member_id,))
    for g in conn.execute("SELECT id, member_ids FROM member_groups").fetchall():
        ids = [i for i in json.loads(g["member_ids"]) if i != member_id]
        conn.execute("UPDATE member_groups SET member_ids = ? WHERE id = ?", (json.dumps(ids), g["id"]))


def _clean_folder(folder: str) -> str:
    folder = re.sub(r'[<>:"/\\|?*]', "", folder).strip().strip(".")
    if not folder or folder.lower() in RESERVED or _MONTH_FOLDER.match(folder):
        raise ValueError("Pick a different folder name.")
    return folder


def move_primary_files(conn: sqlite3.Connection, name: str) -> dict:
    """Give the primary member a name + folder and move their top-level files into it."""
    pid = primary_id(conn)
    folder = _clean_folder(name)
    other = conn.execute("SELECT id FROM members WHERE lower(folder) = lower(?) AND id != ?", (folder, pid)).fetchone()
    if other:
        raise ValueError(f"statements\\{folder} already belongs to someone else.")
    conn.execute("UPDATE members SET name = ?, folder = ? WHERE id = ?", (name.strip(), folder, pid))
    target = STATEMENTS_DIR / folder
    target.mkdir(parents=True, exist_ok=True)
    moved = 0
    for path in sorted(STATEMENTS_DIR.iterdir()):
        if path == target or path.name in RESERVED:
            continue
        if path.is_dir() and not _MONTH_FOLDER.match(path.name):
            continue  # another member's folder
        if path.is_dir():  # a month folder: move its files, merging into any existing one
            for f in path.rglob("*"):
                if f.is_file():
                    moved += _move_file(conn, f, target / f.relative_to(STATEMENTS_DIR))
            shutil.rmtree(path, ignore_errors=True)
        else:
            moved += _move_file(conn, path, target / path.name)
    return {"folder": f"statements\\{folder}", "files_moved": moved}


def _move_file(conn: sqlite3.Connection, src: Path, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest = dest.with_name(f"{dest.stem} (moved){dest.suffix}")
    old = src.relative_to(ROOT).as_posix()
    shutil.move(str(src), str(dest))
    new = dest.relative_to(ROOT).as_posix()
    conn.execute("UPDATE statements SET path = ? WHERE path = ?", (new, old))
    conn.execute("UPDATE files SET path = ? WHERE path = ?", (new, old))
    return 1


# ---------------------------------------------------------------- groups

def list_groups(conn: sqlite3.Connection) -> list[dict]:
    return [{"id": g["id"], "name": g["name"], "member_ids": json.loads(g["member_ids"])}
            for g in conn.execute("SELECT * FROM member_groups ORDER BY name COLLATE NOCASE")]


def save_group(conn: sqlite3.Connection, name: str, member_ids: list[int], group_id: int | None = None) -> int:
    ids = sorted(set(member_ids))
    if len(ids) < 2:
        raise ValueError("A group needs at least two people.")
    if group_id:
        conn.execute("UPDATE member_groups SET name = ?, member_ids = ? WHERE id = ?",
                     (name.strip(), json.dumps(ids), group_id))
        return group_id
    return conn.execute("INSERT INTO member_groups(name, member_ids) VALUES (?, ?)",
                        (name.strip(), json.dumps(ids))).lastrowid


def organize_by_month(conn: sqlite3.Connection) -> int:
    """Move each statement into the month folder it belongs to (the month its period ends in).

    Only files already sitting in a month folder (statements\[person\]YYYY-MM\) are moved, so a
    layout you arranged yourself is left alone. Uploads land in the current month first; this puts
    an August statement uploaded in September into ...\2026-08\.
    """
    moved = 0
    rows = conn.execute(
        "SELECT path, max(period_end) period_end FROM statements WHERE status IN ('parsed', 'needs_review') "
        "AND period_end IS NOT NULL GROUP BY path").fetchall()
    for r in rows:
        src = ROOT / r["path"]
        month = r["period_end"][:7]
        if not src.exists() or not _MONTH_FOLDER.match(src.parent.name) or src.parent.name == month:
            continue
        try:
            src.parent.relative_to(STATEMENTS_DIR)
        except ValueError:
            continue
        moved += _move_file(conn, src, src.parent.parent / month / src.name)
        try:
            src.parent.rmdir()  # drop the old month folder if it's now empty
        except OSError:
            pass
    return moved
