"""Deleting statements, and deleting or merging accounts.

Deleted statement files are moved to statements/_deleted/ (never erased), so a wrong click can be
undone by moving the file back and rescanning.
"""
import shutil
import sqlite3
from datetime import date, timedelta
from pathlib import Path

from ..config import STATEMENTS_DIR, abs_path, rel_path
from .model import ParsedTx
from .scanner import DUPLICATE_WINDOW_DAYS, _take_duplicate

DELETED_DIR_NAME = "_deleted"


def deleted_dir() -> Path:
    return STATEMENTS_DIR / DELETED_DIR_NAME


def _move_to_deleted(rel: str) -> str | None:
    src = abs_path(rel)
    if not src.exists():
        return None
    target_dir = deleted_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    dest = target_dir / src.name
    i = 1
    while dest.exists():
        dest = target_dir / f"{src.stem} ({i}){src.suffix}"
        i += 1
    shutil.move(str(src), str(dest))
    return rel_path(dest)


def delete_statement_file(conn: sqlite3.Connection, statement_id: int) -> dict:
    """Remove a file's data (every account it covered) and move the file to statements/_deleted/."""
    row = conn.execute("SELECT file_hash, path FROM statements WHERE id = ?", (statement_id,)).fetchone()
    if row is None:
        raise KeyError(statement_id)
    ids = [r["id"] for r in conn.execute("SELECT id FROM statements WHERE file_hash = ?", (row["file_hash"],))]
    removed = 0
    for sid in ids:
        removed += conn.execute("DELETE FROM transactions WHERE statement_id = ?", (sid,)).rowcount
        conn.execute("DELETE FROM balance_snapshots WHERE statement_id = ?", (sid,))
        conn.execute("DELETE FROM holdings WHERE statement_id = ?", (sid,))
    conn.execute("DELETE FROM statements WHERE file_hash = ?", (row["file_hash"],))
    conn.execute("DELETE FROM files WHERE file_hash = ?", (row["file_hash"],))
    moved_to = _move_to_deleted(row["path"])
    return {"transactions_removed": removed, "parts": len(ids), "moved_to": moved_to}


def account_usage(conn: sqlite3.Connection, account_id: int) -> dict:
    return {
        "transactions": conn.execute("SELECT count(*) FROM transactions WHERE account_id = ?", (account_id,)).fetchone()[0],
        "statements": conn.execute("SELECT count(*) FROM statements WHERE account_id = ?", (account_id,)).fetchone()[0],
    }


def delete_account(conn: sqlite3.Connection, account_id: int, delete_files: bool) -> dict:
    """Delete an account and everything imported into it.

    Its statement files are either moved to _deleted/ (delete_files) or kept but marked Ignored, so the
    next rescan doesn't import them again and re-create the account.
    """
    if not conn.execute("SELECT 1 FROM accounts WHERE id = ?", (account_id,)).fetchone():
        raise KeyError(account_id)
    usage = account_usage(conn, account_id)
    statements = conn.execute("SELECT id, file_hash FROM statements WHERE account_id = ?", (account_id,)).fetchall()
    moved = 0
    for s in statements:
        # a bank export can cover several accounts; only move the file if nothing else uses it
        others = conn.execute("SELECT count(*) FROM statements WHERE file_hash = ? AND id != ? "
                              "AND coalesce(account_id, -1) != ?", (s["file_hash"], s["id"], account_id)).fetchone()[0]
        if delete_files and not others:
            delete_statement_file(conn, s["id"])
            moved += 1
        else:
            conn.execute("UPDATE statements SET status = 'ignored', account_id = NULL, staged_json = NULL, "
                         "message = 'Account deleted.' WHERE id = ?", (s["id"],))
    for table in ("transactions", "balance_snapshots", "holdings"):
        conn.execute(f"DELETE FROM {table} WHERE account_id = ?", (account_id,))
    conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
    return {**usage, "files_moved": moved}


def merge_accounts(conn: sqlite3.Connection, source_id: int, target_id: int) -> dict:
    """Move everything from source into target, drop transactions target already had, delete source."""
    if source_id == target_id:
        raise ValueError("Pick a different account to merge into.")
    for aid in (source_id, target_id):
        if not conn.execute("SELECT 1 FROM accounts WHERE id = ?", (aid,)).fetchone():
            raise KeyError(aid)

    moving = conn.execute("SELECT id, date, amount, description FROM transactions WHERE account_id = ? "
                          "ORDER BY date, id", (source_id,)).fetchall()
    duplicates = 0
    if moving:
        lo = (date.fromisoformat(moving[0]["date"]) - timedelta(days=DUPLICATE_WINDOW_DAYS)).isoformat()
        hi = (date.fromisoformat(moving[-1]["date"]) + timedelta(days=DUPLICATE_WINDOW_DAYS)).isoformat()
        pool: dict[float, list[dict]] = {}
        for r in conn.execute("SELECT id, date, amount, upper(description) description FROM transactions "
                              "WHERE account_id = ? AND date BETWEEN ? AND ?", (target_id, lo, hi)):
            pool.setdefault(round(r["amount"], 2), []).append(dict(r))
        for t in moving:
            if _take_duplicate(pool, ParsedTx(t["date"], t["description"], t["amount"])):
                conn.execute("DELETE FROM transactions WHERE id = ?", (t["id"],))
                duplicates += 1
    moved = conn.execute("UPDATE transactions SET account_id = ? WHERE account_id = ?",
                         (target_id, source_id)).rowcount
    conn.execute("UPDATE OR IGNORE balance_snapshots SET account_id = ? WHERE account_id = ?", (target_id, source_id))
    conn.execute("DELETE FROM balance_snapshots WHERE account_id = ?", (source_id,))  # same-day clashes
    conn.execute("UPDATE holdings SET account_id = ? WHERE account_id = ?", (target_id, source_id))
    conn.execute("UPDATE statements SET account_id = ? WHERE account_id = ?", (target_id, source_id))
    # keep useful details the target is missing
    conn.execute(
        "UPDATE accounts SET credit_limit = coalesce(credit_limit, (SELECT credit_limit FROM accounts WHERE id = :s)), "
        "interest_rate = coalesce(interest_rate, (SELECT interest_rate FROM accounts WHERE id = :s)), "
        "payment = coalesce(payment, (SELECT payment FROM accounts WHERE id = :s)), "
        "registration = coalesce(registration, (SELECT registration FROM accounts WHERE id = :s)) WHERE id = :t",
        {"s": source_id, "t": target_id})
    last4 = conn.execute("SELECT last4 FROM accounts WHERE id = ?", (source_id,)).fetchone()["last4"]
    conn.execute("DELETE FROM accounts WHERE id = ?", (source_id,))
    if last4:  # the target may have had no last4 before
        conn.execute("UPDATE accounts SET last4 = coalesce(last4, ?) WHERE id = ?", (last4, target_id))
    return {"moved": moved, "duplicates_removed": duplicates}
