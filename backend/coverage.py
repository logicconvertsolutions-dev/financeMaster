"""Which months are fully covered by statements, per account and overall.

A month is "complete" when every account that should have data for it (it has statements around
that month) has statements covering the whole month. The current month is usually partial: some
statements aren't out yet. Pages default to the latest complete month and label partial ones, so a
half-imported month never looks like "income $0, spending down 80%".
"""
import sqlite3
from datetime import date, timedelta

from . import analytics as an
from . import scope

SLACK_DAYS = 5  # exports end at the last transaction, not the month end; allow a few quiet days
EXPORT_SUFFIXES = (".csv", ".xlsx", ".xls")
EXPORT_TRUST_DAYS = 35
MINOR_SHARE = 0.05  # accounts carrying under 5% of your spending/income don't block a month
INACTIVE_DAYS = 45  # no statement for this long before a month: the account isn't expected in it


def _file_date(rel: str) -> date | None:
    from .config import abs_path
    try:
        return date.fromtimestamp(abs_path(rel).stat().st_mtime)
    except OSError:
        return None


def _intervals(conn: sqlite3.Connection) -> dict[int, list[tuple[date, date]]]:
    clause, args = scope.account_filter("a")
    out: dict[int, list] = {}
    for r in conn.execute(
        "SELECT s.account_id, s.period_start, s.period_end, s.path, s.imported_at FROM statements s "
        "JOIN accounts a ON a.id = s.account_id "
        "WHERE s.status = 'parsed' AND s.period_start IS NOT NULL AND s.period_end IS NOT NULL AND a.archived = 0 "
        f"AND a.type != 'investment'{clause}", args):
        start, end = date.fromisoformat(r["period_start"]), date.fromisoformat(r["period_end"])
        if r["path"].lower().endswith(EXPORT_SUFFIXES):
            # a transaction export ends at its last transaction but covers up to the day it was
            # downloaded (the file's date; copying keeps it), so trust it up to the day before
            downloaded = _file_date(r["path"]) or date.fromisoformat(r["imported_at"][:10])
            downloaded -= timedelta(days=1)
            if end <= downloaded <= end + timedelta(days=EXPORT_TRUST_DAYS):
                end = downloaded
        out.setdefault(r["account_id"], []).append((start, end))
    for v in out.values():
        v.sort()
    return out


def _merged(iv: list[tuple[date, date]]) -> list[tuple[date, date]]:
    merged: list[list[date]] = []
    for s, e in iv:
        if merged and s <= merged[-1][1] + timedelta(days=SLACK_DAYS):
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged]


def account_month(iv: list[tuple[date, date]], month: str) -> str:
    """'full' | 'partial' | 'none' | 'n/a' (before the account's first statement)."""
    first = date.fromisoformat(f"{month}-01")
    last = date.fromisoformat(an.month_end(month))
    if not iv or iv[0][0] > last:
        return "n/a"
    blocks = _merged(iv)
    if first > blocks[-1][1] + timedelta(days=INACTIVE_DAYS):
        return "n/a"  # statements stopped long before: closed, or you stopped tracking it
    start_needed = max(first, blocks[0][0])  # an account opened mid-month only needs the rest of it
    for s, e in blocks:
        if s <= start_needed + timedelta(days=SLACK_DAYS) and e >= last - timedelta(days=SLACK_DAYS):
            return "full"
    if any(s <= last and e >= first for s, e in blocks):
        return "partial"
    return "none"


def grid(conn: sqlite3.Connection, months: int = 12) -> dict:
    ivs = _intervals(conn)
    clause, args = scope.account_filter("a")
    accts = {r["id"]: dict(r) for r in conn.execute(
        "SELECT a.id, a.name, a.type, m.name member FROM accounts a LEFT JOIN members m ON m.id = a.member_id "
        f"WHERE a.archived = 0 AND a.type != 'investment'{clause} ORDER BY m.is_primary DESC, a.name", args)}
    all_months = an.data_months(conn)
    today = date.today().strftime("%Y-%m")
    if all_months and all_months[-1] < today:
        all_months = an.month_range(all_months[0], today)
    window = all_months[-months:]
    rows = []
    for aid, a in accts.items():
        iv = ivs.get(aid, [])
        if not iv:
            continue  # balance-only accounts have no statements to cover anything
        cells = {m: account_month(iv, m) for m in window}
        rows.append({**a, "cells": cells, "last_end": iv[-1][1].isoformat()})
    # how much of your everyday money flows through each account: a quiet savings account whose
    # export stops mid-month shouldn't hold the whole month back
    weight = {r["account_id"]: r["w"] for r in conn.execute(
        "SELECT account_id, sum(abs(amount)) w FROM transactions WHERE is_transfer = 0 AND date >= ? "
        "GROUP BY account_id", (f"{window[0]}-01" if window else "0000",))}
    status = {}
    for m in window:
        expected = [r for r in rows if r["cells"][m] != "n/a"]
        full = [r for r in expected if r["cells"][m] == "full"]
        total = sum(weight.get(r["id"], 0) for r in expected)
        gap = sum(weight.get(r["id"], 0) for r in expected if r["cells"][m] != "full")
        status[m] = {"complete": bool(full) and (gap <= MINOR_SHARE * total if total else len(full) == len(expected)),
                     "expected": len(expected), "covered": len(full),
                     "missing": [r["name"] for r in expected if r["cells"][m] != "full"]}
    return {"months": window, "accounts": rows, "status": status}


def latest_complete_month(conn: sqlite3.Connection) -> str | None:
    """Latest month every account with statements has fully covered (None if none is)."""
    g = grid(conn, 24)
    done = [m for m in g["months"] if g["status"][m]["complete"]]
    return done[-1] if done else None


def month_status(conn: sqlite3.Connection, month: str) -> dict:
    g = grid(conn, 24)
    return g["status"].get(month, {"complete": True, "expected": 0, "covered": 0, "missing": []})
