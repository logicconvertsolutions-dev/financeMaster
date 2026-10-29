"""Bills that repeat every month (rent, utilities, phone, insurance, subscriptions, loan payments),
learned from your own history, and when each is next expected.

A charge is recurring when the same merchant shows up in at least 3 of the last 4 months, about
once a month, for a similar amount, around the same day of the month. Nothing is entered by hand.
"""
import sqlite3
import statistics
from collections import defaultdict
from datetime import date, timedelta

from . import analytics as an

LOOKBACK = 4
MIN_MONTHS = 3
AMOUNT_TOLERANCE = 0.25   # amounts within 25% of the typical one
DAY_TOLERANCE = 6         # posted within ~a week of the usual day


def _clamp_day(month: str, day: int) -> date:
    last = int(an.month_end(month)[-2:])
    return date.fromisoformat(f"{month}-{min(day, last):02d}")


def bills(conn: sqlite3.Connection, today: date | None = None) -> list[dict]:
    today = today or date.today()
    this_month = today.strftime("%Y-%m")
    months = [an.shift_month(this_month, -i) for i in range(LOOKBACK, -1, -1)]  # 4 past months + this one
    rows = an.cashflow_rows(conn, months[0], this_month)
    # Credit card payments are transfers (not in cashflow rows) but are real bills too
    from . import scope
    clause, args = scope.account_filter()
    transfers = [dict(r) for r in conn.execute(
        "SELECT t.date, substr(t.date,1,7) month, t.merchant, t.amount, t.category, a.name account, "
        "a.type account_type, m.name member "
        "FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN members m ON m.id = a.member_id "
        "WHERE a.type IN ('chequing','savings') AND t.amount < 0 AND a.archived = 0 "
        f"AND t.category IN ('Credit Card Payment','Investment Contribution') AND t.date >= ?{clause}",
        [f"{months[0]}-01", *args])]
    seen: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for r in [*rows, *transfers]:
        if r["amount"] >= 0 or r.get("kind") in ("income", "ignore"):
            continue
        seen[r["merchant"]][r["month"]].append(r)
    out = []
    past = months[:-1]
    for merchant, per_month in seen.items():
        hist = [per_month[m] for m in past if m in per_month]
        if len(hist) < MIN_MONTHS or any(len(v) > 2 for v in hist):
            continue  # not often enough, or everyday shopping
        amounts = [-sum(x["amount"] for x in v) for v in hist]
        typical = statistics.median(amounts)
        if typical < 5 or any(abs(a - typical) > AMOUNT_TOLERANCE * typical for a in amounts[-3:]):
            continue
        days = [int(v[0]["date"][8:10]) for v in hist]
        day = int(statistics.median(days))
        if max(abs(d - day) for d in days[-3:]) > DAY_TOLERANCE:
            continue
        last = hist[-1][-1]
        paid_this_month = this_month in per_month
        due = _clamp_day(an.shift_month(this_month, 1) if paid_this_month else this_month, day)
        overdue = not paid_this_month and due < today - timedelta(days=DAY_TOLERANCE)
        if overdue:
            due = _clamp_day(an.shift_month(this_month, 1), day)  # probably skipped or not imported yet
        out.append({
            "merchant": merchant, "category": last.get("category"), "account": last.get("account"),
            "on_card": last.get("account_type") == "credit",  # paid through the card payment, not separately
            "member": last.get("member"), "amount": round(typical, 2), "day": day, "next_date": due.isoformat(),
            "days_away": (due - today).days, "paid_this_month": paid_this_month, "not_seen_yet": due < today,
            "months_seen": len(hist), "last_amount": round(amounts[-1], 2),
        })
    out.sort(key=lambda b: b["next_date"])
    return out


def upcoming(conn: sqlite3.Connection, days: int = 30, today: date | None = None) -> dict:
    every = bills(conn, today)
    items = [b for b in every if b["days_away"] <= days]
    # money leaving your bank accounts: bills charged to a card are covered by the card payment
    return {"days": days, "items": items, "total": round(sum(b["amount"] for b in items if not b["on_card"]), 2),
            "monthly_total": round(sum(b["amount"] for b in every if not b["on_card"]), 2),
            "on_card_total": round(sum(b["amount"] for b in every if b["on_card"]), 2)}
