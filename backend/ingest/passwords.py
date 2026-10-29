"""Remembered PDF passwords, kept in Windows Credential Manager (never in the database).

The database only stores the labels, so we know which Credential Manager entries to try.
"""
import json
import sqlite3

import keyring

SERVICE = "finance-dashboard-pdf"
_LABELS_KEY = "pdf_password_labels"


def labels(conn: sqlite3.Connection) -> list[str]:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (_LABELS_KEY,)).fetchone()
    return json.loads(row["value"]) if row else []


def _save_labels(conn: sqlite3.Connection, names: list[str]) -> None:
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_LABELS_KEY, json.dumps(names)),
    )


def remembered(conn: sqlite3.Connection) -> list[str]:
    out = []
    for label in labels(conn):
        try:
            pw = keyring.get_password(SERVICE, label)
        except Exception:
            pw = None
        if pw:
            out.append(pw)
    return out


def remember(conn: sqlite3.Connection, label: str, password: str) -> None:
    keyring.set_password(SERVICE, label, password)
    names = labels(conn)
    if label not in names:
        _save_labels(conn, [*names, label])


def forget(conn: sqlite3.Connection, label: str) -> None:
    try:
        keyring.delete_password(SERVICE, label)
    except Exception:
        pass
    _save_labels(conn, [n for n in labels(conn) if n != label])
