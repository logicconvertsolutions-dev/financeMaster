"""Aggregations behind the dashboard pages."""
import bisect
import calendar
import math
import re
import sqlite3
from collections import defaultdict
from datetime import date, timedelta

from . import scope

STALE_DAYS = 45  # a balance older than this is probably out of date
CASHFLOW_TYPES = ("chequing", "savings", "credit", "loan")
LIABILITY_TYPES = ("credit", "loan")
LIQUID_TYPES = ("chequing", "savings")


def month_end(month: str) -> str:
    y, m = map(int, month.split("-"))
    return f"{month}-{calendar.monthrange(y, m)[1]:02d}"


def shift_month(month: str, delta: int) -> str:
    y, m = map(int, month.split("-"))
    idx = y * 12 + (m - 1) + delta
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def month_range(first: str, last: str) -> list[str]:
    out, cur = [], first
    while cur <= last and len(out) < 240:
        out.append(cur)
        cur = shift_month(cur, 1)
    return out


def category_kinds(conn: sqlite3.Connection) -> dict[str, str]:
    return {r["name"]: r["kind"] for r in conn.execute("SELECT name, kind FROM categories")}


def data_months(conn: sqlite3.Connection) -> list[str]:
    """Months that have cash-flow transactions, oldest first."""
    ph = ",".join("?" * len(CASHFLOW_TYPES))
    clause, args = scope.account_filter()
    cur = conn.execute(
        f"SELECT DISTINCT substr(t.date, 1, 7) m FROM transactions t JOIN accounts a ON a.id = t.account_id "
        f"WHERE a.type IN ({ph}){clause} ORDER BY m",
        [*CASHFLOW_TYPES, *args],
    )
    return [r["m"] for r in cur]


def all_months(conn: sqlite3.Connection) -> list[str]:
    clause, args = scope.account_filter()
    mclause, margs = scope.owner_filter(conn, "member_id")
    row = conn.execute(
        "SELECT min(d) lo, max(d) hi FROM ("
        f"SELECT t.date d FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE 1=1{clause} "
        f"UNION ALL SELECT s.date FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id WHERE 1=1{clause} "
        f"UNION ALL SELECT as_of FROM manual_items WHERE 1=1{mclause})", [*args, *args, *margs]
    ).fetchone()
    if not row["lo"]:
        today = date.today().strftime("%Y-%m")
        return [today]
    return month_range(row["lo"][:7], max(row["hi"][:7], row["lo"][:7]))


def cashflow_rows(conn: sqlite3.Connection, first: str | None = None, last: str | None = None) -> list[dict]:
    """Non-transfer transactions on everyday accounts, with category kind attached."""
    ph = ",".join("?" * len(CASHFLOW_TYPES))
    sql = (
        "SELECT t.id, t.date, substr(t.date,1,7) month, t.description, t.merchant, t.amount, "
        "coalesce(t.category, 'Other') category, coalesce(c.kind, 'discretionary') kind, t.account_id, "
        "a.name account, a.type account_type, a.member_id, m.name member "
        "FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.name = t.category "
        "LEFT JOIN members m ON m.id = a.member_id "
        f"WHERE t.is_transfer = 0 AND a.type IN ({ph}) AND a.archived = 0"
    )
    clause, scope_args = scope.account_filter()
    sql += clause
    args: list = [*CASHFLOW_TYPES, *scope_args]
    if first:
        sql += " AND t.date >= ?"
        args.append(f"{first}-01")
    if last:
        sql += " AND t.date <= ?"
        args.append(month_end(last))
    return [dict(r) for r in conn.execute(sql + " ORDER BY t.date", args)]


def monthly_totals(rows: list[dict]) -> dict[str, dict]:
    """month -> {income, expenses, essential, discretionary, by_category{cat: spend}}."""
    out: dict[str, dict] = defaultdict(lambda: {"income": 0.0, "expenses": 0.0, "essential": 0.0,
                                                "discretionary": 0.0, "by_category": defaultdict(float)})
    for r in rows:
        m = out[r["month"]]
        if r["kind"] == "income":
            m["income"] += r["amount"]
        elif r["kind"] in ("essential", "discretionary"):
            spend = -r["amount"]  # refunds (positive) reduce spending
            m["expenses"] += spend
            m[r["kind"]] += spend
            m["by_category"][r["category"]] += spend
        elif r["kind"] == "ignore":
            continue
    for m in out.values():
        m["by_category"] = {k: round(v, 2) for k, v in m["by_category"].items() if abs(v) >= 0.005}
        for k in ("income", "expenses", "essential", "discretionary"):
            m[k] = round(m[k], 2)
        m["net"] = round(m["income"] - m["expenses"], 2)
        m["savings_rate"] = round(m["net"] / m["income"], 4) if m["income"] > 0 else None
    return dict(out)


# ---------------------------------------------------------------- balances / net worth

def _accounts(conn: sqlite3.Connection) -> list[dict]:
    clause, args = scope.account_filter()
    return [dict(r) for r in conn.execute(
        "SELECT a.*, m.name member FROM accounts a LEFT JOIN members m ON m.id = a.member_id "
        f"WHERE a.archived = 0{clause} ORDER BY a.type, a.name", args)]


def _snapshots(conn: sqlite3.Connection) -> dict[int, list[tuple[str, float, float | None]]]:
    out: dict[int, list] = defaultdict(list)
    # a manual update on the same date wins over the statement figure
    for r in conn.execute(
        "SELECT account_id, date, balance, book_value FROM balance_snapshots "
        "ORDER BY account_id, date, source = 'manual'"
    ):
        out[r["account_id"]].append((r["date"], r["balance"], r["book_value"]))
    return out


def _latest_before(series: list, cutoff: str):
    best = None
    for item in series:
        if item[0] <= cutoff:
            best = item
        else:
            break
    return best


def _flows(conn: sqlite3.Connection) -> dict[int, tuple[list[str], list[float]]]:
    """Per everyday account: transaction dates and running totals, to carry a balance between dates."""
    ph = ",".join("?" * len(CASHFLOW_TYPES))
    out: dict[int, tuple[list, list]] = {}
    for r in conn.execute(f"SELECT t.account_id, t.date, t.amount FROM transactions t JOIN accounts a "
                          f"ON a.id = t.account_id WHERE a.type IN ({ph}) ORDER BY t.account_id, t.date",
                          CASHFLOW_TYPES):
        dates, cum = out.setdefault(r["account_id"], ([], []))
        dates.append(r["date"])
        cum.append((cum[-1] if cum else 0.0) + r["amount"])
    return out


def _flow_upto(flow: tuple[list[str], list[float]], day: str) -> float:
    """Sum of the account's transactions dated on or before `day`."""
    i = bisect.bisect_right(flow[0], day)
    return flow[1][i - 1] if i else 0.0


def account_balance(a: dict, cutoff: str, snaps: dict, flows: dict):
    """(as_of, balance, book_value) for an account on a date, or None if nothing is known.

    Starts from the nearest balance (statement closing balance or one you entered) and adds the
    transactions in between. So an account whose files carry no balance (bank CSV exports) needs a
    balance entered once; after that it stays current as new transactions come in, and the history
    before it is worked out backwards.
    """
    series = snaps.get(a["id"], [])
    s = _latest_before(series, cutoff)
    flow = flows.get(a["id"]) if a["type"] in CASHFLOW_TYPES else None
    sign = -1 if a["type"] in LIABILITY_TYPES else 1  # purchases (negative) grow what you owe
    if s is not None:
        if not flow:
            return s
        moved = _flow_upto(flow, cutoff) - _flow_upto(flow, s[0])
        if abs(moved) < 0.005:
            return s
        last_tx = flow[0][bisect.bisect_right(flow[0], cutoff) - 1]
        return (max(s[0], last_tx), s[1] + sign * moved, s[2])
    if not series or not flow or flow[0][0] > cutoff:
        return None  # before anything is known about this account
    first = series[0]  # the earliest balance is after the cutoff: work backwards from it
    moved = _flow_upto(flow, first[0]) - _flow_upto(flow, cutoff)
    return (cutoff, first[1] - sign * moved, first[2])


def _manual(conn: sqlite3.Connection) -> dict[tuple[str, str], list[tuple[str, float]]]:
    out: dict[tuple[str, str], list] = defaultdict(list)
    clause, args = scope.owner_filter(conn, "member_id")  # no owner = the primary member's
    for r in conn.execute(f"SELECT name, kind, value, as_of FROM manual_items WHERE 1=1{clause} "
                          "ORDER BY as_of, id", args):
        out[(r["name"], r["kind"])].append((r["as_of"], r["value"]))
    return out


def balances_at(conn: sqlite3.Connection, cutoff: str, accounts=None, snaps=None, manual=None, flows=None) -> dict:
    accounts = accounts if accounts is not None else _accounts(conn)
    snaps = snaps if snaps is not None else _snapshots(conn)
    manual = manual if manual is not None else _manual(conn)
    flows = flows if flows is not None else _flows(conn)
    items = []
    for a in accounts:
        s = account_balance(a, cutoff, snaps, flows)
        if s is None:
            continue
        liability = a["type"] in LIABILITY_TYPES
        items.append({
            "account_id": a["id"], "name": a["name"], "institution": a["institution"], "type": a["type"],
            "registration": a["registration"], "as_of": s[0], "balance": round(s[1], 2), "book_value": s[2],
            "side": "liability" if liability else "asset", "member_id": a.get("member_id"), "member": a.get("member"),
        })
    for (name, kind), series in manual.items():
        s = _latest_before(series, cutoff)
        if s is None or s[1] == 0:
            continue
        items.append({"account_id": None, "name": name, "institution": "Manual", "type": "manual",
                      "registration": None, "as_of": s[0], "balance": round(s[1], 2), "book_value": None,
                      "side": kind})
    from . import people
    owed, owe = people.balances_at(conn, cutoff)  # scoped by who sent/received the money
    if owed:
        items.append({"account_id": None, "name": "Money owed to me (people)", "institution": "People & loans",
                      "type": "people", "registration": None, "as_of": cutoff, "balance": owed,
                      "book_value": None, "side": "asset"})
    if owe:
        items.append({"account_id": None, "name": "Money I owe (people)", "institution": "People & loans",
                      "type": "people", "registration": None, "as_of": cutoff, "balance": owe,
                      "book_value": None, "side": "liability"})
    assets = sum(i["balance"] for i in items if i["side"] == "asset")
    liabilities = sum(i["balance"] for i in items if i["side"] == "liability")
    return {"items": items, "assets": round(assets, 2), "liabilities": round(liabilities, 2),
            "net_worth": round(assets - liabilities, 2)}


def group_label(item: dict) -> str:
    if item["type"] == "people":
        return "Owed to me" if item["side"] == "asset" else "Owed to people"
    if item["type"] == "manual":
        return "Other assets" if item["side"] == "asset" else "Other debts"
    if item["type"] == "investment":
        return {"TFSA": "TFSA", "RRSP": "RRSP", "FHSA": "FHSA"}.get(item["registration"], "Non-registered")
    return {"chequing": "Chequing", "savings": "Savings", "credit": "Credit cards", "loan": "Loans"}[item["type"]]


def networth_series(conn: sqlite3.Connection, months: int = 36) -> list[dict]:
    accounts, snaps, manual, flows = _accounts(conn), _snapshots(conn), _manual(conn), _flows(conn)
    out = []
    for m in all_months(conn)[-months:]:
        b = balances_at(conn, month_end(m), accounts, snaps, manual, flows)
        groups: dict[str, float] = defaultdict(float)
        for i in b["items"]:
            groups[group_label(i)] += i["balance"] if i["side"] == "asset" else -i["balance"]
        out.append({"month": m, "assets": b["assets"], "liabilities": b["liabilities"],
                    "net_worth": b["net_worth"], "groups": {k: round(v, 2) for k, v in groups.items()}})
    return out


# ---------------------------------------------------------------- pages

def overview(conn: sqlite3.Connection) -> dict:
    today = date.today().isoformat()
    now = balances_at(conn, today)
    months = data_months(conn)
    totals = monthly_totals(cashflow_rows(conn, months[-12] if len(months) >= 12 else None))
    from . import coverage
    grid = coverage.grid(conn, 24)
    complete = [m for m in months if grid["status"].get(m, {}).get("complete")]
    latest = (complete[-1] if complete else months[-1]) if months else None
    partial = {m for m in months if m in grid["status"] and not grid["status"][m]["complete"]
               and grid["status"][m]["expected"]}
    stale_cutoff = (date.today() - timedelta(days=STALE_DAYS)).isoformat()
    series = networth_series(conn, 24)
    prev_nw = series[-2]["net_worth"] if len(series) >= 2 else None
    alloc: dict[str, float] = defaultdict(float)
    for i in now["items"]:
        if i["side"] == "asset":
            alloc[group_label(i)] += i["balance"]
    return {
        "as_of": today,
        "net_worth": now["net_worth"], "assets": now["assets"], "liabilities": now["liabilities"],
        "net_worth_change": round(now["net_worth"] - prev_nw, 2) if prev_nw is not None else None,
        "latest_month": latest,
        "month": totals.get(latest) if latest else None,
        "cashflow": [{"month": m, "partial": m in partial, **{k: v for k, v in t.items() if k != "by_category"}}
                     for m, t in sorted(totals.items())],
        "networth": series,
        "allocation": [{"name": k, "value": round(v, 2)} for k, v in sorted(alloc.items(), key=lambda x: -x[1])],
        "accounts": [{**i, "stale": i["account_id"] is not None and i["balance"] != 0
                                     and i["as_of"] < stale_cutoff} for i in now["items"]],
        "stale_days": STALE_DAYS,
    }


def spending(conn: sqlite3.Connection, months: int = 12) -> dict:
    all_m = data_months(conn)
    window = all_m[-months:]
    rows = cashflow_rows(conn, window[0] if window else None)
    totals = monthly_totals(rows)
    cats: dict[str, float] = defaultdict(float)
    merchants: dict[str, dict] = defaultdict(lambda: {"total": 0.0, "count": 0, "category": None})
    for r in rows:
        if r["kind"] in ("essential", "discretionary"):
            cats[r["category"]] += -r["amount"]
            mm = merchants[r["merchant"]]
            mm["total"] += -r["amount"]
            mm["count"] += 1
            mm["category"] = r["category"]
    kinds = category_kinds(conn)
    budget_map = budgets(conn)
    by_member: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for r in rows:
        if r["kind"] in ("essential", "discretionary"):
            by_member[r["month"]][r["member"] or "?"] += -r["amount"]
    spenders = {r["member"] for r in rows}
    people = [m for m in scoped_members(conn) if m["name"] in spenders]
    from . import coverage
    grid = coverage.grid(conn, 24)
    partial = [m for m in window if m in grid["status"] and not grid["status"][m]["complete"]
               and grid["status"][m]["expected"]]
    complete = [m for m in window if m not in partial]
    budget_month = complete[-1] if complete else (window[-1] if window else None)
    prior = [m for m in complete if budget_month and m < budget_month][-3:]
    budget_rows = []
    for name, budget in sorted(budget_map.items()):
        if not budget or kinds.get(name) not in ("essential", "discretionary"):
            continue
        spent = totals.get(budget_month, {}).get("by_category", {}).get(name, 0.0) if budget_month else 0.0
        avg = sum(totals.get(m, {}).get("by_category", {}).get(name, 0.0) for m in prior) / len(prior) if prior else 0.0
        budget_rows.append({"name": name, "budget": budget, "spent": round(spent, 2), "avg": round(avg, 2)})
    budget_rows.sort(key=lambda b: -b["spent"] / b["budget"])
    return {
        "partial_months": partial,
        "budget_month": budget_month,
        "budgets": budget_rows,
        "members": [{"name": m["name"], "color": m["color"]} for m in people],
        "monthly_by_member": [{"month": m, **{k: round(v, 2) for k, v in by_member.get(m, {}).items()}}
                              for m in window],
        "months": window,
        "monthly": [{"month": m, "by_category": totals.get(m, {}).get("by_category", {}),
                     "expenses": totals.get(m, {}).get("expenses", 0)} for m in window],
        "categories": [{"name": k, "total": round(v, 2), "monthly_avg": round(v / max(len(window), 1), 2),
                        "kind": kinds.get(k, "discretionary"), "budget": budget_map.get(k)}
                       for k, v in sorted(cats.items(), key=lambda x: -x[1]) if v > 0],
        "merchants": sorted(({"merchant": k, **{**v, "total": round(v["total"], 2)}} for k, v in merchants.items()),
                            key=lambda x: -x["total"])[:25],
    }


def investments(conn: sqlite3.Connection) -> dict:
    today = date.today()
    now = balances_at(conn, today.isoformat())
    inv = [i for i in now["items"] if i["type"] == "investment"]
    # accounts with no balance yet still belong on this page (same list as Accounts & assets)
    listed = {i["account_id"] for i in inv}
    for a in _accounts(conn):
        if a["type"] == "investment" and a["id"] not in listed:
            inv.append({"account_id": a["id"], "name": a["name"], "institution": a["institution"],
                        "type": "investment", "registration": a["registration"], "as_of": None,
                        "balance": None, "book_value": None, "side": "asset",
                        "member_id": a.get("member_id"), "member": a.get("member")})
    by_reg: dict[str, dict] = defaultdict(lambda: {"market_value": 0.0, "book_value": 0.0})
    for i in inv:
        if i["balance"] is None:
            continue
        g = by_reg[group_label(i)]
        g["market_value"] += i["balance"]
        g["book_value"] += i["book_value"] or 0.0
    series = []
    for p in networth_series(conn, 36):
        series.append({"month": p["month"], **{k: v for k, v in p["groups"].items()
                                               if k in ("TFSA", "RRSP", "FHSA", "Non-registered")}})
    clause, args = scope.account_filter()
    holdings = [dict(r) for r in conn.execute(
        "SELECT h.symbol, h.units, h.market_value, h.book_value, a.name account FROM holdings h "
        "JOIN accounts a ON a.id = h.account_id WHERE h.as_of = (SELECT max(as_of) FROM holdings h2 "
        f"WHERE h2.account_id = h.account_id){clause} ORDER BY h.market_value DESC", args)]
    by_month: dict[tuple, float] = defaultdict(float)
    for c_ in contributions(conn):
        by_month[(c_["date"][:7], c_["registration"])] += c_["amount"]
    contribution_rows = [{"month": m, "registration": r, "amount": round(v, 2)} for (m, r), v in sorted(by_month.items())]
    return {
        "this_year": _investment_growth(conn, today),
        "accounts": inv,
        "by_registration": [{"name": k, "market_value": round(v["market_value"], 2),
                             "book_value": round(v["book_value"], 2) or None} for k, v in by_reg.items()],
        "series": series,
        "holdings": holdings,
        "contributions": contribution_rows,
        "room": contribution_room(conn, today.year),
    }


def _investment_growth(conn: sqlite3.Connection, today: date) -> dict:
    """Change in investment value since January 1, split into what you put in and what the market did.

    Uses book value (what you've put in) at both ends: put in = change in book value (withdrawals
    lower it), market = change in value - put in. Accounts without a book value can't be split and
    are listed instead of guessed.
    """
    start_day = f"{today.year - 1}-12-31"
    snaps, flows = _snapshots(conn), _flows(conn)
    counted, missing = [], []
    for a in _accounts(conn):
        if a["type"] != "investment":
            continue
        now = account_balance(a, today.isoformat(), snaps, flows)
        if now is None:
            continue
        start = account_balance(a, start_day, snaps, flows)
        since = f"{today.year}-01-01"
        if start is None:  # no balance on Jan 1: measure from the first one this year
            first = next((x for x in snaps.get(a["id"], []) if x[0] > start_day), None)
            start, since = (first, first[0]) if first else (None, since)
        start_value, start_book = (start[1], start[2]) if start else (None, None)
        if now[2] is None or start_book is None or start_value is None:
            missing.append(a["name"])
            continue
        put_in = now[2] - start_book
        counted.append({"name": a["name"], "since": since, "start": round(start_value, 2), "value": round(now[1], 2),
                        "put_in": round(put_in, 2), "growth": round(now[1] - start_value - put_in, 2)})
    tot = {k: round(sum(c[k] for c in counted), 2) for k in ("start", "value", "put_in", "growth")}
    return {"year": today.year, **tot, "accounts": counted, "missing": missing,
            "since": max((c["since"] for c in counted), default=f"{today.year}-01-01"),
            "growth_pct": round(tot["growth"] / (tot["start"] + max(tot["put_in"], 0) / 2), 4)
            if tot["start"] + max(tot["put_in"], 0) / 2 > 0 else None}


def scoped_members(conn: sqlite3.Connection) -> list[dict]:
    ids = scope.current()
    rows = conn.execute("SELECT id, name, color, is_primary FROM members ORDER BY is_primary DESC, name").fetchall()
    return [dict(r) for r in rows if ids is None or r["id"] in ids]


_REG_WORDS = {"TFSA": re.compile(r"\bTFSA\b|\bCELI\b", re.I), "RRSP": re.compile(r"\bRR?SP\b|\bREER\b", re.I),
              "FHSA": re.compile(r"\bFHSA\b|\bCELIAPP\b", re.I)}
_DEPOSIT_WORDS = re.compile(r"CONTRIBUTION|DEPOSIT|TRANSFER IN|TFR IN|CASH IN", re.I)
_NOT_A_CONTRIBUTION = re.compile(r"INTEREST|DIVIDEND|DISTRIBUTION|REBATE|RETURN OF CAPITAL|REINVEST", re.I)


def contributions(conn: sqlite3.Connection, year: int | None = None) -> list[dict]:
    """Money put into TFSA/RRSP/FHSA accounts, each contribution counted once.

    * Deposits seen inside a registered account (its statement) count, except interest/dividends
      earned there and transfers from your own other account of the same kind (those don't use room).
    * A transfer from chequing that names the account ("... WEALTHSIMPLE TFSA") counts when the
      registered account's own statement hasn't shown the matching deposit, so contributions are
      tracked even before (or without) importing investment statements.
    Returns [{member_id, registration, date, amount}] for the people in view.
    """
    clause, args = scope.account_filter("a")
    year_sql, year_args = ("AND substr(t.date,1,4) = ?", [str(year)]) if year else ("", [])
    registered = conn.execute(
        "SELECT t.id, t.date, t.amount, t.description, a.id account_id, a.member_id, a.registration "
        "FROM transactions t JOIN accounts a ON a.id = t.account_id "
        f"WHERE a.registration IN ('TFSA','RRSP','FHSA') AND a.type IN ('investment','savings') {year_sql}{clause}",
        [*year_args, *args]).fetchall()
    by_reg_member: dict[tuple, list] = defaultdict(list)
    for t in registered:
        by_reg_member[(t["member_id"], t["registration"])].append(t)

    def near(a: str, b: str, days: int = 3) -> bool:
        return abs((date.fromisoformat(a) - date.fromisoformat(b)).days) <= days

    out = []
    inside_deposits = []
    for t in registered:
        if t["amount"] <= 0 or not _DEPOSIT_WORDS.search(t["description"]) or _NOT_A_CONTRIBUTION.search(t["description"]):
            continue
        # moved from your own other account of the same kind (e.g. TFSA to TFSA): not new room used
        own_move = any(o["account_id"] != t["account_id"] and round(o["amount"], 2) == round(-t["amount"], 2)
                       and near(o["date"], t["date"]) for o in by_reg_member[(t["member_id"], t["registration"])])
        if own_move:
            continue
        inside_deposits.append(t)
        out.append({"member_id": t["member_id"], "registration": t["registration"], "date": t["date"],
                    "amount": round(t["amount"], 2)})

    bank = conn.execute(
        "SELECT t.id, t.date, t.amount, t.description, t.account_id, a.member_id FROM transactions t "
        "JOIN accounts a ON a.id = t.account_id "
        f"WHERE a.type IN ('chequing','savings') AND a.registration IS NULL AND t.amount < 0 {year_sql}{clause}",
        [*year_args, *args]).fetchall()
    tags = _contribution_tags(conn)
    for t in bank:
        reg = tags.get((t["account_id"], t["date"], round(t["amount"], 2), t["description"]))
        if reg == "NONE":
            continue  # you said it's not a contribution
        reg = reg or next((r for r, rx in _REG_WORDS.items() if rx.search(t["description"])), None)
        if reg is None:
            continue
        seen_inside = any(d["member_id"] == t["member_id"] and round(d["amount"], 2) == round(-t["amount"], 2)
                          and near(d["date"], t["date"]) for d in inside_deposits)
        if not seen_inside:
            out.append({"member_id": t["member_id"], "registration": reg, "date": t["date"],
                        "amount": round(-t["amount"], 2)})
    return out


def _contribution_tags(conn: sqlite3.Connection) -> dict[tuple, str]:
    return {(r["account_id"], r["date"], round(r["amount"], 2), r["description"]): r["registration"]
            for r in conn.execute("SELECT * FROM contribution_tags")}


def contribution_candidates(conn: sqlite3.Connection, year: int) -> list[dict]:
    """Bank transfers this year that might be TFSA/RRSP/FHSA contributions but don't say which.

    Money sent to an investment company (by keyword, or already recognised as an investment
    contribution) that isn't counted yet and you haven't answered for. Suggests the account kind
    when the person has exactly one registered account at that company.
    """
    from .rules_library import SEED_RULES

    counted = {(c["date"], c["amount"]) for c in contributions(conn, year)}
    tags = _contribution_tags(conn)
    brokers = [w for w in SEED_RULES["Investment Contribution"] if len(w) > 4]
    clause, args = scope.account_filter("a")
    registered = conn.execute(
        "SELECT member_id, institution, registration FROM accounts WHERE registration IN ('TFSA','RRSP','FHSA') "
        "AND archived = 0").fetchall()
    out = []
    for t in conn.execute(
        "SELECT t.date, t.amount, t.description, t.account_id, t.category, a.member_id, a.name account, "
        "m.name member FROM transactions t JOIN accounts a ON a.id = t.account_id "
        "LEFT JOIN members m ON m.id = a.member_id "
        "WHERE a.type IN ('chequing','savings') AND a.registration IS NULL AND t.amount < 0 "
        f"AND substr(t.date,1,4) = ?{clause} ORDER BY t.date DESC", [str(year), *args]
    ):
        key = (t["account_id"], t["date"], round(t["amount"], 2), t["description"])
        if key in tags or (t["date"], round(-t["amount"], 2)) in counted:
            continue
        text = t["description"].upper()
        mentions = [w for w in brokers if w in text]
        if not mentions and t["category"] != "Investment Contribution":
            continue
        # suggest when the person has exactly one registered account at the company mentioned
        options = {r["registration"] for r in registered if r["member_id"] == t["member_id"]
                   and any(w.split()[0] in r["institution"].upper().replace(" ", "") or
                           r["institution"].upper().replace(" ", "") in w.replace(" ", "") for w in mentions)}
        out.append({"account_id": t["account_id"], "date": t["date"], "amount": round(-t["amount"], 2),
                    "raw_amount": t["amount"], "description": t["description"], "account": t["account"],
                    "member": t["member"], "suggested": next(iter(options)) if len(options) == 1 else None})
    return out


def contribution_room(conn: sqlite3.Connection, year: int) -> list[dict]:
    """Room per person (TFSA/RRSP/FHSA room is individual), for the people being viewed."""
    people = {m["id"]: m["name"] for m in scoped_members(conn)}
    detected: dict[tuple, float] = defaultdict(float)
    for c in contributions(conn, year):
        detected[(c["member_id"], c["registration"])] += c["amount"]
    out = []
    for r in conn.execute("SELECT * FROM contribution_room WHERE year = ? ORDER BY member_id, registration", (year,)):
        if r["member_id"] not in people:
            continue
        base = {"registration": r["registration"], "year": year, "member_id": r["member_id"],
                "member": people[r["member_id"]], "basis": r["basis"], "since_year": r["since_year"], "notes": []}
        if r["basis"] == "estimate" and r["registration"] in ("TFSA", "FHSA") and r["since_year"]:
            out.append({**base, **_estimate_room(conn, r, year)})
            continue
        contributed = r["contributed"] if r["contributed"] is not None else detected.get(
            (r["member_id"], r["registration"]), 0.0)
        out.append({**base, "room": r["room"],
                    "contributed": round(contributed or 0, 2), "detected": r["contributed"] is None,
                    "remaining": round(r["room"] - (contributed or 0), 2)})
    return out


def _estimate_room(conn: sqlite3.Connection, r: sqlite3.Row, year: int) -> dict:
    """Room from the rules: limits since you became eligible (TFSA) / opened it (FHSA), minus what
    you've put in, i.e. the book value of all your accounts of that kind (or your own figure)."""
    from . import room_rules

    snaps = _snapshots(conn)
    today = date.today().isoformat()
    book_total, missing = 0.0, []
    for a in conn.execute("SELECT id, name FROM accounts WHERE member_id = ? AND registration = ? AND archived = 0",
                          (r["member_id"], r["registration"])):
        s = _latest_before(snaps.get(a["id"], []), today)
        if s and s[2] is not None:
            book_total += s[2]
        else:
            missing.append(a["name"])
    put_in = r["contributed"] if r["contributed"] is not None else book_total
    notes = []
    if r["contributed"] is None and missing:
        notes.append(f"No book value for {', '.join(missing)}: add it with Update balance, or type what you've "
                     "put in overall")
    if r["registration"] == "TFSA":
        limit, extra = room_rules.tfsa_cumulative(r["since_year"], year)
        remaining = limit - put_in
        notes += extra
        notes.append("Withdrawals are added back the following January; CRA My Account has the exact figure")
    else:
        remaining, limit, extra = room_rules.fhsa_room(r["since_year"], year, put_in)
        notes += extra
    return {"room": float(limit), "contributed": round(put_in, 2), "detected": r["contributed"] is None,
            "remaining": round(remaining, 2), "notes": notes}


def budgets(conn: sqlite3.Connection) -> dict[str, float | None]:
    """Category budgets for the people in view, added up.

    The primary member's budgets are the ones on the categories table (the original "household"
    budgets); other people's live in member_budgets. Viewing several people sums theirs.
    """
    primary = scope.primary_id(conn)
    ids = scope.current()
    mine = {r["name"]: r["budget"] for r in conn.execute("SELECT name, budget FROM categories")}
    out: dict[str, float | None] = {name: (mine[name] if scope.owner_visible(conn, None) else None) for name in mine}
    others = conn.execute("SELECT member_id, category, budget FROM member_budgets WHERE member_id != ?",
                          (primary,)).fetchall()
    for r in others:
        if ids is not None and r["member_id"] not in ids:
            continue
        out[r["category"]] = round((out.get(r["category"]) or 0) + r["budget"], 2)
    return out


def payoff_months(balance: float, annual_rate: float | None, payment: float | None) -> int | None:
    if not payment or payment <= 0 or balance <= 0:
        return None
    r = (annual_rate or 0) / 100 / 12
    if r == 0:
        return math.ceil(balance / payment)
    if payment <= balance * r:
        return None  # payment doesn't cover interest
    return math.ceil(-math.log(1 - r * balance / payment) / math.log(1 + r))


def _last_statement_payments(conn: sqlite3.Connection, account_id: int, kind: str = "credit") -> dict | None:
    """Was the last statement's balance paid off? From the latest statement that has one before it.

    For a card: the balance owed at the start of the latest statement vs the payments made during it,
    and any interest charged. Paid in full = payments covered the previous balance.
    """
    st = conn.execute(
        "SELECT id, period_start, period_end, opening_balance o, closing_balance c FROM statements "
        "WHERE account_id = ? AND status = 'parsed' AND opening_balance IS NOT NULL "
        "ORDER BY period_end DESC LIMIT 1", (account_id,)).fetchone()
    if not st:
        return None
    paid = conn.execute("SELECT coalesce(sum(amount), 0) FROM transactions WHERE statement_id = ? AND amount > 0 "
                        "AND category IN ('Credit Card Payment', 'Transfer', 'Lent / Borrowed', 'Family Transfer')",
                        (st["id"],)).fetchone()[0]
    interest = -conn.execute("SELECT coalesce(sum(amount), 0) FROM transactions WHERE statement_id = ? AND amount < 0 "
                             "AND category = 'Fees/Interest' AND upper(description) LIKE '%INTEREST%'",
                             (st["id"],)).fetchone()[0]
    owed_before = st["o"] or 0
    if kind == "loan":
        status = "installment"  # loans and credit lines are paid down over time, not in full
    elif owed_before <= 0.005:
        status = "nothing_owed"
    elif paid >= owed_before - 0.01:  # interest on this statement can still be from an earlier carried balance
        status = "paid_in_full"
    else:
        status = "carried"
    return {"period_start": st["period_start"], "period_end": st["period_end"], "previous_balance": round(owed_before, 2),
            "paid": round(paid, 2), "interest": round(interest, 2), "status": status,
            "carried": round(max(owed_before - paid, 0), 2)}


def _interest_12m(conn: sqlite3.Connection, account_id: int) -> float:
    since = (date.today() - timedelta(days=365)).isoformat()
    return round(-conn.execute(
        "SELECT coalesce(sum(amount), 0) FROM transactions WHERE account_id = ? AND amount < 0 AND date >= ? "
        "AND category = 'Fees/Interest'", (account_id, since)).fetchone()[0], 2)


def debts(conn: sqlite3.Connection) -> dict:
    now = balances_at(conn, date.today().isoformat())
    accts = {a["id"]: a for a in _accounts(conn)}
    items = []
    for i in now["items"]:
        if i["side"] != "liability":
            continue
        a = accts.get(i["account_id"], {})
        months = payoff_months(i["balance"], a.get("interest_rate"), a.get("payment"))
        rate = a.get("interest_rate")
        items.append({**i, "credit_limit": a.get("credit_limit"), "interest_rate": rate,
                      "payment": a.get("payment"),
                      "last_statement": _last_statement_payments(conn, i["account_id"], i["type"]) if i["account_id"] else None,
                      "interest_12m": _interest_12m(conn, i["account_id"]) if i["account_id"] else 0.0,
                      "yearly_interest": round(i["balance"] * rate / 100, 2) if rate else None,
                      "utilization": round(i["balance"] / a["credit_limit"], 4) if a.get("credit_limit") else None,
                      "payoff_months": months,
                      "payoff_date": shift_month(date.today().strftime("%Y-%m"), months) if months else None})
    snaps, flows = _snapshots(conn), _flows(conn)
    series = []
    for m in all_months(conn)[-24:]:
        row = {"month": m}
        for a in accts.values():
            if a["type"] in LIABILITY_TYPES:
                s = account_balance(a, month_end(m), snaps, flows)
                if s:
                    row[a["name"]] = round(s[1], 2)
        series.append(row)
    clause, args = scope.account_filter()
    interest = [dict(r) for r in conn.execute(
        "SELECT substr(t.date,1,7) month, round(-sum(t.amount),2) amount FROM transactions t "
        "JOIN accounts a ON a.id = t.account_id WHERE t.category = 'Fees/Interest' AND t.amount < 0"
        f"{clause} GROUP BY 1 ORDER BY 1", args)]
    return {"items": items, "total": now["liabilities"], "series": series, "interest_and_fees": interest}
