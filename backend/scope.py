"""Whose data a request is about: one family member, several, or everyone.

The API reads `?members=1,2` into a context variable (see the middleware in app.py); the analytics
code then calls `account_filter()` so every total only includes those members' accounts.
Ownership rule: anything not tied to a specific person (a manual asset with no owner, cash entries
in People & loans, an insurance policy with no insured person, household budgets) belongs to the
primary member. So "only me" + "only my wife" always adds up exactly to "everyone", and selecting
someone with no statements changes nothing.
"""
import sqlite3
from contextlib import contextmanager
from contextvars import ContextVar

_members: ContextVar[tuple[int, ...] | None] = ContextVar("members", default=None)


def parse(value: str | None) -> tuple[int, ...] | None:
    if not value:
        return None
    ids = tuple(sorted({int(v) for v in value.split(",") if v.strip().isdigit()}))
    return ids or None


def current() -> tuple[int, ...] | None:
    """Selected member ids, or None for everyone."""
    return _members.get()


@contextmanager
def use(ids: tuple[int, ...] | None):
    token = _members.set(ids)
    try:
        yield
    finally:
        _members.reset(token)


def account_filter(alias: str = "a") -> tuple[str, list]:
    """SQL fragment (starting with AND) restricting `alias` (an accounts row) to the selection."""
    ids = current()
    if ids is None:
        return "", []
    return f" AND {alias}.member_id IN ({','.join('?' * len(ids))})", list(ids)


def primary_id(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT id FROM members WHERE is_primary = 1").fetchone()[0]


def owner_visible(conn: sqlite3.Connection, member_id: int | None) -> bool:
    """Is something owned by `member_id` (None = unassigned, i.e. the primary member's) in view?"""
    ids = current()
    if ids is None:
        return True
    return (member_id if member_id is not None else primary_id(conn)) in ids


def owner_filter(conn: sqlite3.Connection, column: str) -> tuple[str, list]:
    """SQL fragment for rows with a nullable owner column (NULL = the primary member)."""
    ids = current()
    if ids is None:
        return "", []
    return (f" AND coalesce({column}, ?) IN ({','.join('?' * len(ids))})", [primary_id(conn), *ids])


def includes_everyone(conn: sqlite3.Connection) -> bool:
    ids = current()
    if ids is None:
        return True
    all_ids = {r[0] for r in conn.execute("SELECT id FROM members")}
    return all_ids <= set(ids)
