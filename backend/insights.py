"""Monthly review: comparisons, watch list, wins, suggested cutdowns and alerts.

All feedback is rule-based and computed locally from the user's own history. Savings figures are
estimates ("if this category went back to your usual level"), not advice.
"""
import re
import sqlite3
import statistics
from collections import defaultdict
from datetime import date, timedelta

from . import analytics as an
from . import coverage, insurance, scope

INCREASE_MIN_DOLLARS = 50.0
INCREASE_MIN_PCT = 0.25
HABIT_MIN_COUNT = 6
HABIT_MAX_TICKET = 30.0
LARGE_TX_MIN = 250.0
# money that left but says nothing about what it was for: ask, don't judge
UNEXPLAINED = ("E-Transfer Out", "Cash Withdrawal")

VIDEO_STREAMING = re.compile(r"NETFLIX|DISNEY|CRAVE|PRIME VIDEO|APPLE TV|PARAMOUNT|DAZN|BRITBOX|HAYU|YOUTUBE PREMIUM|YOUTUBE TV")

FEE_ADVICE = [
    (re.compile(r"INTEREST", re.I), "Credit card interest",
     "Interest means the full statement balance wasn't paid. Paying the full balance by the due date avoids it."),
    (re.compile(r"NSF|OVERDRAFT|OVERLIMIT|OVER LIMIT", re.I), "Overdraft / NSF fees",
     "Keep a small buffer in chequing or set up a low-balance alert."),
    (re.compile(r"FOREIGN|FX", re.I), "Foreign transaction fees",
     "A no-foreign-transaction-fee card (e.g. Scotiabank Passport, Wealthsimple, some Rogers/Home Trust cards) avoids the ~2.5% markup."),
    (re.compile(r"ATM|ABM|NETWORK", re.I), "ATM fees",
     "Use your own bank's ATMs, or get cash back at a grocery checkout."),
    (re.compile(r"ANNUAL FEE", re.I), "Annual card fee",
     "Check whether the card's rewards beat its fee; many banks will downgrade to a no-fee card."),
    (re.compile(r"MONTHLY|PLAN FEE|SERVICE CHARGE|MAINTENANCE|ACCOUNT FEE", re.I), "Bank account fees",
     "No-fee chequing exists (EQ Bank, Tangerine, Simplii, KOHO), or check the minimum balance that waives the fee."),
]


def _months_before(months: list[str], month: str, n: int) -> list[str]:
    prior = [m for m in months if m < month]
    return prior[-n:]


def review(conn: sqlite3.Connection, month: str | None = None, include_people: bool = True) -> dict:
    months = an.data_months(conn)
    if not months:
        return {"month": None, "months_available": [], "empty": True}
    grid = coverage.grid(conn, 24)
    complete = [m for m in months if grid["status"].get(m, {}).get("complete")]
    default = complete[-1] if complete else months[-1]
    month = month if month in months else default
    status = grid["status"].get(month, {"complete": True, "expected": 0, "covered": 0, "missing": []})
    partial = not status["complete"] and status["expected"] > 0
    # the baseline is complete months only: a half-imported month would make everything look "up"
    base_months = _months_before([m for m in months if m in complete or m not in grid["status"]], month, 3)
    prev_month = base_months[-1] if base_months else None
    window_start = _months_before(months, month, 12)[:1] or [month]

    rows = an.cashflow_rows(conn, window_start[0], month)
    totals = an.monthly_totals(rows)
    kinds = an.category_kinds(conn)
    budgets = an.budgets(conn)

    cur = totals.get(month, {"income": 0, "expenses": 0, "by_category": {}, "savings_rate": None, "net": 0})
    prev = totals.get(prev_month) if prev_month else None

    def avg_of(cat: str) -> float | None:
        if not base_months:
            return None
        return sum(totals.get(m, {}).get("by_category", {}).get(cat, 0.0) for m in base_months) / len(base_months)

    # ---- category comparison table
    cats = set(cur["by_category"])
    for m in base_months:
        cats |= set(totals.get(m, {}).get("by_category", {}))
    table = []
    for c in cats:
        this = cur["by_category"].get(c, 0.0)
        avg = avg_of(c)
        last = prev["by_category"].get(c, 0.0) if prev else None
        table.append({
            "category": c, "kind": kinds.get(c, "discretionary"), "this": round(this, 2),
            "last": round(last, 2) if last is not None else None,
            "avg3": round(avg, 2) if avg is not None else None,
            "delta": round(this - avg, 2) if avg is not None else None,
            "pct": round((this - avg) / avg, 4) if avg else None,
            "budget": budgets.get(c),
        })
    table.sort(key=lambda r: -r["this"])

    month_rows = [r for r in rows if r["month"] == month]
    base_rows = [r for r in rows if r["month"] in base_months]

    increases, decreases = [], []
    for r in table:
        if r["avg3"] is None or r["kind"] not in ("essential", "discretionary"):
            continue
        threshold = max(INCREASE_MIN_DOLLARS, INCREASE_MIN_PCT * r["avg3"])
        if r["delta"] >= threshold:
            increases.append({**r, "detail": _merchant_driver(r["category"], month_rows, base_rows, len(base_months))})
        elif -r["delta"] >= threshold and not partial:  # "down" in a half-imported month means nothing
            decreases.append({**r, "detail": None})
    increases.sort(key=lambda r: -r["delta"])
    decreases.sort(key=lambda r: r["delta"])

    subs = subscriptions(rows, month, kinds)
    cutdowns = _cutdowns(table, subs, month_rows, budgets, large_purchases(rows, month_rows, month))
    alerts = _alerts(conn, month, cur, prev, base_months, totals, month_rows, rows, partial, status)

    nw_series = {p["month"]: p["net_worth"] for p in an.networth_series(conn, 36)}
    nw = nw_series.get(month)
    nw_prev = nw_series.get(an.shift_month(month, -1))

    trend_months = [m for m in months if m <= month][-12:]
    people = []
    if include_people and len(an.scoped_members(conn)) > 1:
        from . import family
        people = family.people_lines(conn, month)
        if len(people) < 2:
            people = []
    return {
        "people": people,
        "family_transfers": family_transfers(conn, month),
        "month": month,
        "months_available": months,
        "complete_months": complete,
        "partial": partial,
        "coverage": status,
        "baseline_months": base_months,
        "scorecard": {
            "income": cur["income"], "expenses": cur["expenses"], "net": cur["net"],
            "savings_rate": cur["savings_rate"],
            "essential": cur.get("essential", 0), "discretionary": cur.get("discretionary", 0),
            "net_worth": nw, "net_worth_change": round(nw - nw_prev, 2) if nw is not None and nw_prev is not None else None,
            "prev": {k: prev[k] for k in ("income", "expenses", "net", "savings_rate")} if prev else None,
        },
        "categories": table,
        "increases": increases,
        "decreases": decreases,
        "cutdowns": cutdowns,
        "potential_monthly_savings": round(sum(c["monthly_saving"] for c in cutdowns if not c["one_off"]), 2),
        "subscriptions": subs,
        "alerts": alerts,
        "trend": [{"month": m, "income": totals.get(m, {}).get("income", 0),
                   "expenses": totals.get(m, {}).get("expenses", 0),
                   "savings_rate": totals.get(m, {}).get("savings_rate")} for m in trend_months],
        "category_trend": {
            c: [round(totals.get(m, {}).get("by_category", {}).get(c, 0.0), 2) for m in trend_months[-6:]]
            for c in cats
        },
    }


def _merchant_driver(category: str, month_rows: list[dict], base_rows: list[dict], n_base: int) -> str | None:
    """Explain an increase: which merchant grew most, and how many visits vs usual."""
    now: dict[str, list[float]] = defaultdict(list)
    before: dict[str, list[float]] = defaultdict(list)
    for r in month_rows:
        if r["category"] == category and r["amount"] < 0:
            now[r["merchant"]].append(-r["amount"])
    for r in base_rows:
        if r["category"] == category and r["amount"] < 0:
            before[r["merchant"]].append(-r["amount"])
    if not now:
        return None
    best = max(now, key=lambda m: sum(now[m]) - sum(before.get(m, [])) / max(n_base, 1))
    usual = len(before.get(best, [])) / max(n_base, 1)
    spent = sum(now[best])
    if usual == 0:
        return f"New this month: {best} (${spent:,.0f} over {len(now[best])} purchase(s))."
    return f"{best}: {len(now[best])} purchases (${spent:,.0f}) vs about {usual:.0f} usually."


def subscriptions(rows: list[dict], month: str, kinds: dict[str, str]) -> list[dict]:
    """Recurring charges: same merchant, similar amount, at most twice a month, in 2+ recent months."""
    recent = sorted({r["month"] for r in rows if r["month"] <= month})[-6:]
    by_merchant: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    category_of: dict[str, str] = {}
    first_seen: dict[str, str] = {}
    for r in rows:
        if r["amount"] >= 0 or r["month"] > month:
            continue
        m = r["merchant"]
        first_seen[m] = min(first_seen.get(m, r["month"]), r["month"])
        if r["month"] in recent:
            by_merchant[m][r["month"]].append(-r["amount"])
            category_of[m] = r["category"]
    prev_month = recent[-2] if len(recent) >= 2 else None
    out = []
    for merchant, per_month in by_merchant.items():
        if month not in per_month and prev_month not in per_month:
            continue  # stopped
        if any(len(v) > 2 for v in per_month.values()):
            continue  # frequent shopping, not a subscription
        monthly = {m: sum(v) for m, v in per_month.items()}
        cat = category_of[merchant]
        is_sub_cat = cat == "Subscriptions"
        if len(monthly) < 2 and not (is_sub_cat and month in monthly):
            continue
        vals = list(monthly.values())
        if len(vals) >= 2 and max(vals) > 1.25 * min(vals) and not is_sub_cat:
            continue  # amount varies too much to be a fixed charge
        amount = monthly.get(month) or monthly.get(prev_month) or vals[-1]
        status = "active"
        if first_seen[merchant] >= (prev_month or month):
            status = "new"
        elif month in monthly and prev_month in monthly and monthly[month] > monthly[prev_month] * 1.03 \
                and monthly[month] - monthly[prev_month] > 0.5:
            status = "price_up"
        out.append({
            "merchant": merchant, "category": cat, "kind": kinds.get(cat, "discretionary"),
            "amount": round(amount, 2), "annual": round(amount * 12, 2), "months_seen": len(monthly),
            "status": status,
            "previous_amount": round(monthly[prev_month], 2) if status == "price_up" else None,
            "charged_this_month": month in monthly,
        })
    out.sort(key=lambda s: -s["amount"])
    return out


def _cutdowns(table: list[dict], subs: list[dict], month_rows: list[dict], budgets: dict,
              large: list[dict] | None = None) -> list[dict]:
    items: dict[str, dict] = {}
    one_offs: dict[str, list[dict]] = defaultdict(list)
    for r in large or []:
        one_offs[r["category"]].append(r)

    def add(key: str, item: dict) -> None:
        if item["monthly_saving"] < 5:
            return
        item["monthly_saving"] = round(item["monthly_saving"], 2)
        one_off = item.pop("one_off", False)
        item["yearly_saving"] = None if one_off else round(item["monthly_saving"] * 12, 2)
        item["one_off"] = one_off
        if key not in items or items[key]["monthly_saving"] < item["monthly_saving"]:
            items[key] = item

    for r in table:
        if r["kind"] != "discretionary" or r["category"] == "Fees/Interest":
            continue
        if r["category"] in UNEXPLAINED:
            continue  # money sent to people / cash: shown as "classify these", not a spending habit
        if r["avg3"] is not None and r["delta"] >= max(INCREASE_MIN_DOLLARS, INCREASE_MIN_PCT * r["avg3"]):
            if r["avg3"] < 1:
                title = f"New spending in {r['category']}: ${r['this']:,.0f}"
                detail = "Nothing in this category in the previous months. If it was a one-off, it won't repeat."
                one_off = True
            else:
                big = one_offs.get(r["category"], [])
                big_total = -sum(x["amount"] for x in big)
                habit = r["delta"] - big_total  # what's left above usual without the one-off purchases
                if big and habit < max(INCREASE_MIN_DOLLARS, INCREASE_MIN_PCT * r["avg3"]):
                    names = ", ".join(f"{x['merchant']} ${-x['amount']:,.0f}" for x in big)
                    title = f"{r['category']} was up because of a one-off: {names}"
                    detail = (f"Without it, {r['category']} was ${r['this'] - big_total:,.0f}, close to your usual "
                              f"${r['avg3']:,.0f}. Nothing to cut every month.")
                    one_off = True
                else:
                    title = f"Bring {r['category']} back to your usual ${r['avg3']:,.0f}/mo"
                    detail = f"You spent ${r['this']:,.0f} this month, ${r['delta']:,.0f} above your 3-month average."
                    if big:
                        detail += f" Not counting the one-off {', '.join(x['merchant'] for x in big)}."
                    one_off = False
            saving = r["delta"] if one_off or not r["avg3"] else habit
            add(r["category"], {"type": "baseline", "category": r["category"], "title": title, "detail": detail,
                                "monthly_saving": saving, "one_off": one_off})
        budget = budgets.get(r["category"])
        if budget and r["this"] > budget:
            add(r["category"], {
                "type": "budget", "category": r["category"],
                "title": f"{r['category']} is over budget",
                "detail": f"${r['this']:,.0f} spent against a ${budget:,.0f} budget.",
                "monthly_saving": r["this"] - budget,
            })

    disc_subs = [s for s in subs if s["kind"] == "discretionary"]
    for s in disc_subs:
        if s["status"] == "new":
            add(f"sub:{s['merchant']}", {
                "type": "subscription", "category": s["category"],
                "title": f"New recurring charge: {s['merchant']}",
                "detail": f"${s['amount']:,.2f}/mo (${s['annual']:,.0f}/yr). Keep it only if you'll use it.",
                "monthly_saving": s["amount"],
            })
        elif s["status"] == "price_up":
            add(f"sub:{s['merchant']}", {
                "type": "subscription", "category": s["category"],
                "title": f"{s['merchant']} went up in price",
                "detail": f"${s['previous_amount']:,.2f} → ${s['amount']:,.2f}/mo. Check for a cheaper plan or cancel.",
                "monthly_saving": s["amount"] - s["previous_amount"],
            })
    streaming = [s for s in disc_subs if VIDEO_STREAMING.search(s["merchant"])]
    if len(streaming) >= 2:
        total = sum(s["amount"] for s in streaming)
        keep = max(s["amount"] for s in streaming)
        # a service already suggested on its own (new / price up) isn't counted a second time
        already = sum(items[f"sub:{s['merchant']}"]["monthly_saving"] for s in streaming if f"sub:{s['merchant']}" in items)
        add("streaming", {
            "type": "subscription", "category": "Subscriptions",
            "title": f"{len(streaming)} video streaming services (${total:,.0f}/mo)",
            "detail": "Rotating one service at a time instead of stacking them: "
                      + ", ".join(s["merchant"] for s in streaming) + ".",
            "monthly_saving": total - keep - already,
        })

    fees: dict[str, dict] = {}
    for r in month_rows:
        if r["category"] != "Fees/Interest" or r["amount"] >= 0:
            continue
        if r["account_type"] == "loan" and re.search("INTEREST", r["description"], re.I):
            f = fees.setdefault("Loan / credit line interest", {"total": 0.0, "accounts": set(),
                                "advice": "The cost of carrying the balance. Paying principal down faster lowers it."})
            f["total"] += -r["amount"]
            f["accounts"].add(r["account"])
            continue
        for rx, label, advice in FEE_ADVICE:
            if rx.search(r["description"]):
                f = fees.setdefault(label, {"total": 0.0, "accounts": set(), "advice": advice})
                f["total"] += -r["amount"]
                f["accounts"].add(r["account"])
                break
        else:
            f = fees.setdefault("Other fees", {"total": 0.0, "accounts": set(), "advice": "Ask the bank to waive it; first-time fees often are."})
            f["total"] += -r["amount"]
            f["accounts"].add(r["account"])
    for label, f in fees.items():
        add(f"fee:{label}", {
            "type": "fee", "category": "Fees/Interest",
            "title": f"{label}: ${f['total']:,.2f} ({', '.join(sorted(f['accounts']))})",
            "detail": f["advice"], "monthly_saving": f["total"],
        })

    habits: dict[str, list[float]] = defaultdict(list)
    habit_cat: dict[str, str] = {}
    for r in month_rows:
        if r["kind"] == "discretionary" and r["amount"] < 0 and r["category"] not in ("Fees/Interest", "Subscriptions"):
            habits[r["merchant"]].append(-r["amount"])
            habit_cat[r["merchant"]] = r["category"]
    for merchant, amounts in habits.items():
        if len(amounts) >= HABIT_MIN_COUNT and statistics.mean(amounts) <= HABIT_MAX_TICKET:
            total = sum(amounts)
            add(f"habit:{merchant}", {
                "type": "habit", "category": habit_cat[merchant],
                "title": f"{merchant}: {len(amounts)} purchases, ${total:,.0f}",
                "detail": f"About ${statistics.mean(amounts):,.2f} each time. Cutting visits in half saves the amount shown.",
                "monthly_saving": total / 2,
            })
    return sorted(items.values(), key=lambda i: (i["one_off"], -i["monthly_saving"]))  # habits first


def large_purchases(rows: list[dict], month_rows: list[dict], month: str) -> list[dict]:
    """One-off purchases far bigger than usual for their category (not repeat bills like rent)."""
    by_cat: dict[str, list[float]] = defaultdict(list)
    usual_bills: dict[str, list[float]] = defaultdict(list)  # rent, tuition... paid before at this size
    for r in rows:
        if r["amount"] < 0 and r["month"] < month:
            by_cat[r["category"]].append(-r["amount"])
            usual_bills[r["merchant"]].append(-r["amount"])
    all_hist = [v for vals in by_cat.values() for v in vals]
    out = []
    for r in month_rows:
        if r["amount"] >= 0 or r["kind"] not in ("essential", "discretionary") or r["category"] in UNEXPLAINED:
            continue
        if any(abs(v + r["amount"]) <= 0.1 * -r["amount"] for v in usual_bills.get(r["merchant"], [])):
            continue  # the same payment as before, not a surprise
        hist = by_cat.get(r["category"], [])
        if len(hist) < 3:
            hist = all_hist  # new category: compare against spending in general
        if -r["amount"] >= LARGE_TX_MIN and len(hist) >= 3 and -r["amount"] > 3 * statistics.median(hist):
            out.append(r)
    return out


def _alerts(conn, month, cur, prev, base_months, totals, month_rows, rows, partial=False, status=None) -> list[dict]:
    alerts: list[dict] = []

    def alert(severity: str, title: str, detail: str = "") -> None:
        alerts.append({"severity": severity, "title": title, "detail": detail})

    if partial:
        missing = (status or {}).get("missing", [])
        alert("info", f"{month} isn't complete yet",
              (f"Waiting for statements covering the whole month from {', '.join(missing)}. " if missing else "")
              + "Income, savings rate and \"lower than usual\" checks are skipped until they're in.")

    unexplained = [r for r in month_rows if r["category"] in UNEXPLAINED and r["amount"] < 0]
    if unexplained:
        total = -sum(r["amount"] for r in unexplained)
        alert("info", f"{len(unexplained)} e-transfer/cash withdrawal(s) without a purpose (${total:,.0f})",
              "Set what they were for on the Spending page (rent, family, a purchase), or record them on "
              "People & loans if it was a loan, so they land in the right place.")

    sr = cur.get("savings_rate")
    if partial:
        pass  # income and savings aren't meaningful until all of the month's statements are in
    elif cur["income"] > 0:
        if cur["expenses"] > cur["income"]:
            alert("bad", "Spent more than you earned",
                  f"Expenses ${cur['expenses']:,.0f} vs income ${cur['income']:,.0f} (shortfall ${cur['expenses'] - cur['income']:,.0f}).")
        elif sr is not None and sr < 0.10:
            alert("warn", f"Savings rate {sr:.0%}", "Below 10% of income. 20% is a common target.")
        elif sr is not None and sr >= 0.20:
            alert("good", f"Savings rate {sr:.0%}", "At or above the common 20% target.")
    else:
        alert("info", "No income detected this month",
              "If you were paid, check that the chequing statement for this month is in the folder.")

    if prev and prev.get("savings_rate") is not None and sr is not None:
        diff = sr - prev["savings_rate"]
        if abs(diff) >= 0.05:
            alert("good" if diff > 0 else "warn",
                  f"Savings rate {'up' if diff > 0 else 'down'} {abs(diff) * 100:.0f} points vs last month")

    # a single deposit far bigger than a normal paycheque is usually a transfer or a misread line
    incomes = sorted(r["amount"] for r in rows if r["kind"] == "income" and r["amount"] > 0 and r["month"] < month)
    typical = statistics.median(incomes) if incomes else 0
    for r in month_rows:
        if r["kind"] == "income" and r["amount"] >= 5000 and (not typical or r["amount"] > 3 * typical):
            alert("warn", f"Check this income: ${r['amount']:,.2f} on {r['date']}",
                  f"\"{r['description']}\" ({r['account']}). If it's money moved between your own accounts, "
                  "set its category to Transfer on the Spending page so it isn't counted as income.")

    base_income = [totals.get(m, {}).get("income", 0) for m in base_months]
    if not partial and base_income and statistics.mean(base_income) > 0 and cur["income"] < 0.85 * statistics.mean(base_income):
        alert("info", "Income lower than usual",
              f"${cur['income']:,.0f} vs ~${statistics.mean(base_income):,.0f} average. Could be pay timing.")

    cutoff = an.month_end(month)
    bal = an.balances_at(conn, cutoff)
    accts = {a["id"]: dict(a) for a in conn.execute("SELECT * FROM accounts")}
    for i in bal["items"]:
        a = accts.get(i["account_id"]) or {}
        if a.get("type") == "credit" and a.get("credit_limit"):
            util = i["balance"] / a["credit_limit"]
            if util > 0.30:
                alert("warn", f"{a['name']}: {util:.0%} credit utilization",
                      "Above 30% can weigh on your credit score. Paying before the statement date lowers it.")

    liquid = sum(i["balance"] for i in bal["items"] if i["type"] in an.LIQUID_TYPES)
    spend = [totals.get(m, {}).get("expenses", 0) for m in [*base_months, month]][-3:]
    avg_spend = statistics.mean(spend) if spend else 0
    if avg_spend > 0 and liquid > 0:
        months_cov = liquid / avg_spend
        if months_cov < 3:
            alert("warn", f"Emergency fund covers {months_cov:.1f} months",
                  f"${liquid:,.0f} in chequing/savings vs ${avg_spend:,.0f} average monthly spending. 3-6 months is the usual guideline.")
        elif months_cov >= 6:
            alert("good", f"Emergency fund covers {months_cov:.1f} months")

    for r in large_purchases(rows, month_rows, month):
        alert("info", f"Large purchase: ${-r['amount']:,.2f} at {r['merchant']}",
              f"{r['date']}, {r['category']}. That's over 3x your typical {r['category']} purchase.")


    year = int(month[:4])
    rooms = an.contribution_room(conn, year)
    several = len({r["member_id"] for r in rooms}) > 1
    for room in rooms:
        who = f"{room['member']}'s " if several else ""
        if room["remaining"] > 0:
            alert("info", f"{who}{room['registration']}: ${room['remaining']:,.0f} of {year} room unused",
                  "Based on the room you entered. Figures only; not advice on what to invest.")
        elif room["remaining"] < 0:
            alert("bad", f"{who}{room['registration']} over-contributed by ${-room['remaining']:,.0f}",
                  "CRA charges 1% per month on excess contributions. Double-check with CRA My Account.")

    for r in insurance.summary(conn)["renewals"]:  # already limited to the people in view
        when = "today" if r["days"] == 0 else f"in {r['days']} days"
        alert("info", f"{r['name']} renews {when} ({r['date']})",
              "A good moment to check the coverage still fits and compare a quote or two before it auto-renews.")

    order = {"bad": 0, "warn": 1, "info": 2, "good": 3}
    return sorted(alerts, key=lambda a: order[a["severity"]])


def family_transfers(conn: sqlite3.Connection, month: str) -> dict:
    """Money moved between family members this month, from the viewed people's side.

    Not spending or income: in a one-person view it's shown on its own line; with everyone
    selected both sides are included and simply cancel out.
    """
    people = conn.execute("SELECT id, name FROM members").fetchall()
    clause, args = scope.account_filter()
    items = []
    for r in conn.execute(
        "SELECT t.date, t.description, t.amount, a.member_id, m.name member FROM transactions t "
        "JOIN accounts a ON a.id = t.account_id LEFT JOIN members m ON m.id = a.member_id "
        f"WHERE t.category = 'Family Transfer' AND substr(t.date,1,7) = ?{clause} ORDER BY t.date", [month, *args]
    ):
        text = r["description"].upper()
        other = next((p["name"] for p in people if p["id"] != r["member_id"]
                      and re.search(r"(?<![A-Z])" + re.escape(p["name"].split()[0].upper()) + r"(?![A-Z])", text)), None)
        if other is None:  # no name in the text: use the owner of the matching opposite transaction
            d = date.fromisoformat(r["date"])
            match = conn.execute(
                "SELECT m.name FROM transactions t JOIN accounts a ON a.id = t.account_id "
                "JOIN members m ON m.id = a.member_id WHERE t.category = 'Family Transfer' "
                "AND round(t.amount, 2) = round(?, 2) AND a.member_id != ? AND t.date BETWEEN ? AND ? LIMIT 1",
                (-r["amount"], r["member_id"], (d - timedelta(days=3)).isoformat(),
                 (d + timedelta(days=3)).isoformat())).fetchone()
            other = match["name"] if match else None
        items.append({**dict(r), "counterpart": other})
    sent = -sum(i["amount"] for i in items if i["amount"] < 0)
    received = sum(i["amount"] for i in items if i["amount"] > 0)
    return {"sent": round(sent, 2), "received": round(received, 2), "items": items,
            "everyone": _all_owners_in_view(conn)}  # wording only: are both sides of each transfer in view


def _all_owners_in_view(conn: sqlite3.Connection) -> bool:
    """True when everyone who owns accounts is selected (people without statements don't matter)."""
    ids = scope.current()
    if ids is None:
        return True
    owners = {r[0] for r in conn.execute("SELECT DISTINCT member_id FROM accounts")}
    return owners <= set(ids)
