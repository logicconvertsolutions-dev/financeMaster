"""Family comparison: each person side by side, plus the household, for one month.

Reuses the Monthly review for each person (by narrowing the scope to them), so every figure here
matches what that person's own view shows.
"""
import sqlite3
from collections import defaultdict

from . import analytics as an
from . import insights, scope


def _people(conn: sqlite3.Connection) -> list[dict]:
    """Viewed people who have at least one account (an empty member adds nothing to compare)."""
    owners = {r[0] for r in conn.execute("SELECT DISTINCT member_id FROM accounts WHERE archived = 0")}
    return [p for p in an.scoped_members(conn) if p["id"] in owners]


def _best_month(conn: sqlite3.Connection, people: list[dict]) -> str | None:
    """Latest month in which the most people have statements (so the comparison isn't lopsided)."""
    have: dict[str, int] = defaultdict(int)
    for p in people:
        with scope.use((p["id"],)):
            for m in an.data_months(conn):
                have[m] += 1
    if not have:
        return None
    most = max(have.values())
    return max(m for m, n in have.items() if n == most)


_ZERO = {"income": 0, "expenses": 0, "net": 0, "savings_rate": None, "essential": 0, "discretionary": 0, "prev": None}


def _person_review(conn: sqlite3.Connection, member_id: int, month: str) -> dict:
    with scope.use((member_id,)):
        r = insights.review(conn, month, include_people=False)
        nw = an.balances_at(conn, an.month_end(month))["net_worth"]
    if r.get("month") != month:  # nothing for this person in that month: don't show another month's data
        r = {"scorecard": dict(_ZERO), "categories": [], "increases": [], "family_transfers": None,
             "months_available": r.get("months_available", [])}
    return {**r, "net_worth_at_month_end": nw}


def compare(conn: sqlite3.Connection, month: str | None = None) -> dict:
    people = _people(conn)
    if month is None:
        month = _best_month(conn, people)
    household = insights.review(conn, month, include_people=False)
    if household.get("empty"):
        return {"empty": True, "people": [{"id": p["id"], "name": p["name"], "color": p["color"]} for p in people]}
    month = household["month"]
    kinds = an.category_kinds(conn)

    cards, by_cat = [], defaultdict(dict)
    essentials_paid: dict[str, float] = {}
    for p in people:
        r = _person_review(conn, p["id"], month)
        sc = r.get("scorecard") or dict(_ZERO)
        prev = sc.get("prev") or {}
        cards.append({
            "id": p["id"], "name": p["name"], "color": p["color"],
            "income": sc["income"], "expenses": sc["expenses"], "net": sc["net"], "savings_rate": sc["savings_rate"],
            "essential": sc.get("essential", 0), "discretionary": sc.get("discretionary", 0),
            "expenses_change": round(sc["expenses"] - prev["expenses"], 2) if prev else None,
            "net_worth": r.get("net_worth_at_month_end"),
            "top_increase": (r.get("increases") or [None])[0],
            "family_sent": (r.get("family_transfers") or {}).get("sent", 0),
            "family_received": (r.get("family_transfers") or {}).get("received", 0),
            "has_data": month in (r.get("months_available") or []),
        })
        for c in r.get("categories", []):
            if c["kind"] in ("essential", "discretionary") and c["this"]:
                by_cat[c["category"]][p["name"]] = c["this"]
        essentials_paid[p["name"]] = sc.get("essential", 0)

    total_ess = sum(essentials_paid.values())
    categories = sorted(
        ({"category": c, "kind": kinds.get(c, "discretionary"), "by_person": v, "total": round(sum(v.values()), 2)}
         for c, v in by_cat.items()), key=lambda x: -x["total"])
    hs = household["scorecard"]
    return {
        "month": month,
        "months_available": household["months_available"],
        "people": cards,
        "household": {"income": hs["income"], "expenses": hs["expenses"], "net": hs["net"],
                      "savings_rate": hs["savings_rate"], "net_worth": hs.get("net_worth")},
        "essentials": [{"name": k, "amount": round(v, 2), "share": round(v / total_ess, 4) if total_ess else None}
                       for k, v in essentials_paid.items()],
        "categories": categories,
    }


def people_lines(conn: sqlite3.Connection, month: str) -> list[dict]:
    """Per-person one-liners for the Monthly review when several people are being viewed."""
    out = []
    for p in _people(conn):
        r = _person_review(conn, p["id"], month)
        sc = r.get("scorecard")
        if not sc:
            continue
        top = (r.get("increases") or [None])[0]
        out.append({"name": p["name"], "color": p["color"], "income": sc["income"], "expenses": sc["expenses"],
                    "savings_rate": sc["savings_rate"],
                    "note": f"{top['category']} up ${top['delta']:,.0f} vs usual" if top else None})
    return out
