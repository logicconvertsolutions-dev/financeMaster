"""People & loans: money lent to / borrowed from contacts, from e-transfers or cash entries.

Each entry is stored from your side: negative = you sent money (lent, or repaid them), positive = you
received money (they repaid you, or lent to you). A contact's balance = -(sum of entries):
positive means they owe you, negative means you owe them.

Linked bank transactions get the "Lent / Borrowed" category (a transfer kind), so they drop out of
income and spending. Each entry keeps its own copy of date/amount/account/description, so links
survive statements being re-imported (see relink()).
"""
import re
import sqlite3
from datetime import date, timedelta

from . import categorize, scope

CATEGORY = "Lent / Borrowed"
# already accounted for elsewhere: between your own / your family's accounts, card payments, investing
EXPLAINED = ("Family Transfer", "Transfer", "Credit Card Payment", "Investment Contribution")
_ETRANSFER = re.compile(r"E-?TRANSFER|E-TFR|EMAIL TRFS|INTERAC|AUTODEPOSIT|\bEMT\b|REQUEST MONEY", re.I)
_BANK_WORDS = re.compile(
    r"^(?:INTERAC\s+)?(?:E-?TRANSFER|E-TFR|EMAIL TRFS|EMT)\s*(?:-\s*)?(?:SENT|RECEIVED|AUTODEPOSIT|AUTO-DEPOSIT|"
    r"CANCELLED|REQUEST(?:\s+FULFILLED)?)?\s*(?:-\s*)?(?:AUTODEPOSIT\s*)?", re.I)


def suggested_name(description: str) -> str:
    """Best guess at the person in an e-transfer line: "e-Transfer sent jordan LL85WQ" -> "Jordan"."""
    text = re.sub(r"\(.*?\)", " ", description)
    text = _BANK_WORDS.sub("", text.strip())
    text = re.sub(r"^(?:FROM|TO)\s+", "", text.strip(), flags=re.I)  # "FROM HUSBAND (e-Transfer ...)"
    words = [w for w in text.split()
             if not re.fullmatch(r"(?=\w*\d)[A-Z0-9]{5,}", w)   # confirmation codes like LL85WQ
             and not re.search(r"\d{3,}", w)]
    name = " ".join(words[:3])
    return name.title() if name else ""


def _keywords(contact: sqlite3.Row | dict) -> list[str]:
    words = [k.strip().upper() for k in (contact["keywords"] or "").split(",") if k.strip()]
    first = contact["name"].split()[0].upper() if contact["name"].split() else ""
    return words or ([first] if len(first) >= 3 else [])


def _link(conn: sqlite3.Connection, tx_id: int) -> None:
    conn.execute("UPDATE transactions SET category = ?, category_source = 'user', is_transfer = 1 WHERE id = ?",
                 (CATEGORY, tx_id))


def _unlink(conn: sqlite3.Connection, tx_id: int | None) -> None:
    if tx_id is None:
        return
    tx = conn.execute("SELECT t.description, t.amount, a.type FROM transactions t JOIN accounts a "
                      "ON a.id = t.account_id WHERE t.id = ?", (tx_id,)).fetchone()
    if tx is None:
        return
    rules = categorize.load_rules(conn)
    cat = categorize.categorize(tx["description"], rules) or categorize.default_category(
        tx["amount"], tx["type"], tx["description"])
    conn.execute("UPDATE transactions SET category = ?, category_source = 'rule' WHERE id = ?", (cat, tx_id))


# ---------------------------------------------------------------- contacts

def _entry_filter(conn: sqlite3.Connection) -> tuple[str, list]:
    """Entries in view: bank ones by their account's owner, cash ones belong to the primary member."""
    return scope.owner_filter(conn, "(SELECT a.member_id FROM accounts a WHERE a.id = e.account_id)")


def list_contacts(conn: sqlite3.Connection) -> dict:
    contacts = []
    clause, args = _entry_filter(conn)
    for c in conn.execute("SELECT * FROM contacts ORDER BY name COLLATE NOCASE"):
        agg = conn.execute(
            "SELECT count(*) n, coalesce(sum(CASE WHEN amount < 0 THEN -amount END), 0) sent, "
            "coalesce(sum(CASE WHEN amount > 0 THEN amount END), 0) received, max(date) last_date "
            f"FROM contact_entries e WHERE contact_id = ?{clause}", (c["id"], *args)).fetchone()
        contacts.append({**dict(c), "entries": agg["n"], "sent": round(agg["sent"], 2),
                         "received": round(agg["received"], 2), "balance": round(agg["sent"] - agg["received"], 2),
                         "last_date": agg["last_date"]})
    owed_to_me = sum(c["balance"] for c in contacts if c["balance"] > 0)
    i_owe = -sum(c["balance"] for c in contacts if c["balance"] < 0)
    return {"contacts": contacts, "owed_to_me": round(owed_to_me, 2), "i_owe": round(i_owe, 2),
            "net": round(owed_to_me - i_owe, 2)}


def save_contact(conn: sqlite3.Connection, name: str, keywords: str | None, note: str | None,
                 contact_id: int | None = None) -> int:
    name = re.sub(r"\s+", " ", name).strip()
    if not name:
        raise ValueError("Name is required")
    if contact_id:
        conn.execute("UPDATE contacts SET name = ?, keywords = ?, note = ? WHERE id = ?",
                     (name, keywords or None, note or None, contact_id))
        return contact_id
    return conn.execute("INSERT INTO contacts(name, keywords, note) VALUES (?, ?, ?)",
                        (name, keywords or None, note or None)).lastrowid


def delete_contact(conn: sqlite3.Connection, contact_id: int) -> None:
    for e in conn.execute("SELECT transaction_id FROM contact_entries WHERE contact_id = ?", (contact_id,)).fetchall():
        _unlink(conn, e["transaction_id"])
    conn.execute("DELETE FROM contact_entries WHERE contact_id = ?", (contact_id,))
    conn.execute("DELETE FROM contacts WHERE id = ?", (contact_id,))


def contact_detail(conn: sqlite3.Connection, contact_id: int) -> dict:
    c = conn.execute("SELECT * FROM contacts WHERE id = ?", (contact_id,)).fetchone()
    if c is None:
        raise KeyError(contact_id)
    clause, args = _entry_filter(conn)
    rows = conn.execute(
        "SELECT e.id, e.date, e.amount, e.note, e.transaction_id, e.account_id, e.description, "
        "a.name account FROM contact_entries e LEFT JOIN accounts a ON a.id = e.account_id "
        f"WHERE e.contact_id = ?{clause} ORDER BY e.date, e.id", (contact_id, *args)).fetchall()
    running = 0.0
    entries = []
    for r in rows:
        running += -r["amount"]
        entries.append({**dict(r), "kind": "bank" if r["account_id"] else "cash",
                        "direction": "sent" if r["amount"] < 0 else "received", "balance": round(running, 2)})
    sent = -sum(e["amount"] for e in entries if e["amount"] < 0)
    received = sum(e["amount"] for e in entries if e["amount"] > 0)
    return {"contact": dict(c), "entries": list(reversed(entries)), "sent": round(sent, 2),
            "received": round(received, 2), "balance": round(sent - received, 2)}


# ---------------------------------------------------------------- entries

def link_transaction(conn: sqlite3.Connection, contact_id: int, tx_id: int, note: str | None = None) -> int:
    tx = conn.execute("SELECT id, date, amount, account_id, description FROM transactions WHERE id = ?",
                      (tx_id,)).fetchone()
    if tx is None:
        raise KeyError(tx_id)
    existing = conn.execute("SELECT id FROM contact_entries WHERE transaction_id = ?", (tx_id,)).fetchone()
    if existing:  # move it to this contact
        conn.execute("UPDATE contact_entries SET contact_id = ? WHERE id = ?", (contact_id, existing["id"]))
        return existing["id"]
    entry = conn.execute(
        "INSERT INTO contact_entries(contact_id, transaction_id, account_id, description, date, amount, note) "
        "VALUES (?,?,?,?,?,?,?)",
        (contact_id, tx_id, tx["account_id"], tx["description"], tx["date"], tx["amount"], note)).lastrowid
    _link(conn, tx_id)
    return entry


def add_manual(conn: sqlite3.Connection, contact_id: int, day: str, amount: float, note: str | None) -> int:
    return conn.execute("INSERT INTO contact_entries(contact_id, date, amount, note) VALUES (?,?,?,?)",
                        (contact_id, day, round(amount, 2), note)).lastrowid


def delete_entry(conn: sqlite3.Connection, entry_id: int) -> None:
    e = conn.execute("SELECT transaction_id FROM contact_entries WHERE id = ?", (entry_id,)).fetchone()
    if e is None:
        raise KeyError(entry_id)
    _unlink(conn, e["transaction_id"])
    conn.execute("DELETE FROM contact_entries WHERE id = ?", (entry_id,))


def relink(conn: sqlite3.Connection) -> int:
    """Re-attach entries whose bank transaction was re-imported (and keep their category right)."""
    fixed = 0
    for e in conn.execute("SELECT * FROM contact_entries WHERE transaction_id IS NULL AND account_id IS NOT NULL"
                          ).fetchall():
        d = date.fromisoformat(e["date"])
        cands = conn.execute(
            "SELECT id, date, description FROM transactions WHERE account_id = ? AND round(amount, 2) = round(?, 2) "
            "AND date BETWEEN ? AND ? AND id NOT IN (SELECT transaction_id FROM contact_entries "
            "WHERE transaction_id IS NOT NULL)",
            (e["account_id"], e["amount"], (d - timedelta(days=3)).isoformat(), (d + timedelta(days=3)).isoformat()),
        ).fetchall()
        if not cands:
            continue
        best = min(cands, key=lambda t: (t["description"].upper() != (e["description"] or "").upper(),
                                         abs((date.fromisoformat(t["date"]) - d).days)))
        conn.execute("UPDATE contact_entries SET transaction_id = ? WHERE id = ?", (best["id"], e["id"]))
        fixed += 1
    for e in conn.execute("SELECT transaction_id FROM contact_entries WHERE transaction_id IS NOT NULL").fetchall():
        _link(conn, e["transaction_id"])
    return fixed


# ---------------------------------------------------------------- finding transactions to assign

def candidates(conn: sqlite3.Connection, q: str | None = None, limit: int = 200) -> list[dict]:
    """Unassigned transactions: e-transfers by default, or anything matching the search text."""
    contacts = conn.execute("SELECT * FROM contacts").fetchall()
    matchers = [(c, [categorize.compile_pattern(k) for k in _keywords(c)]) for c in contacts]
    sql = ("SELECT t.id, t.date, t.amount, t.description, t.category, t.category_source, a.name account "
           "FROM transactions t "
           "JOIN accounts a ON a.id = t.account_id WHERE t.id NOT IN (SELECT transaction_id FROM contact_entries "
           "WHERE transaction_id IS NOT NULL) AND a.type IN ('chequing', 'savings', 'credit')")
    clause, args = scope.account_filter()
    sql += clause
    if q:
        sql += " AND upper(t.description) LIKE ?"
        args.append(f"%{q.upper()}%")
    sql += " ORDER BY t.date DESC"
    out = []
    for t in conn.execute(sql, args):
        if not q and (not _ETRANSFER.search(t["description"]) or t["category"] in EXPLAINED
                      or (t["category_source"] == "user" and t["category"] not in ("E-Transfer Out", "Income", "Other"))):
            continue  # suggestions: only e-transfers nobody has explained yet (search still finds everything)
        padded = f" {categorize.normalize(t['description'])} "
        match = next((c for c, rxs in matchers if any(rx.search(padded) for rx in rxs)), None)
        out.append({**dict(t), "suggested_contact_id": match["id"] if match else None,
                    "suggested_contact": match["name"] if match else None,
                    "suggested_name": suggested_name(t["description"])})
        if len(out) >= limit:
            break
    return out


def balances_at(conn: sqlite3.Connection, cutoff: str) -> tuple[float, float]:
    """(owed to you, you owe) as of a date, for net worth."""
    owed, owe = 0.0, 0.0
    clause, args = _entry_filter(conn)
    for r in conn.execute(f"SELECT contact_id, -sum(amount) bal FROM contact_entries e WHERE date <= ?{clause} "
                          "GROUP BY contact_id", (cutoff, *args)):
        if r["bal"] > 0:
            owed += r["bal"]
        else:
            owe -= r["bal"]
    return round(owed, 2), round(owe, 2)
