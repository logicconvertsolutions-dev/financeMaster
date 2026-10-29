"""Flag money moving between the user's own accounts so it isn't counted as spending or income."""
import re
import sqlite3
from collections import defaultdict
from datetime import date

_TRANSFER_HINT = re.compile(
    r"TRANSFER|TFR|PAYMENT|PMT|E-TRANSFER|E-TFR|WEALTHSIMPLE|QUESTRADE|CONTRIBUTION|DEPOSIT|WITHDRAWAL", re.I
)
_PERSON_TRANSFER = re.compile(r"E-TRANSFER|E-TFR|INTERAC|EMT", re.I)  # usually to/from other people
MATCH_WINDOW_DAYS = 3
FAMILY = "Family Transfer"


def _refs(description: str) -> set[str]:
    """Reference numbers banks print on both sides of a transfer ("loan payment - 7530" / "TIN0-07530")."""
    return {m[-4:] for m in re.findall(r"\d{4,}", description)}


def detect(conn: sqlite3.Connection) -> int:
    transfer_cats = {r["name"] for r in conn.execute("SELECT name FROM categories WHERE kind = 'transfer'")}
    marks = ",".join("?" * len(transfer_cats)) or "''"
    conn.execute(
        f"UPDATE transactions SET is_transfer = CASE WHEN category IN ({marks}) THEN 1 ELSE 0 END",
        tuple(transfer_cats),
    )

    txs = conn.execute(
        "SELECT t.id, t.account_id, a.type, a.member_id, t.date, t.amount, t.description, t.category_source, "
        "t.category "
        "FROM transactions t JOIN accounts a ON a.id = t.account_id "
        "WHERE coalesce(t.category, '') != 'Lent / Borrowed' ORDER BY t.date"  # already explained
    ).fetchall()
    inflows: dict[float, list] = defaultdict(list)
    for t in txs:
        if t["amount"] > 0:
            inflows[round(t["amount"], 2)].append(t)

    # score every plausible (money out, money in) pair, then take the best ones first
    candidates = []
    for out in txs:
        if out["amount"] >= 0:
            continue
        d_out = date.fromisoformat(out["date"])
        refs_out = _refs(out["description"])
        for inn in inflows.get(round(-out["amount"], 2), []):
            if inn["account_id"] == out["account_id"]:
                continue
            gap = abs((date.fromisoformat(inn["date"]) - d_out).days)
            if gap > MATCH_WINDOW_DAYS:
                continue
            hinted = bool(_TRANSFER_HINT.search(out["description"]) or _TRANSFER_HINT.search(inn["description"]))
            debt_or_invest = inn["type"] in ("credit", "investment", "loan") or out["type"] in ("loan",)
            if not (hinted or debt_or_invest):
                continue
            score = float(gap)
            if refs_out & _refs(inn["description"]):
                score -= 10  # same reference number on both sides: almost certainly the pair
            if _PERSON_TRANSFER.search(out["description"]) or _PERSON_TRANSFER.search(inn["description"]):
                score += 5   # e-transfers are usually with other people; match them last
            if hinted:
                score -= 1
            if out["member_id"] != inn["member_id"]:
                score -= 5  # an e-transfer between two family members' accounts is the pair we want
            candidates.append((score, out["date"], out, inn))
    candidates.sort(key=lambda c: (c[0], c[1]))

    used: set[int] = set()
    pairs = 0
    for _, _, out, inn in candidates:
        if out["id"] in used or inn["id"] in used:
            continue
        category = {"credit": "Credit Card Payment", "investment": "Investment Contribution"}.get(
            inn["type"], "Transfer"
        )
        if out["member_id"] != inn["member_id"]:
            category = FAMILY
        for t in (out, inn):
            if t["category_source"] == "user" and t["category"] not in transfer_cats:
                continue  # the user said this is real spending/income; respect that
            conn.execute(
                "UPDATE transactions SET is_transfer = 1, category = CASE WHEN category_source = 'user' "
                "THEN category ELSE ? END WHERE id = ?",
                (category, t["id"]),
            )
        used.update((out["id"], inn["id"]))
        pairs += 1
    pairs += _family_by_name(conn, txs, used, transfer_cats)
    return pairs


def _family_by_name(conn: sqlite3.Connection, txs, used: set[int], transfer_cats: set[str]) -> int:
    """E-transfers naming another family member count as family transfers even when the other
    person's statement isn't imported yet ("E-TRANSFER SENT SAM")."""
    people = conn.execute("SELECT id, name FROM members").fetchall()
    if len(people) < 2:
        return 0
    names = [(p["id"], re.compile(r"(?<![A-Z])" + re.escape(p["name"].split()[0].upper()) + r"(?![A-Z])"))
             for p in people if len(p["name"].split()[0]) >= 3]
    found = 0
    for t in txs:
        if t["id"] in used or t["category_source"] == "user" or t["category"] in transfer_cats:
            continue
        if not _PERSON_TRANSFER.search(t["description"]):
            continue
        text = t["description"].upper()
        if any(mid != t["member_id"] and rx.search(text) for mid, rx in names):
            conn.execute("UPDATE transactions SET is_transfer = 1, category = ? WHERE id = ?", (FAMILY, t["id"]))
            found += 1
    return found
