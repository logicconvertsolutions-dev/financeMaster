var T="",N=`"""Aggregations behind the dashboard pages."""
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
    """Sum of the account's transactions dated on or before \`day\`."""
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


_REG_WORDS = {"TFSA": re.compile(r"\\bTFSA\\b|\\bCELI\\b", re.I), "RRSP": re.compile(r"\\bRR?SP\\b|\\bREER\\b", re.I),
              "FHSA": re.compile(r"\\bFHSA\\b|\\bCELIAPP\\b", re.I)}
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
`,b=`"""FastAPI app: JSON API under /api, the built React dashboard everywhere else."""
import json
import os
import re
import shutil
import sqlite3
import zipfile
from contextlib import asynccontextmanager
from datetime import date, datetime
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import analytics, categorize, checks, coverage, family, insights, insurance, members, people, recurring, scope, snapshot, transfers
from .config import BACKUP_DIR, DATA_DIR, FRONTEND_DIST, ROOT, STATEMENT_EXTENSIONS, STATEMENTS_DIR, code_version
from .db import init_db, rows, session
from .ingest import manage, passwords, scanner
from .ingest.model import ParsedStatement, ParsedTx


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    with session() as conn:
        scanner.upgrade_old_parses(conn)
        scanner.scan(conn)
        scanner.refresh_derived(conn)  # picks up keywords added to the built-in library since last run
    snapshot.write_soon(2)  # the phone gets whatever this start-up scan imported
    yield


app = FastAPI(title="Finance Master", lifespan=lifespan)
STARTED_CODE_VERSION = code_version()  # run.py compares this with the files on disk


@app.middleware("http")
async def member_scope(request: Request, call_next):
    """\`?members=1,2\` limits every figure to those family members' accounts (absent = everyone)."""
    with scope.use(scope.parse(request.query_params.get("members"))):
        response = await call_next(request)
    if request.method != "GET" and request.url.path.startswith("/api/") and response.status_code < 400:
        snapshot.write_soon()  # keep the phone's copy current after imports and edits
    return response


# ---------------------------------------------------------------- scanning & status

@app.post("/api/scan")
def scan():
    with session() as conn:
        return scanner.scan(conn)


@app.get("/api/status")
def status():
    with session() as conn:
        counts = {r["status"]: r["n"] for r in conn.execute("SELECT status, count(*) n FROM statements GROUP BY status")}
        n_tx = conn.execute("SELECT count(*) FROM transactions").fetchone()[0]
        n_acct = conn.execute("SELECT count(*) FROM accounts WHERE archived = 0").fetchone()[0]
    return {"statements": counts, "transactions": n_tx, "accounts": n_acct,
            "statements_dir": str(STATEMENTS_DIR), "today": date.today().isoformat(),
            "pid": os.getpid(), "code_version": STARTED_CODE_VERSION}


# ---------------------------------------------------------------- dashboard pages

@app.get("/api/overview")
def overview():
    with session() as conn:
        return analytics.overview(conn)


@app.get("/api/review")
def review(month: str | None = None):
    with session() as conn:
        return insights.review(conn, month)


@app.get("/api/upcoming")
def upcoming(days: int = 30):
    """Recurring bills learned from history and when each is next expected."""
    with session() as conn:
        return recurring.upcoming(conn, days)


@app.get("/api/coverage")
def statement_coverage(months: int = 12):
    """Which months each account's statements cover (full / partial / missing)."""
    with session() as conn:
        return coverage.grid(conn, months)


@app.get("/api/checks")
def consistency_checks():
    """Cross-page consistency checks for the people being viewed."""
    with session() as conn:
        results = checks.run(conn)
    return {"results": results, "errors": sum(1 for r in results if r["severity"] == "error"),
            "warnings": sum(1 for r in results if r["severity"] == "warn")}


@app.get("/api/family")
def family_compare(month: str | None = None):
    with session() as conn:
        return family.compare(conn, month)


@app.get("/api/spending")
def spending(months: int = 12):
    with session() as conn:
        return analytics.spending(conn, months)


@app.get("/api/networth")
def networth():
    with session() as conn:
        now = analytics.balances_at(conn, date.today().isoformat())
        return {"series": analytics.networth_series(conn, 60), "now": now}


@app.get("/api/investments")
def investments():
    with session() as conn:
        return analytics.investments(conn)


@app.get("/api/debts")
def debts():
    with session() as conn:
        return analytics.debts(conn)


# ---------------------------------------------------------------- transactions & categories

@app.get("/api/transactions")
def transactions(month: str | None = None, category: str | None = None, account_id: int | None = None,
                 q: str | None = None, include_transfers: bool = True, limit: int = 1000):
    clause, args = scope.account_filter()
    sql = ("SELECT t.id, t.date, t.description, t.merchant, t.amount, t.category, t.category_source, "
           "t.is_transfer, t.account_id, a.name account, a.type account_type, m.name member "
           "FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN members m ON m.id = a.member_id "
           f"WHERE 1=1{clause}")
    if month:
        sql += " AND substr(t.date,1,7) = ?"
        args.append(month)
    if category:
        sql += " AND coalesce(t.category,'Other') = ?"
        args.append(category)
    if account_id:
        sql += " AND t.account_id = ?"
        args.append(account_id)
    if q:
        sql += " AND upper(t.description) LIKE ?"
        args.append(f"%{q.upper()}%")
    if not include_transfers:
        sql += " AND t.is_transfer = 0"
    sql += " ORDER BY t.date DESC, t.id DESC LIMIT ?"
    args.append(limit)
    with session() as conn:
        return rows(conn.execute(sql, args))


class TxUpdate(BaseModel):
    category: str
    apply_to_similar: bool = True


@app.patch("/api/transactions/{tx_id}")
def update_transaction(tx_id: int, body: TxUpdate):
    with session() as conn:
        if not conn.execute("SELECT 1 FROM categories WHERE name = ?", (body.category,)).fetchone():
            raise HTTPException(400, f"Unknown category {body.category}")
        try:
            changed = categorize.learn(conn, tx_id, body.category, body.apply_to_similar)
        except KeyError:
            raise HTTPException(404, "Transaction not found")
        transfers.detect(conn)
        return {"changed": changed}


@app.get("/api/categories")
def categories():
    """Categories with the budget that applies to the current view (a person's own, or household)."""
    with session() as conn:
        out = rows(conn.execute("SELECT * FROM categories ORDER BY kind, name"))
        budget_map = analytics.budgets(conn)
        for c in out:
            c["own_budget"] = c["budget"]           # the primary member's own budget (categories table)
            c["budget"] = budget_map.get(c["name"])  # total for the people in view
        return out


class MemberBudgetBody(BaseModel):
    member_id: int
    category: str
    budget: float | None = None


@app.put("/api/member-budgets")
def set_member_budget(body: MemberBudgetBody):
    with session() as conn:
        if body.member_id == members.primary_id(conn):  # your budgets are the categories' own budget column
            conn.execute("UPDATE categories SET budget = ? WHERE name = ?", (body.budget, body.category))
            return {"ok": True}
        if body.budget is None:
            conn.execute("DELETE FROM member_budgets WHERE member_id = ? AND category = ?", (body.member_id, body.category))
        else:
            conn.execute("INSERT INTO member_budgets(member_id, category, budget) VALUES (?,?,?) ON CONFLICT"
                         "(member_id, category) DO UPDATE SET budget = excluded.budget",
                         (body.member_id, body.category, body.budget))
    return {"ok": True}


class CategoryBody(BaseModel):
    name: str
    kind: str = "discretionary"
    budget: float | None = None


@app.post("/api/categories")
def create_category(body: CategoryBody):
    with session() as conn:
        conn.execute("INSERT INTO categories(name, kind, budget) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET "
                     "kind = excluded.kind, budget = excluded.budget", (body.name.strip(), body.kind, body.budget))
        transfers.detect(conn)
    return {"ok": True}


@app.get("/api/rules")
def list_rules():
    """Every rule, with how many transactions it currently categorizes (the winning rule only)."""
    with session() as conn:
        rules = categorize.load_rules(conn)
        hits: dict[int, int] = {}
        for tx in conn.execute("SELECT description FROM transactions WHERE category_source != 'user'"):
            r = categorize.match_rule(tx["description"], rules)
            if r:
                hits[r[3]] = hits.get(r[3], 0) + 1
        out = rows(conn.execute("SELECT * FROM category_rules ORDER BY category, pattern"))
        for r in out:
            r["matches"] = hits.get(r["id"], 0)
        return out


class RuleBody(BaseModel):
    pattern: str
    category: str


def _clean_pattern(pattern: str) -> str:
    pattern = re.sub(r"\\s+", " ", pattern.upper()).strip()
    if len(pattern) < 2:
        raise HTTPException(400, "Keyword too short")
    return pattern


@app.post("/api/rules")
def add_rule(body: RuleBody):
    pattern = _clean_pattern(body.pattern)
    with session() as conn:
        categorize.save_user_rule(conn, pattern, body.category)
        scanner.refresh_derived(conn)
    return {"ok": True}


class RulePatch(BaseModel):
    pattern: str | None = None
    category: str | None = None
    enabled: bool | None = None


@app.patch("/api/rules/{rule_id}")
def update_rule(rule_id: int, body: RulePatch):
    with session() as conn:
        rule = conn.execute("SELECT * FROM category_rules WHERE id = ?", (rule_id,)).fetchone()
        if not rule:
            raise HTTPException(404)
        pattern = _clean_pattern(body.pattern) if body.pattern is not None else rule["pattern"]
        category = body.category or rule["category"]
        enabled = rule["enabled"] if body.enabled is None else int(body.enabled)
        edited = pattern != rule["pattern"] or category != rule["category"]
        try:
            conn.execute(
                "UPDATE category_rules SET pattern = ?, category = ?, enabled = ?, "
                "source = CASE WHEN ? THEN 'user' ELSE source END, priority = CASE WHEN ? THEN 10 ELSE priority END "
                "WHERE id = ?", (pattern, category, enabled, edited, edited, rule_id))
        except sqlite3.IntegrityError:
            raise HTTPException(400, f'A rule for "{pattern}" already exists')
        if edited and rule["source"] == "seed" and pattern != rule["pattern"]:
            # keep the old built-in keyword switched off so the next startup doesn't re-add it
            conn.execute("INSERT OR IGNORE INTO category_rules(pattern, category, source, enabled) "
                         "VALUES (?, ?, 'seed', 0)", (rule["pattern"], rule["category"]))
        scanner.refresh_derived(conn)
    return {"ok": True}


@app.delete("/api/rules/{rule_id}")
def delete_rule(rule_id: int):
    """Your rules are deleted; built-in ones are switched off (so they don't come back on restart)."""
    with session() as conn:
        conn.execute("UPDATE category_rules SET enabled = 0 WHERE id = ? AND source = 'seed'", (rule_id,))
        conn.execute("DELETE FROM category_rules WHERE id = ? AND source = 'user'", (rule_id,))
        scanner.refresh_derived(conn)
    return {"ok": True}


@app.get("/api/rules/uncategorized")
def uncategorized(limit: int = 60):
    """Merchants no keyword recognises (they fell back to Other / Income), biggest first."""
    with session() as conn:
        rules = categorize.load_rules(conn)
        groups: dict[str, dict] = {}
        for t in conn.execute(
            "SELECT t.merchant, t.description, t.amount, t.date FROM transactions t "
            "JOIN accounts a ON a.id = t.account_id WHERE t.category_source = 'rule' AND t.is_transfer = 0 "
            "AND a.type IN ('chequing','savings','credit') ORDER BY t.date"
        ):
            if categorize.match_rule(t["description"], rules):
                continue
            g = groups.setdefault(t["merchant"], {"merchant": t["merchant"], "count": 0, "total": 0.0,
                                                  "last_date": t["date"], "example": t["description"]})
            g["count"] += 1
            g["total"] = round(g["total"] - t["amount"], 2)
            g["last_date"], g["example"] = t["date"], t["description"]
        out = sorted(groups.values(), key=lambda g: -abs(g["total"]))[:limit]
        for g in out:
            g["is_income"] = int(g["total"] < 0)
        return out


class RuleTest(BaseModel):
    description: str


@app.post("/api/rules/test")
def test_rule(body: RuleTest):
    with session() as conn:
        r = categorize.match_rule(body.description, categorize.load_rules(conn))
    return {"category": r[1] if r else None, "pattern": r[0] if r else None,
            "merchant": categorize.merchant_key(body.description)}


# ---------------------------------------------------------------- family members

@app.get("/api/members")
def members_list():
    with session() as conn:
        return {"members": members.list_members(conn), "groups": members.list_groups(conn)}


class MemberBody(BaseModel):
    name: str | None = None
    folder: str | None = None
    color: str | None = None


@app.post("/api/members")
def members_create(body: MemberBody):
    if not body.name:
        raise HTTPException(400, "Name is required")
    with session() as conn:
        try:
            return {"id": members.create_member(conn, body.name, body.folder)}
        except (ValueError, sqlite3.IntegrityError) as e:
            raise HTTPException(400, str(e) if isinstance(e, ValueError) else "That name or folder is taken")


@app.patch("/api/members/{member_id}")
def members_update(member_id: int, body: MemberBody):
    with session() as conn:
        try:
            members.update_member(conn, member_id, body.name, body.color)
        except sqlite3.IntegrityError:
            raise HTTPException(400, "That name is taken")
    return {"ok": True}


@app.delete("/api/members/{member_id}")
def members_delete(member_id: int):
    with session() as conn:
        try:
            members.delete_member(conn, member_id)
        except KeyError:
            raise HTTPException(404)
        except ValueError as e:
            raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/members/primary/move-files")
def members_move_primary(body: MemberBody):
    """Give yourself a folder (statements/<name>) and move your existing top-level files into it."""
    if not body.name:
        raise HTTPException(400, "Name is required")
    with session() as conn:
        try:
            return members.move_primary_files(conn, body.name)
        except ValueError as e:
            raise HTTPException(400, str(e))


class GroupBody(BaseModel):
    name: str
    member_ids: list[int]


@app.post("/api/member-groups")
def groups_create(body: GroupBody):
    with session() as conn:
        try:
            return {"id": members.save_group(conn, body.name, body.member_ids)}
        except ValueError as e:
            raise HTTPException(400, str(e))
        except sqlite3.IntegrityError:
            raise HTTPException(400, "A group with that name exists")


@app.delete("/api/member-groups/{group_id}")
def groups_delete(group_id: int):
    with session() as conn:
        conn.execute("DELETE FROM member_groups WHERE id = ?", (group_id,))
    return {"ok": True}


# ---------------------------------------------------------------- people & loans

@app.get("/api/people")
def people_list():
    with session() as conn:
        return people.list_contacts(conn)


class ContactBody(BaseModel):
    name: str
    keywords: str | None = None
    note: str | None = None


@app.post("/api/people")
def people_create(body: ContactBody):
    with session() as conn:
        try:
            return {"id": people.save_contact(conn, body.name, body.keywords, body.note)}
        except sqlite3.IntegrityError:
            raise HTTPException(400, f'"{body.name}" already exists')
        except ValueError as e:
            raise HTTPException(400, str(e))


@app.put("/api/people/{contact_id}")
def people_update(contact_id: int, body: ContactBody):
    with session() as conn:
        try:
            people.save_contact(conn, body.name, body.keywords, body.note, contact_id)
        except sqlite3.IntegrityError:
            raise HTTPException(400, f'"{body.name}" already exists')
    return {"ok": True}


@app.delete("/api/people/{contact_id}")
def people_delete(contact_id: int):
    with session() as conn:
        people.delete_contact(conn, contact_id)
        transfers.detect(conn)
    return {"ok": True}


@app.get("/api/people/candidates")
def people_candidates(q: str | None = None):
    with session() as conn:
        return people.candidates(conn, q)


@app.get("/api/people/{contact_id}")
def people_detail(contact_id: int):
    with session() as conn:
        try:
            return people.contact_detail(conn, contact_id)
        except KeyError:
            raise HTTPException(404)


class EntryBody(BaseModel):
    transaction_ids: list[int] = []
    date: str | None = None
    amount: float | None = None      # manual: negative = you gave, positive = you received
    note: str | None = None


@app.post("/api/people/{contact_id}/entries")
def people_add_entries(contact_id: int, body: EntryBody):
    with session() as conn:
        if not conn.execute("SELECT 1 FROM contacts WHERE id = ?", (contact_id,)).fetchone():
            raise HTTPException(404)
        for tx_id in body.transaction_ids:
            people.link_transaction(conn, contact_id, tx_id, body.note)
        if not body.transaction_ids:
            if not body.date or not body.amount:
                raise HTTPException(400, "Date and amount are required")
            body.date = _not_future(body.date)
            people.add_manual(conn, contact_id, body.date, body.amount, body.note)
        transfers.detect(conn)
    return {"ok": True}


@app.delete("/api/people/entries/{entry_id}")
def people_delete_entry(entry_id: int):
    with session() as conn:
        try:
            people.delete_entry(conn, entry_id)
        except KeyError:
            raise HTTPException(404)
        transfers.detect(conn)
    return {"ok": True}


# ---------------------------------------------------------------- insurance

@app.get("/api/insurance")
def insurance_summary():
    with session() as conn:
        return insurance.summary(conn)


class PolicyBody(BaseModel):
    name: str
    provider: str | None = None
    policy_type: str = "other"
    coverages: list[dict] = []
    premium: float | None = None
    frequency: str = "monthly"
    paid_via: str = "bank"
    match_pattern: str | None = None
    insured: str | None = None
    reference: str | None = None
    renewal_date: str | None = None
    notes: str | None = None
    active: bool = True
    insured_member_id: int | None = None


def _policy_values(b: PolicyBody) -> tuple:
    if b.policy_type not in insurance.POLICY_TYPES:
        raise HTTPException(400, "Unknown policy type")
    if b.frequency not in insurance.PER_YEAR:
        raise HTTPException(400, "Unknown frequency")
    coverages = [{"type": c.get("type") or b.policy_type, "amount": c.get("amount") or None,
                  "detail": c.get("detail") or ""} for c in b.coverages]
    return (b.name.strip(), b.provider or None, b.policy_type, json.dumps(coverages), b.premium, b.frequency,
            b.paid_via, (b.match_pattern or "").strip() or None, b.insured or None, b.reference or None,
            b.renewal_date or None, b.notes or None, int(b.active), b.insured_member_id or None)


_POLICY_COLS = ("name, provider, policy_type, coverages_json, premium, frequency, paid_via, match_pattern, "
                "insured, reference, renewal_date, notes, active, insured_member_id")


@app.post("/api/insurance/policies")
def create_policy(body: PolicyBody):
    with session() as conn:
        cur = conn.execute(f"INSERT INTO insurance_policies({_POLICY_COLS}) VALUES ({','.join('?' * 14)})",
                           _policy_values(body))
        return {"id": cur.lastrowid}


@app.put("/api/insurance/policies/{policy_id}")
def update_policy(policy_id: int, body: PolicyBody):
    sets = ", ".join(f"{c.strip()} = ?" for c in _POLICY_COLS.split(","))
    with session() as conn:
        conn.execute(f"UPDATE insurance_policies SET {sets} WHERE id = ?", (*_policy_values(body), policy_id))
    return {"ok": True}


@app.delete("/api/insurance/policies/{policy_id}")
def delete_policy(policy_id: int):
    with session() as conn:
        conn.execute("DELETE FROM insurance_policies WHERE id = ?", (policy_id,))
    return {"ok": True}


# ---------------------------------------------------------------- accounts, manual items, room

@app.get("/api/accounts")
def accounts():
    with session() as conn:
        clause, args = scope.account_filter()
        accts = rows(conn.execute(
            "SELECT a.*, m.name member FROM accounts a LEFT JOIN members m ON m.id = a.member_id "
            f"WHERE 1=1{clause} ORDER BY a.archived, m.is_primary DESC, a.type, a.name", args))
        latest = analytics.balances_at(conn, date.today().isoformat())
        by_id = {i["account_id"]: i for i in latest["items"] if i["account_id"]}
        counts = {r["account_id"]: (r["n"], r["s"]) for r in conn.execute(
            "SELECT account_id, count(*) n, count(DISTINCT statement_id) s FROM transactions GROUP BY account_id")}
        for a in accts:
            a["transactions"], a["statements"] = counts.get(a["id"], (0, 0))
            b = by_id.get(a["id"])
            a["balance"], a["balance_as_of"] = (b["balance"], b["as_of"]) if b else (None, None)
        return accts


class AccountBody(BaseModel):
    institution: str | None = None
    name: str | None = None
    type: str | None = None
    registration: str | None = None
    last4: str | None = None
    credit_limit: float | None = None
    interest_rate: float | None = None
    payment: float | None = None
    archived: bool | None = None
    member_id: int | None = None


@app.post("/api/accounts")
def create_account(body: AccountBody):
    if not (body.institution and body.name and body.type):
        raise HTTPException(400, "institution, name and type are required")
    with session() as conn:
        cur = conn.execute(
            "INSERT INTO accounts(institution, name, type, registration, last4, credit_limit, interest_rate, payment, "
            "member_id) VALUES (?,?,?,?,?,?,?,?,?)",
            (body.institution, body.name, body.type, body.registration or None, body.last4 or None,
             body.credit_limit, body.interest_rate, body.payment, body.member_id or members.primary_id(conn)))
        return {"id": cur.lastrowid}


@app.patch("/api/accounts/{account_id}")
def update_account(account_id: int, body: AccountBody):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        return {"ok": True}
    if "archived" in fields:
        fields["archived"] = int(bool(fields["archived"]))
    sets = ", ".join(f"{k} = ?" for k in fields)
    with session() as conn:
        conn.execute(f"UPDATE accounts SET {sets} WHERE id = ?", (*fields.values(), account_id))
    return {"ok": True}


@app.delete("/api/accounts/{account_id}")
def delete_account(account_id: int, delete_files: bool = False):
    with session() as conn:
        try:
            result = manage.delete_account(conn, account_id, delete_files)
        except KeyError:
            raise HTTPException(404, "Account not found")
        scanner.refresh_derived(conn)
        return result


class MergeBody(BaseModel):
    into: int


@app.post("/api/accounts/{account_id}/merge")
def merge_account(account_id: int, body: MergeBody):
    with session() as conn:
        try:
            result = manage.merge_accounts(conn, account_id, body.into)
        except KeyError:
            raise HTTPException(404, "Account not found")
        except ValueError as e:
            raise HTTPException(400, str(e))
        scanner.refresh_derived(conn)
        return result


class BalanceBody(BaseModel):
    date: str
    balance: float
    book_value: float | None = None


def _not_future(day: str) -> str:
    """Manual entries are 'as of' a day that has happened (a browser in UTC can send tomorrow)."""
    return min(day, date.today().isoformat())


@app.post("/api/accounts/{account_id}/balance")
def set_balance(account_id: int, body: BalanceBody):
    body.date = _not_future(body.date)
    with session() as conn:
        conn.execute(
            "INSERT INTO balance_snapshots(account_id, date, balance, book_value, source) VALUES (?,?,?,?, 'manual') "
            "ON CONFLICT(account_id, date, source) DO UPDATE SET balance = excluded.balance, book_value = excluded.book_value",
            (account_id, body.date, body.balance, body.book_value))
    return {"ok": True}


@app.get("/api/manual")
def manual_items():
    with session() as conn:
        clause, args = scope.owner_filter(conn, "i.member_id")
        return rows(conn.execute(
            "SELECT i.*, coalesce(m.name, p.name) owner FROM manual_items i LEFT JOIN members m ON m.id = i.member_id "
            f"JOIN members p ON p.is_primary = 1 WHERE 1=1{clause} ORDER BY i.name, i.as_of DESC", args))


class ManualBody(BaseModel):
    name: str
    kind: str
    value: float
    as_of: str
    note: str | None = None
    member_id: int | None = None  # None = yours (the primary member)


@app.post("/api/manual")
def add_manual(body: ManualBody):
    if body.kind not in ("asset", "liability"):
        raise HTTPException(400, "kind must be asset or liability")
    body.as_of = _not_future(body.as_of)
    with session() as conn:
        conn.execute("INSERT INTO manual_items(name, kind, value, as_of, note, member_id) VALUES (?,?,?,?,?,?)",
                     (body.name.strip(), body.kind, body.value, body.as_of, body.note, body.member_id or None))
    return {"ok": True}


@app.delete("/api/manual/{item_id}")
def delete_manual(item_id: int):
    with session() as conn:
        conn.execute("DELETE FROM manual_items WHERE id = ?", (item_id,))
    return {"ok": True}


@app.get("/api/room")
def get_room(year: int | None = None):
    with session() as conn:
        return analytics.contribution_room(conn, year or date.today().year)


class RoomBody(BaseModel):
    year: int
    registration: str
    room: float | None = None
    contributed: float | None = None
    member_id: int | None = None
    basis: str = "cra"            # cra | estimate
    since_year: int | None = None


@app.get("/api/room/candidates")
def room_candidates(year: int | None = None):
    with session() as conn:
        return analytics.contribution_candidates(conn, year or date.today().year)


@app.get("/api/room/tags")
def room_tags(year: int | None = None):
    """Transfers you've already marked (so they can be changed or undone)."""
    with session() as conn:
        clause, args = scope.account_filter("a")
        return rows(conn.execute(
            "SELECT g.account_id, g.date, g.amount raw_amount, -g.amount amount, g.description, g.registration, "
            "a.name account FROM contribution_tags g JOIN accounts a ON a.id = g.account_id "
            f"WHERE substr(g.date,1,4) = ?{clause} ORDER BY g.date DESC", [str(year or date.today().year), *args]))


class ContributionTag(BaseModel):
    account_id: int
    date: str
    amount: float           # the transaction's amount as stored (negative: money out)
    description: str
    registration: str       # TFSA | RRSP | FHSA | NONE (not a contribution) | "" to undo


@app.put("/api/room/tag")
def room_tag(body: ContributionTag):
    with session() as conn:
        key = (body.account_id, body.date, round(body.amount, 2), body.description)
        conn.execute("DELETE FROM contribution_tags WHERE account_id = ? AND date = ? AND round(amount, 2) = ? "
                     "AND description = ?", key)
        if body.registration:
            if body.registration not in ("TFSA", "RRSP", "FHSA", "NONE"):
                raise HTTPException(400, "Unknown account kind")
            conn.execute("INSERT INTO contribution_tags VALUES (?,?,?,?,?)", (*key, body.registration))
    return {"ok": True}


@app.put("/api/room")
def set_room(body: RoomBody):
    with session() as conn:
        if body.basis == "estimate":
            if body.registration not in ("TFSA", "FHSA"):
                raise HTTPException(400, "RRSP room depends on your income: use the figure from CRA.")
            if not body.since_year or not 1990 <= body.since_year <= body.year:
                raise HTTPException(400, "Enter the year you became eligible (TFSA) or opened the account (FHSA).")
        elif body.room is None:
            raise HTTPException(400, "Enter the room from CRA My Account.")
        conn.execute(
            "INSERT INTO contribution_room(year, registration, member_id, room, contributed, basis, since_year) "
            "VALUES (?,?,?,?,?,?,?) ON CONFLICT(year, registration, member_id) DO UPDATE SET room = excluded.room, "
            "contributed = excluded.contributed, basis = excluded.basis, since_year = excluded.since_year",
            (body.year, body.registration, body.member_id or members.primary_id(conn), body.room or 0,
             body.contributed, body.basis, body.since_year))
    return {"ok": True}


# ---------------------------------------------------------------- statements inbox

@app.get("/api/statements")
def list_statements():
    with session() as conn:
        out = rows(conn.execute(
            "SELECT s.id, s.path, s.status, s.message, s.institution, s.detected_type, s.period_start, s.period_end, "
            "s.opening_balance, s.closing_balance, s.market_value, s.parser, s.imported_at, s.account_id, "
            "s.duplicates, "
            "a.name account, (SELECT count(*) FROM transactions t WHERE t.statement_id = s.id) n_tx "
            "FROM statements s LEFT JOIN accounts a ON a.id = s.account_id "
            "ORDER BY s.status = 'parsed', s.status = 'ignored', coalesce(s.period_end, '') DESC, s.id DESC"))
        wanted = scope.current()
        owners = {s["id"]: members.member_for_path(conn, ROOT / s["path"]) for s in out} if wanted else {}
    if wanted:
        out = [s for s in out if owners[s["id"]] in wanted]
    for s in out:
        s["file_exists"] = (ROOT / s["path"]).exists()
    return out


@app.get("/api/statements/{statement_id}")
def get_statement(statement_id: int):
    with session() as conn:
        s = conn.execute("SELECT * FROM statements WHERE id = ?", (statement_id,)).fetchone()
        if not s:
            raise HTTPException(404)
        s = dict(s)
        if s["staged_json"]:
            s["staged"] = json.loads(s["staged_json"])
        else:
            s["staged"] = {
                "transactions": rows(conn.execute(
                    "SELECT date, description, amount FROM transactions WHERE statement_id = ? ORDER BY date, id",
                    (statement_id,))),
                "warnings": [],
            }
        s.pop("staged_json", None)
        return s


class UnlockBody(BaseModel):
    password: str
    remember: bool = False
    label: str | None = None


@app.post("/api/statements/{statement_id}/unlock")
def unlock(statement_id: int, body: UnlockBody):
    with session() as conn:
        s = conn.execute("SELECT path FROM statements WHERE id = ?", (statement_id,)).fetchone()
        if not s:
            raise HTTPException(404)
        result = scanner.parse_statement_file(conn, statement_id, ROOT / s["path"], password=body.password)
        if result == "locked":
            raise HTTPException(400, "That password didn't work.")
        if body.remember:
            passwords.remember(conn, body.label or Path(s["path"]).stem, body.password)
        scanner.refresh_derived(conn)
        return {"status": result}


@app.post("/api/statements/{statement_id}/reparse")
def reparse(statement_id: int):
    with session() as conn:
        s = conn.execute("SELECT path FROM statements WHERE id = ?", (statement_id,)).fetchone()
        if not s:
            raise HTTPException(404)
        for table in ("transactions", "balance_snapshots", "holdings"):
            conn.execute(f"DELETE FROM {table} WHERE statement_id = ?", (statement_id,))
        result = scanner.parse_statement_file(conn, statement_id, ROOT / s["path"])
        scanner.refresh_derived(conn)
        return {"status": result}


class ApproveBody(BaseModel):
    account_id: int | None = None
    new_account: AccountBody | None = None
    period_start: str | None = None
    period_end: str | None = None
    opening_balance: float | None = None
    closing_balance: float | None = None
    market_value: float | None = None
    book_value: float | None = None
    transactions: list[dict]


@app.post("/api/statements/{statement_id}/approve")
def approve(statement_id: int, body: ApproveBody):
    with session() as conn:
        s = conn.execute("SELECT * FROM statements WHERE id = ?", (statement_id,)).fetchone()
        if not s:
            raise HTTPException(404)
        account_id = body.account_id
        if account_id is None:
            na = body.new_account
            if not na or not (na.institution and na.name and na.type):
                raise HTTPException(400, "Pick an existing account or describe a new one.")
            account_id = conn.execute(
                "INSERT INTO accounts(institution, name, type, registration, last4, member_id) VALUES (?,?,?,?,?,?)",
                (na.institution, na.name, na.type, na.registration or None, na.last4 or None,
                 scanner.statement_member(conn, statement_id))).lastrowid
        acct = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
        staged = json.loads(s["staged_json"]) if s["staged_json"] else {}
        txs = [ParsedTx(str(t["date"]), str(t["description"]), float(t["amount"])) for t in body.transactions
               if t.get("date") and t.get("description") is not None and t.get("amount") not in (None, "")]
        dates = sorted(t.date for t in txs)
        parsed = ParsedStatement(
            institution=acct["institution"], account_type=acct["type"], registration=acct["registration"],
            last4=acct["last4"],
            period_start=body.period_start or (dates[0] if dates else None),
            period_end=body.period_end or (dates[-1] if dates else None),
            opening_balance=body.opening_balance, closing_balance=body.closing_balance,
            market_value=body.market_value, book_value=body.book_value,
            credit_limit=staged.get("credit_limit"), transactions=txs,
            parser=(s["parser"] or "generic") + "+reviewed",
        )
        scanner.commit_statement(conn, statement_id, parsed, account_id)
        scanner.refresh_derived(conn)
        return {"ok": True, "account_id": account_id}


@app.delete("/api/statements/{statement_id}")
def delete_statement(statement_id: int):
    """Remove the file's data and move the file to statements/_deleted/."""
    with session() as conn:
        try:
            result = manage.delete_statement_file(conn, statement_id)
        except KeyError:
            raise HTTPException(404, "Statement not found")
        scanner.refresh_derived(conn)
        return result


@app.post("/api/statements/{statement_id}/ignore")
def ignore(statement_id: int):
    """Remove a statement's data but remember the file so rescans skip it."""
    with session() as conn:
        for table in ("transactions", "balance_snapshots", "holdings"):
            conn.execute(f"DELETE FROM {table} WHERE statement_id = ?", (statement_id,))
        conn.execute("UPDATE statements SET status = 'ignored', staged_json = NULL, message = 'Ignored by you.' "
                     "WHERE id = ?", (statement_id,))
        scanner.refresh_derived(conn)
    return {"ok": True}


@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...), member_id: int | None = None):
    folder = None
    if member_id:
        with session() as conn:
            row = conn.execute("SELECT folder FROM members WHERE id = ?", (member_id,)).fetchone()
            folder = row["folder"] if row else None
    base = STATEMENTS_DIR / folder if folder else STATEMENTS_DIR
    target = base / date.today().strftime("%Y-%m")
    target.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        name = Path(f.filename or "statement.pdf").name
        if Path(name).suffix.lower() not in STATEMENT_EXTENSIONS:
            continue
        dest = target / name
        i = 1
        while dest.exists():
            dest = target / f"{Path(name).stem} ({i}){Path(name).suffix}"
            i += 1
        with dest.open("wb") as out:
            shutil.copyfileobj(f.file, out)
        saved.append(dest.relative_to(ROOT).as_posix())
    with session() as conn:
        summary = scanner.scan(conn)
    return {"saved": saved, **summary}


@app.get("/api/passwords")
def password_labels():
    with session() as conn:
        return passwords.labels(conn)


@app.delete("/api/passwords/{label}")
def forget_password(label: str):
    with session() as conn:
        passwords.forget(conn, label)
    return {"ok": True}


@app.post("/api/backup")
def backup():
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    db_copy = BACKUP_DIR / f"finance-{stamp}.db"
    src = sqlite3.connect(DATA_DIR / "finance.db")
    dst = sqlite3.connect(db_copy)
    src.backup(dst)  # consistent copy even while the app is running
    src.close()
    dst.close()
    archive = BACKUP_DIR / f"finance-backup-{stamp}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(db_copy, "data/finance.db")
        for p in STATEMENTS_DIR.rglob("*"):
            if p.is_file():
                z.write(p, p.relative_to(ROOT).as_posix())
    db_copy.unlink()
    return {"path": str(archive)}


# ---------------------------------------------------------------- phone snapshot

class SnapshotSettings(BaseModel):
    folder: str
    passphrase: str | None = None  # None keeps the saved one


@app.get("/api/snapshot")
def snapshot_status():
    with session() as conn:
        return snapshot.status(conn)


@app.put("/api/snapshot")
def snapshot_configure(body: SnapshotSettings):
    with session() as conn:
        try:
            snapshot.configure(conn, body.folder, body.passphrase)
        except ValueError as e:
            raise HTTPException(400, str(e))
        snapshot.write(conn)
        return snapshot.status(conn)


@app.post("/api/snapshot")
def snapshot_write_now():
    with session() as conn:
        if snapshot.write(conn) is None:
            raise HTTPException(400, "The phone snapshot isn't set up yet")
        return snapshot.status(conn)


@app.delete("/api/snapshot")
def snapshot_disable():
    with session() as conn:
        snapshot.disable(conn)
        return snapshot.status(conn)


# ---------------------------------------------------------------- frontend

@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(404)
    candidate = (FRONTEND_DIST / full_path).resolve()
    if full_path and candidate.is_file() and FRONTEND_DIST.resolve() in candidate.parents:
        return FileResponse(candidate)
    index = FRONTEND_DIST / "index.html"
    if index.exists():
        return FileResponse(index)
    return {"message": "Frontend not built. Run: cd frontend && npm install && npm run build"}
`,y=`"""Keyword rule engine for transaction categories.

A rule is an uppercase keyword that must appear at the start of a word in the description
("PHO" matches "PHO HOA", not "IPHONE"; "SUSHI" matches "SUSHIYA"). Your rules (source='user')
beat built-in ones; otherwise the longest matching keyword wins. Built-in keywords live in
rules_library.py and can be edited or disabled from the Rules page.
"""
import re
import sqlite3

from .rules_library import CATEGORIES, SEED_RULES

_PROVINCES = r"(ON|BC|AB|QC|MB|SK|NS|NB|NL|PE|YT|NT|NU|CA|CAN)"
# Bank wording in front of the actual payee ("Pre-authorized payment HYDRO ONE" -> "HYDRO ONE")
_PREFIXES = re.compile(
    r"^(?:(?:POS|OPOS|APOS|IDP|POINT OF SALE|CONTACTLESS|INTERAC|VISA DEBIT|DEBIT|RETAIL)\\s+)*"
    r"(?:PURCHASE\\s*-?\\s*|PRE-?AUTHORI[SZ]ED\\s+(?:PAYMENT|DEBIT|PMT)\\s*-?\\s*|PRE-AUTH\\s+|"
    r"ONLINE BANKING PAYMENT\\s*-?\\s*|BILL PAYMENT\\s*-?\\s*|MISC PAYMENT\\s*-?\\s*|PAYMENT\\s*-\\s*|"
    r"E-TRANSFER SENT\\s*|INTERAC E-TRANSFER SENT\\s*|SEND E-TFR\\s*\\S*\\s*)?"
)
_CITIES = {
    "TORONTO", "MONTREAL", "VANCOUVER", "OTTAWA", "CALGARY", "EDMONTON", "WINNIPEG", "MISSISSAUGA",
    "BRAMPTON", "HAMILTON", "QUEBEC", "SURREY", "LAVAL", "HALIFAX", "LONDON", "MARKHAM", "VAUGHAN",
    "GATINEAU", "SASKATOON", "REGINA", "BURNABY", "RICHMOND", "OAKVILLE", "BURLINGTON", "KITCHENER",
    "WATERLOO", "WINDSOR", "SCARBOROUGH", "ETOBICOKE", "NORTH YORK", "VICTORIA", "KINGSTON", "GUELPH",
}

Rule = tuple[str, str, "re.Pattern[str]", int]  # pattern, category, compiled regex, rule id


def normalize(description: str) -> str:
    """Uppercase and collapse whitespace; keep punctuation so patterns like 'A&W' still match."""
    return re.sub(r"\\s+", " ", description.upper()).strip()


def merchant_key(description: str) -> str:
    """A stable short merchant name: drop payment-processor prefixes, store numbers and location.

    Two words is the sweet spot: enough to tell "UBER EATS" from "UBER TRIP", short enough to
    drop the city that most statements append ("TIM HORTONS #123 TORONTO ON" -> "TIM HORTONS").
    """
    text = re.sub(r"\\(.*?\\)", " ", normalize(description)).strip()  # "(Payroll Deposit)"-style notes
    stripped = _PREFIXES.sub("", text)
    if re.search(r"[A-Z]{2,}", re.sub(r"\\S*\\d\\S*", " ", stripped)):
        text = stripped  # keep the bank wording when it's all there is ("E-TRANSFER SENT")
    text = re.sub(r"^(SQ|TST|SP|PAYPAL|PP|DD)\\s*\\*\\s*", "", text)
    text = re.sub(r"[#*]\\s*\\S*\\d\\S*", " ", text)          # store / reference numbers
    text = re.sub(r"\\S*\\d\\S*", " ", text)                 # any token containing digits
    text = re.sub(rf"\\s+{_PROVINCES}$", "", text.strip())  # trailing province code
    words = [w for w in text.split() if w not in {"-", "*", "#", "/"}]
    words = [w for i, w in enumerate(words) if w not in words[:i]]  # "AMAZON.CA AMAZON.CA" -> "AMAZON.CA"
    while len(words) > 1 and words[-1] in _CITIES:
        words.pop()
    if len(words) > 2 and words[1] in _CITIES:
        words = words[:1]
    return " ".join(words[:2]) if words else normalize(description)[:24]


def seed_categories(conn: sqlite3.Connection) -> None:
    """Add built-in categories and keywords that aren't in the database yet.

    Existing rows are never touched, so edits and disabled built-ins survive restarts.
    """
    for name, kind in CATEGORIES.items():
        conn.execute("INSERT OR IGNORE INTO categories(name, kind) VALUES (?, ?)", (name, kind))
    for category, patterns in SEED_RULES.items():
        for p in patterns:
            conn.execute(
                "INSERT OR IGNORE INTO category_rules(pattern, category, source, priority) VALUES (?, ?, 'seed', 0)",
                (p, category),
            )


def compile_pattern(pattern: str) -> "re.Pattern[str]":
    return re.compile(r"(?<![A-Z0-9])" + re.escape(pattern.upper()))


def load_rules(conn: sqlite3.Connection) -> list[Rule]:
    cur = conn.execute(
        "SELECT id, pattern, category FROM category_rules WHERE enabled = 1 "
        "ORDER BY (source = 'user') DESC, priority DESC, length(pattern) DESC"
    )
    return [(r["pattern"], r["category"], compile_pattern(r["pattern"]), r["id"]) for r in cur.fetchall()]


def match_rule(description: str, rules: list[Rule]) -> Rule | None:
    padded = f" {normalize(description)} "
    for rule in rules:
        if rule[2].search(padded):
            return rule
    return None


def categorize(description: str, rules: list[Rule]) -> str | None:
    rule = match_rule(description, rules)
    return rule[1] if rule else None


_PAYMENT_WORDS = re.compile(r"PAYMENT|PMT|PAIEMENT|PRINCIPAL|THANK YOU", re.I)


def default_category(amount: float, account_type: str = "chequing", description: str = "") -> str:
    """Category when no keyword matches.

    Money coming INTO a card or loan is a payment (or a refund), never income: calling it income is
    how a $16,000 line-of-credit balance once showed up as salary.
    """
    if amount < 0:
        return "Other"
    if account_type in ("credit", "loan"):
        return "Credit Card Payment" if _PAYMENT_WORDS.search(description) or account_type == "loan" else "Other"
    if account_type == "investment":
        return "Investment Contribution"
    return "Income"


def apply_rules(conn: sqlite3.Connection) -> int:
    """(Re)categorize every transaction the user hasn't set by hand."""
    rules = load_rules(conn)
    changed = 0
    for tx in conn.execute(
        "SELECT t.id, t.description, t.amount, a.type FROM transactions t JOIN accounts a ON a.id = t.account_id "
        "WHERE t.category_source != 'user'"
    ).fetchall():
        cat = categorize(tx["description"], rules) or default_category(tx["amount"], tx["type"], tx["description"])
        conn.execute(
            "UPDATE transactions SET category = ?, category_source = 'rule', merchant = ? WHERE id = ?",
            (cat, merchant_key(tx["description"]), tx["id"]),
        )
        changed += 1
    for tx in conn.execute("SELECT id, description, merchant FROM transactions WHERE category_source = 'user'").fetchall():
        key = merchant_key(tx["description"])  # merchant names improve over versions; keep them current
        if key != tx["merchant"]:
            conn.execute("UPDATE transactions SET merchant = ? WHERE id = ?", (key, tx["id"]))
    return changed


def save_user_rule(conn: sqlite3.Connection, pattern: str, category: str) -> str:
    pattern = re.sub(r"\\s+", " ", pattern.upper()).strip()
    conn.execute(
        "INSERT INTO category_rules(pattern, category, source, priority, enabled) VALUES (?, ?, 'user', 10, 1) "
        "ON CONFLICT(pattern) DO UPDATE SET category = excluded.category, source = 'user', priority = 10, "
        "enabled = 1",
        (pattern, category),
    )
    return pattern


def learn(conn: sqlite3.Connection, tx_id: int, category: str, apply_to_similar: bool = True) -> int:
    """Set a transaction's category and remember its merchant as a user rule. Returns rows changed."""
    tx = conn.execute("SELECT description FROM transactions WHERE id = ?", (tx_id,)).fetchone()
    if tx is None:
        raise KeyError(tx_id)
    conn.execute("UPDATE transactions SET category = ?, category_source = 'user' WHERE id = ?", (category, tx_id))
    if not apply_to_similar:
        return 1
    pattern = merchant_key(tx["description"])
    if len(pattern) < 3:
        return 1
    save_user_rule(conn, pattern, category)
    rx = compile_pattern(pattern)
    changed = 1
    for other in conn.execute(
        "SELECT id, description FROM transactions WHERE category_source != 'user' AND id != ?", (tx_id,)
    ).fetchall():
        if rx.search(f" {normalize(other['description'])} "):
            conn.execute("UPDATE transactions SET category = ?, category_source = 'rule' WHERE id = ?",
                         (category, other["id"]))
            changed += 1
    return changed
`,g=`"""Cross-page consistency checks: the same figure must be the same number everywhere it appears.

Each check recomputes a figure the way a page does and compares it with the other pages that show
it. Runs for whoever is being viewed (the scope). Used by /api/checks, the Overview banner and tests.
"""
import sqlite3
from datetime import date

from . import analytics as an
from . import family, insights, people, scope

TOL = 0.015


def _eq(a, b) -> bool:
    return abs((a or 0) - (b or 0)) < TOL


def run(conn: sqlite3.Connection) -> list[dict]:
    results: list[dict] = []

    def check(cid: str, title: str, ok: bool, detail: str = "", severity: str = "error") -> None:
        results.append({"id": cid, "title": title, "ok": bool(ok), "severity": "ok" if ok else severity,
                        "detail": "" if ok else detail})

    today = date.today().isoformat()
    ov = an.overview(conn)
    now = an.balances_at(conn, today)
    inv = an.investments(conn)

    # ---- accounts: every page lists the same accounts
    clause, args = scope.account_filter("a")
    acct_rows = conn.execute(f"SELECT a.id, a.name, a.type FROM accounts a WHERE a.archived = 0{clause}", args).fetchall()
    inv_page = {a["account_id"] for a in inv["accounts"]}
    inv_accounts = {a["id"] for a in acct_rows if a["type"] == "investment"}
    missing = [a["name"] for a in acct_rows if a["type"] == "investment" and a["id"] not in inv_page]
    check("accounts.investments", "Investments page lists every investment account on Accounts & assets",
          inv_page == inv_accounts, f"Missing on Investments: {', '.join(missing) or '-'}")

    # ---- net worth: overview, net worth page, assets - debts, allocation, debts page
    check("networth.pages", "Net worth is the same on Overview and Net worth",
          _eq(ov["net_worth"], now["net_worth"]), f"Overview {ov['net_worth']:,.2f} vs Net worth {now['net_worth']:,.2f}")
    check("networth.arithmetic", "Net worth = assets - debts",
          _eq(ov["net_worth"], ov["assets"] - ov["liabilities"]),
          f"{ov['assets']:,.2f} - {ov['liabilities']:,.2f} != {ov['net_worth']:,.2f}")
    alloc = sum(a["value"] for a in ov["allocation"])
    check("overview.allocation", "'Where your assets are' adds up to total assets",
          _eq(alloc, ov["assets"]), f"allocation {alloc:,.2f} vs assets {ov['assets']:,.2f}")
    debts = an.debts(conn)
    check("debts.total", "Debts page total = debts on Overview",
          _eq(debts["total"], ov["liabilities"]), f"Debts {debts['total']:,.2f} vs Overview {ov['liabilities']:,.2f}")

    # ---- investments: page total vs net worth's investment groups vs by-type breakdown
    inv_total = sum(a["balance"] or 0 for a in inv["accounts"])
    nw_inv = sum(i["balance"] for i in now["items"] if i["type"] == "investment")
    check("investments.networth", "Investments total = investments counted in net worth",
          _eq(inv_total, nw_inv), f"Investments {inv_total:,.2f} vs net worth {nw_inv:,.2f}")
    by_type = sum(r["market_value"] for r in inv["by_registration"])
    check("investments.by_type", "Investments 'by account type' adds up to the total",
          _eq(by_type, inv_total), f"by type {by_type:,.2f} vs total {inv_total:,.2f}")
    no_balance = [a["name"] for a in inv["accounts"] if a["balance"] is None]
    check("investments.balances", "Every investment account has a balance",
          not no_balance, f"No balance yet: {', '.join(no_balance)}. Upload a statement or use Update balance.",
          severity="warn")

    # ---- monthly figures: Monthly review vs Spending vs Overview cash flow
    months = an.data_months(conn)[-12:]
    spend = an.spending(conn, 12)
    spend_by_month = {m["month"]: m["expenses"] for m in spend["monthly"]}
    cash_by_month = {c["month"]: c for c in ov["cashflow"]}
    bad_spend, bad_cash, bad_cats = [], [], []
    for m in months:
        r = insights.review(conn, m, include_people=False)
        sc = r["scorecard"]
        if not _eq(sc["expenses"], spend_by_month.get(m, 0)):
            bad_spend.append(f"{m}: review {sc['expenses']:,.2f} vs spending {spend_by_month.get(m, 0):,.2f}")
        cf = cash_by_month.get(m)
        if cf and not (_eq(cf["income"], sc["income"]) and _eq(cf["expenses"], sc["expenses"])):
            bad_cash.append(f"{m}: overview {cf['income']:,.2f}/{cf['expenses']:,.2f} vs review "
                            f"{sc['income']:,.2f}/{sc['expenses']:,.2f}")
        cat_sum = sum(c["this"] for c in r["categories"] if c["kind"] in ("essential", "discretionary"))
        if not _eq(cat_sum, sc["expenses"]):
            bad_cats.append(f"{m}: categories {cat_sum:,.2f} vs total {sc['expenses']:,.2f}")
    check("monthly.spending", "Monthly review spending = Spending page, every month", not bad_spend, "; ".join(bad_spend))
    check("monthly.overview", "Overview income/spending = Monthly review, every month", not bad_cash, "; ".join(bad_cash))
    check("monthly.categories", "Spending by category adds up to total spending", not bad_cats, "; ".join(bad_cats))
    if months:
        default = insights.review(conn, None, include_people=False)["month"]
        check("monthly.default", "Overview and Monthly review open on the same month",
              default == ov["latest_month"], f"Overview {ov['latest_month']} vs Monthly review {default}")
    stale = [f"{a['name']} ({a['as_of']})" for a in ov["accounts"] if a.get("stale")]
    check("balances.fresh", f"Every balance is less than {an.STALE_DAYS} days old", not stale,
          f"Out of date: {', '.join(stale)}. Add the latest statement or use Update balance.", severity="warn")

    # ---- people & loans: page total = net worth items
    pl = people.list_contacts(conn)
    owed_item = sum(i["balance"] for i in now["items"] if i["type"] == "people" and i["side"] == "asset")
    owe_item = sum(i["balance"] for i in now["items"] if i["type"] == "people" and i["side"] == "liability")
    check("people.networth", "People & loans balances = what net worth counts",
          _eq(pl["owed_to_me"], owed_item) and _eq(pl["i_owe"], owe_item),
          f"page {pl['owed_to_me']:,.2f}/{pl['i_owe']:,.2f} vs net worth {owed_item:,.2f}/{owe_item:,.2f}")

    # ---- contribution room: detected contributions = what the room card shows
    year = date.today().year
    detected: dict[tuple, float] = {}
    for c in an.contributions(conn, year):
        key = (c["member_id"], c["registration"])
        detected[key] = detected.get(key, 0) + c["amount"]
    bad_room = [f"{r['member']} {r['registration']}: {r['contributed']:,.2f} vs {detected.get((r['member_id'], r['registration']), 0):,.2f}"
                for r in an.contribution_room(conn, year)
                if r["basis"] == "cra" and r["detected"]  # estimates use book value instead, by design
                and not _eq(r["contributed"], detected.get((r["member_id"], r["registration"]), 0))]
    check("room.contributions", "Contribution room uses the detected contributions", not bad_room, "; ".join(bad_room))

    # ---- family: people add up to the household
    fam_people = family._people(conn)
    if len(fam_people) > 1:
        f = family.compare(conn)
        if not f.get("empty"):
            inc = sum(p["income"] for p in f["people"])
            exp = sum(p["expenses"] for p in f["people"])
            check("family.household", "Family page: people add up to the household",
                  _eq(inc, f["household"]["income"]) and _eq(exp, f["household"]["expenses"]),
                  f"{f['month']}: people {inc:,.2f}/{exp:,.2f} vs household "
                  f"{f['household']['income']:,.2f}/{f['household']['expenses']:,.2f}")
            if scope.current() is None:
                parts = 0.0
                for p in fam_people:
                    with scope.use((p["id"],)):
                        parts += an.balances_at(conn, today)["net_worth"]
                check("family.networth", "Each person's net worth adds up to the family's",
                      _eq(parts, now["net_worth"]), f"people {parts:,.2f} vs family {now['net_worth']:,.2f}")

    # ---- statements that don't balance, leftover accounts
    unbalanced = []
    for s in conn.execute(
        "SELECT s.id, s.path, s.opening_balance o, s.closing_balance c, a.type, a.member_id, "
        "(SELECT coalesce(sum(t.amount), 0) FROM transactions t WHERE t.statement_id = s.id) total "
        f"FROM statements s JOIN accounts a ON a.id = s.account_id WHERE s.status = 'parsed'{clause} "
        "AND s.opening_balance IS NOT NULL AND s.closing_balance IS NOT NULL AND a.type != 'investment'", args
    ):
        expected = s["o"] - s["total"] if s["type"] in ("credit", "loan") else s["o"] + s["total"]
        if not _eq(expected, s["c"]):
            unbalanced.append(s["path"].split("/")[-1])
    check("statements.balance", "Imported statements add up to their closing balances",
          not unbalanced, f"Don't balance: {', '.join(unbalanced[:5])}{' …' if len(unbalanced) > 5 else ''}", severity="warn")
    empty = [r["name"] for r in conn.execute(
        "SELECT a.name FROM accounts a WHERE a.archived = 0 AND a.type != 'investment'"  # those: balances check
        f"{clause} AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.id) "
        "AND NOT EXISTS (SELECT 1 FROM balance_snapshots b WHERE b.account_id = a.id)", args)]
    no_balance = [r["name"] for r in conn.execute(
        "SELECT a.name FROM accounts a WHERE a.archived = 0 AND a.type != 'investment'"
        f"{clause} AND EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.id) "
        "AND NOT EXISTS (SELECT 1 FROM balance_snapshots b WHERE b.account_id = a.id)", args)]
    check("accounts.balances", "Every account with transactions has a balance", not no_balance,
          f"{', '.join(no_balance)}: the files have transactions but no balance (bank exports don't include one), "
          "so they aren't in your net worth. Enter the current balance once with Update balance on Accounts & "
          "assets; new transactions keep it up to date from then on.", severity="warn")
    check("accounts.empty", "No empty leftover accounts", not empty,
          f"No transactions and no balance: {', '.join(empty)}. Delete or merge them on Accounts & assets.",
          severity="warn")
    return results
`,A=`"""Filesystem locations. Everything lives inside the project folder.

Set FINANCE_HOME to point statements/, data/ and backups/ somewhere else (used by tests and the demo).
"""
import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
ROOT = Path(os.environ["FINANCE_HOME"]).resolve() if os.environ.get("FINANCE_HOME") else APP_DIR
STATEMENTS_DIR = ROOT / "statements"
DATA_DIR = ROOT / "data"
BACKUP_DIR = ROOT / "backups"
DB_PATH = DATA_DIR / "finance.db"
FRONTEND_DIST = APP_DIR / "frontend" / "dist"

HOST = "127.0.0.1"
PORT = 8765

STATEMENT_EXTENSIONS = {".pdf", ".csv", ".xlsx", ".xls"}


def code_version() -> float:
    """Newest modification time of the app's code (backend + built dashboard), to spot stale servers."""
    files = list((APP_DIR / "backend").rglob("*.py")) + list(FRONTEND_DIST.rglob("*"))
    return max((f.stat().st_mtime for f in files if f.is_file()), default=0.0)
`,R=`"""Which months are fully covered by statements, per account and overall.

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
    from .config import ROOT
    try:
        return date.fromtimestamp((ROOT / rel).stat().st_mtime)
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
`,S=`"""SQLite schema and connection helper."""
import sqlite3
from contextlib import contextmanager

from .config import DATA_DIR, DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    institution TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('chequing','savings','credit','investment','loan')),
    registration TEXT CHECK (registration IN ('TFSA','RRSP','FHSA','NONREG') OR registration IS NULL),
    last4 TEXT,
    credit_limit REAL,
    interest_rate REAL,          -- annual %, loans and cards
    payment REAL,                -- scheduled monthly payment, loans
    archived INTEGER NOT NULL DEFAULT 0,
    member_id INTEGER REFERENCES members(id),  -- whose account (from the statements\\<name>\\ folder)
    UNIQUE (institution, type, last4)
);

CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    folder TEXT UNIQUE,              -- statements\\<folder>\\ holds their files; NULL = the top level (you, before moving)
    color TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS member_groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    member_ids TEXT NOT NULL         -- JSON list of member ids
);

CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL,
    file_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS statements (
    id INTEGER PRIMARY KEY,
    file_hash TEXT NOT NULL,
    part TEXT NOT NULL DEFAULT '',   -- one file can hold several accounts (bank exports)
    path TEXT NOT NULL,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    institution TEXT,
    detected_type TEXT,
    period_start TEXT,
    period_end TEXT,
    opening_balance REAL,
    closing_balance REAL,
    market_value REAL,
    book_value REAL,
    credit_limit REAL,
    status TEXT NOT NULL CHECK (status IN ('parsed','needs_review','failed','locked','ignored')),
    message TEXT,
    parser TEXT,
    staged_json TEXT,            -- parsed result awaiting review (needs_review only)
    duplicates INTEGER NOT NULL DEFAULT 0,  -- rows skipped because another file already had them
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (file_hash, part)
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    statement_id INTEGER REFERENCES statements(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    merchant TEXT NOT NULL,
    amount REAL NOT NULL,        -- negative = money out (spend / charge), positive = money in
    category TEXT,
    category_source TEXT NOT NULL DEFAULT 'none',  -- none | rule | user
    is_transfer INTEGER NOT NULL DEFAULT 0,
    dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS ix_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS ix_tx_account ON transactions(account_id);

CREATE TABLE IF NOT EXISTS balance_snapshots (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    balance REAL NOT NULL,       -- assets: value held; credit/loan: amount owed (positive)
    book_value REAL,
    source TEXT NOT NULL DEFAULT 'statement',
    statement_id INTEGER REFERENCES statements(id) ON DELETE CASCADE,
    UNIQUE (account_id, date, source)
);

CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    statement_id INTEGER REFERENCES statements(id) ON DELETE CASCADE,
    as_of TEXT NOT NULL,
    symbol TEXT NOT NULL,
    units REAL,
    market_value REAL NOT NULL,
    book_value REAL
);

CREATE TABLE IF NOT EXISTS manual_items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('asset','liability')),
    value REAL NOT NULL,
    as_of TEXT NOT NULL,
    note TEXT,
    member_id INTEGER REFERENCES members(id) ON DELETE SET NULL  -- NULL = the primary member
);

CREATE TABLE IF NOT EXISTS categories (
    name TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('essential','discretionary','income','transfer','ignore')),
    budget REAL
);

CREATE TABLE IF NOT EXISTS category_rules (
    id INTEGER PRIMARY KEY,
    pattern TEXT NOT NULL UNIQUE,  -- uppercase substring matched against the normalized description
    category TEXT NOT NULL REFERENCES categories(name) ON UPDATE CASCADE,
    source TEXT NOT NULL DEFAULT 'seed',  -- seed | user
    priority INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1    -- built-ins are disabled rather than deleted, so they stay off
);

CREATE TABLE IF NOT EXISTS contribution_room (
    year INTEGER NOT NULL,
    registration TEXT NOT NULL CHECK (registration IN ('TFSA','RRSP','FHSA')),
    member_id INTEGER NOT NULL,  -- room is per person in Canada
    room REAL NOT NULL,          -- room available for the year (from CRA My Account)
    contributed REAL,            -- optional manual override; otherwise detected from statements
    basis TEXT NOT NULL DEFAULT 'cra',  -- cra: CRA's Jan-1 figure | estimate: limits since since_year - book value
    since_year INTEGER,          -- estimate: TFSA eligibility year / FHSA opening year
    PRIMARY KEY (year, registration, member_id)
);

-- Your answer to "is this bank transfer a TFSA/RRSP/FHSA contribution?". Keyed by what the
-- transaction looks like (not its id), so it survives statements being re-imported.
CREATE TABLE IF NOT EXISTS contribution_tags (
    account_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT NOT NULL,
    registration TEXT NOT NULL CHECK (registration IN ('TFSA','RRSP','FHSA','NONE')),
    PRIMARY KEY (account_id, date, amount, description)
);

CREATE TABLE IF NOT EXISTS member_budgets (
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    category TEXT NOT NULL REFERENCES categories(name) ON UPDATE CASCADE ON DELETE CASCADE,
    budget REAL NOT NULL,
    PRIMARY KEY (member_id, category)
);

CREATE TABLE IF NOT EXISTS insurance_policies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT,
    policy_type TEXT NOT NULL,       -- car, home, tenant, life, health, dental, disability, critical_illness,
                                     -- travel, pet, umbrella, bundle, other
    coverages_json TEXT NOT NULL DEFAULT '[]',  -- [{"type": "life", "amount": 500000, "detail": "..."}]
    premium REAL,                    -- per payment
    frequency TEXT NOT NULL DEFAULT 'monthly',  -- monthly | quarterly | semiannual | annual
    paid_via TEXT NOT NULL DEFAULT 'bank',      -- bank | payroll | other (payroll premiums never hit a statement)
    match_pattern TEXT,              -- keyword that links bank transactions to this policy, e.g. "INTACT"
    insured TEXT,
    reference TEXT,
    renewal_date TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    insured_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL  -- NULL = household / not set
);

CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    keywords TEXT,                   -- comma-separated text that identifies them in descriptions
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_entries (
    id INTEGER PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    transaction_id INTEGER UNIQUE REFERENCES transactions(id) ON DELETE SET NULL,
    account_id INTEGER,              -- set for bank transactions (NULL = cash / manual entry); used to
    description TEXT,                -- re-attach the link when a statement is re-imported
    date TEXT NOT NULL,
    amount REAL NOT NULL,            -- your side: negative = you gave/lent/repaid, positive = you received
    note TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    from .categorize import seed_categories

    with session() as conn:
        _migrate(conn)
        conn.executescript(SCHEMA)
        seed_categories(conn)
        _ensure_primary_member(conn)


def _ensure_primary_member(conn: sqlite3.Connection) -> None:
    """There is always one primary member ("Me" until renamed); unowned accounts belong to them."""
    row = conn.execute("SELECT id FROM members WHERE is_primary = 1").fetchone()
    if row is None:
        name = "Me"
        while conn.execute("SELECT 1 FROM members WHERE name = ?", (name,)).fetchone():
            name += " (me)"
        pid = conn.execute("INSERT INTO members(name, is_primary, color) VALUES (?, 1, '#4f7d3a')", (name,)).lastrowid
    else:
        pid = row["id"]
    conn.execute("UPDATE accounts SET member_id = ? WHERE member_id IS NULL", (pid,))
    # entries an earlier version dated tomorrow (browser used UTC): move them to today
    today = "date('now', 'localtime')"
    conn.execute(f"UPDATE OR REPLACE balance_snapshots SET date = {today} WHERE source = 'manual' AND date > {today}")
    conn.execute(f"UPDATE manual_items SET as_of = {today} WHERE as_of > {today}")
    conn.execute(f"UPDATE contact_entries SET date = {today} WHERE account_id IS NULL AND date > {today}")
    if conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'contribution_room_old'").fetchone():
        conn.execute("INSERT OR IGNORE INTO contribution_room(year, registration, member_id, room, contributed) "
                     "SELECT year, registration, ?, room, contributed FROM contribution_room_old", (pid,))  # basis: cra
        conn.execute("DROP TABLE contribution_room_old")


def _migrate(conn: sqlite3.Connection) -> None:
    """Upgrade databases created by earlier versions in place."""
    room_cols = {r["name"] for r in conn.execute("PRAGMA table_info(contribution_room)")}
    if room_cols and "member_id" not in room_cols:
        conn.execute("ALTER TABLE contribution_room RENAME TO contribution_room_old")  # copied after SCHEMA
    if room_cols and "member_id" in room_cols and "basis" not in room_cols:
        conn.execute("ALTER TABLE contribution_room ADD COLUMN basis TEXT NOT NULL DEFAULT 'cra'")
        conn.execute("ALTER TABLE contribution_room ADD COLUMN since_year INTEGER")
    ins_cols = {r["name"] for r in conn.execute("PRAGMA table_info(insurance_policies)")}
    if ins_cols and "insured_member_id" not in ins_cols:
        conn.execute("ALTER TABLE insurance_policies ADD COLUMN insured_member_id INTEGER REFERENCES members(id)")

    man_cols = {r["name"] for r in conn.execute("PRAGMA table_info(manual_items)")}
    if man_cols and "member_id" not in man_cols:
        conn.execute("ALTER TABLE manual_items ADD COLUMN member_id INTEGER REFERENCES members(id)")

    acct_cols = {r["name"] for r in conn.execute("PRAGMA table_info(accounts)")}
    if acct_cols and "member_id" not in acct_cols:
        conn.execute("ALTER TABLE accounts ADD COLUMN member_id INTEGER REFERENCES members(id)")

    rule_cols = {r["name"] for r in conn.execute("PRAGMA table_info(category_rules)")}
    if rule_cols and "enabled" not in rule_cols:
        conn.execute("ALTER TABLE category_rules ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1")

    cols = {r["name"] for r in conn.execute("PRAGMA table_info(statements)")}
    if cols and "part" not in cols:
        # SQLite can't change a UNIQUE constraint, so rebuild the table (ids are preserved)
        conn.commit()
        conn.execute("PRAGMA foreign_keys = OFF")
        new_sql = SCHEMA.split("CREATE TABLE IF NOT EXISTS statements", 1)[1].split(";", 1)[0]
        conn.execute("CREATE TABLE statements_new" + new_sql)
        shared = ", ".join(sorted(cols))
        conn.execute(f"INSERT INTO statements_new ({shared}) SELECT {shared} FROM statements")
        conn.execute("DROP TABLE statements")
        conn.execute("ALTER TABLE statements_new RENAME TO statements")
        conn.commit()
        conn.execute("PRAGMA foreign_keys = ON")


def rows(cur) -> list[dict]:
    return [dict(r) for r in cur.fetchall()]
`,O=`"""Family comparison: each person side by side, plus the household, for one month.

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
                    "note": f"{top['category']} up \${top['delta']:,.0f} vs usual" if top else None})
    return out
`,I="",w=`"""Generic CSV/Excel exports from online banking.

They rarely name the account, so they always go to review. (RBC's export does name it: see rbc_export.)
"""
import re
from datetime import date

from .generic import _resolve, find_dates
from .model import ParsedStatement, ParsedTx

DATE_COLS = ("date", "transaction date", "posted date", "posting date", "trans. date")
DESC_COLS = ("description", "description 1", "details", "payee", "merchant", "name", "transaction", "memo")
AMOUNT_COLS = ("amount", "cad$", "amount (cad)", "cad amount", "net amount")
DEBIT_COLS = ("debit", "withdrawal", "withdrawals", "money out", "debits")
CREDIT_COLS = ("credit", "deposit", "deposits", "money in", "credits")


def _num(v: str) -> float | None:
    v = (v or "").strip().replace("$", "").replace(",", "")
    if not v:
        return None
    neg = v.startswith("(") or v.startswith("-")
    try:
        n = float(v.strip("()-"))
    except ValueError:
        return None
    return -n if neg else n


def _pick(headers: list[str], names: tuple[str, ...]) -> int | None:
    low = [h.strip().lower() for h in headers]
    for n in names:
        if n in low:
            return low.index(n)
    return None


def parse_table(rows: list[list[str]]) -> ParsedStatement:
    st = ParsedStatement(parser="table")
    if not rows:
        return st
    header = rows[0]
    has_header = not find_dates(header[0])
    if has_header:
        di, si = _pick(header, DATE_COLS), _pick(header, DESC_COLS)
        ai, dbi, cri = _pick(header, AMOUNT_COLS), _pick(header, DEBIT_COLS), _pick(header, CREDIT_COLS)
        body = rows[1:]
    else:  # TD-style: date, description, debit, credit, balance
        di, si, ai, dbi, cri = 0, 1, None, 2, 3
        body = rows
    if di is None or si is None:
        st.warnings.append("Couldn't find date/description columns in this CSV.")
        return st
    for r in body:
        found = find_dates(r[di]) if di < len(r) else []
        if not found:
            continue
        d = _resolve(found[0][1], date.today())
        if d is None:
            continue
        if ai is not None and ai < len(r):
            amount = _num(r[ai])
        else:
            out = _num(r[dbi]) if dbi is not None and dbi < len(r) else None
            inn = _num(r[cri]) if cri is not None and cri < len(r) else None
            amount = (inn or 0) - abs(out or 0) if (out is not None or inn is not None) else None
        if amount is None:
            continue
        desc = re.sub(r"\\s+", " ", r[si]).strip()
        st.transactions.append(ParsedTx(d.isoformat(), desc, round(amount, 2)))
    if st.transactions:
        ds = sorted(t.date for t in st.transactions)
        st.period_start, st.period_end = ds[0], ds[-1]
    st.warnings.append("This export doesn't say which account it belongs to - pick one and check the signs.")
    return st
`,L=`"""Identify institution, account type and registration from statement text."""
import re

# Checked in order; the first institution with a matching pattern wins.
INSTITUTIONS: list[tuple[str, list[str]]] = [
    ("Wealthsimple", [r"WEALTHSIMPLE"]),
    ("Questrade", [r"QUESTRADE"]),
    ("KOHO", [r"\\bKOHO\\b"]),
    ("EQ Bank", [r"\\bEQ BANK\\b", r"EQUITABLE BANK"]),
    ("Tangerine", [r"TANGERINE"]),
    ("Simplii", [r"SIMPLII"]),
    ("RBC", [r"ROYAL BANK OF CANADA", r"\\bRBC\\b"]),
    ("TD", [r"TORONTO-DOMINION", r"TD CANADA TRUST", r"\\bTD BANK\\b", r"\\bTD\\b"]),
    ("Scotiabank", [r"SCOTIABANK", r"BANK OF NOVA SCOTIA", r"\\bSCOTIA\\b"]),
    ("BMO", [r"BANK OF MONTREAL", r"\\bBMO\\b"]),
    ("CIBC", [r"CANADIAN IMPERIAL BANK", r"\\bCIBC\\b"]),
    ("Amex", [r"AMERICAN EXPRESS"]),
]

REGISTRATIONS: list[tuple[str, list[str]]] = [
    ("FHSA", [r"\\bFHSA\\b", r"FIRST HOME SAVINGS", r"\\bCELIAPP\\b"]),
    ("TFSA", [r"\\bTFSA\\b", r"TAX[- ]FREE SAVINGS", r"\\bCELI\\b"]),
    ("RRSP", [r"\\bRRSP\\b", r"RETIREMENT SAVINGS PLAN", r"\\bREER\\b", r"\\bRRIF\\b"]),
]

CREDIT_SIGNALS = [r"CREDIT LIMIT", r"MINIMUM PAYMENT", r"AVAILABLE CREDIT", r"PAYMENT DUE DATE",
                  r"CREDIT AVAILABLE", r"LIMITE DE CR"]
INVESTMENT_SIGNALS = [r"MARKET VALUE", r"BOOK VALUE", r"BOOK COST", r"HOLDINGS", r"PORTFOLIO",
                      r"ASSET ALLOCATION", r"SELF[- ]DIRECTED", r"INVESTMENT ACCOUNT", r"SECURITIES"]
LOAN_SIGNALS = [r"MORTGAGE STATEMENT", r"PRINCIPAL BALANCE", r"AMORTIZATION", r"LOAN STATEMENT",
                r"LINE OF CREDIT STATEMENT", r"OUTSTANDING PRINCIPAL", r"LOAN BALANCE"]
LOC_SIGNAL = r"LINE OF CREDIT|CREDIT LINE|\\bHELOC\\b|HOME EQUITY|MARGE DE CR"
CARD_NETWORKS = r"\\bVISA\\b|MASTERCARD|MASTER CARD|AMERICAN EXPRESS|\\bAMEX\\b|CREDIT CARD|CARTE DE CR"
SAVINGS_SIGNALS = [r"SAVINGS ACCOUNT", r"HIGH INTEREST", r"\\bSAVINGS\\b", r"E-SAVINGS", r"SAVINGS PLUS"]


def _first_match(text: str, table: list[tuple[str, list[str]]]) -> str | None:
    for name, patterns in table:
        if any(re.search(p, text) for p in patterns):
            return name
    return None


def _count(text: str, patterns: list[str]) -> int:
    return sum(1 for p in patterns if re.search(p, text))


def detect_institution(text: str) -> str | None:
    return _first_match(text.upper(), INSTITUTIONS)


def detect_registration(text: str) -> str | None:
    return _first_match(text.upper(), REGISTRATIONS)


def detect_account_type(text: str) -> str:
    t = text.upper()
    if _count(t, INVESTMENT_SIGNALS) >= 2:
        return "investment"
    if re.search(LOC_SIGNAL, t) and not re.search(CARD_NETWORKS, t) and (
            _count(t, CREDIT_SIGNALS) >= 1 or "BALANCE OWING" in t):
        return "loan"  # lines of credit: a credit limit, but not a card
    if _count(t, CREDIT_SIGNALS) >= 2 or (re.search(CARD_NETWORKS, t) and _count(t, CREDIT_SIGNALS) >= 1):
        return "credit"  # a card network name plus one card-only phrase is enough
    if _count(t, LOAN_SIGNALS) >= 1:
        return "loan"
    if _count(t, SAVINGS_SIGNALS) >= 1 and "CHEQUING" not in t:
        return "savings"
    return "chequing"


_ACCT_NO = re.compile(
    r"(?:ACCOUNT|ACCT|CARD)\\s*(?:NUMBER|NO\\.?|#)?\\s*:?\\s*([0-9Xx*•\\- ]{4,30}\\d{3,4})\\b", re.IGNORECASE
)


_ACCT_ALNUM = re.compile(
    # the id must contain a digit, so plain words ("Account Account number: HQ8X12345") never match
    r"(?:ACCOUNT|ACCT)\\s*(?:NUMBER|NO\\.?|#|ID)?\\s*:?\\s*((?=[A-Z0-9-]*\\d)[A-Z0-9][A-Z0-9-]{4,19})\\b", re.IGNORECASE)


def detect_last4(text: str) -> str | None:
    """Last 4 characters of the account number (digits, or letters+digits like brokerage ids)."""
    for m in _ACCT_NO.finditer(text):  # keep looking: "Investment Account  Account number: ..."
        digits = re.sub(r"\\D", "", m.group(1))
        if len(digits) >= 4:
            return digits[-4:]
    for m in _ACCT_ALNUM.finditer(text):
        if re.search(r"\\d", m.group(1)):  # "HQ8X12345" -> "2345"; needs a digit so words don't match
            ident = re.sub(r"[^A-Z0-9]", "", m.group(1).upper())
            if len(ident) >= 5:
                return ident[-4:]
    # masked card numbers like "4520 **** **** 1234"
    m = re.search(r"(?:\\*{2,}|X{2,}|•{2,})\\s?(\\d{4})\\b", text)
    return m.group(1) if m else None
`,v=`"""Layout-independent statement parser.

Works line by line on extracted PDF text, so it copes with most Canadian bank layouts without a
per-bank template:

* a transaction line starts with a date (\`\`Sep 03\`\`, \`\`03 SEP\`\`, \`\`2026-09-03\`\`, \`\`09/03\`\`...),
  optionally followed by a posting date, then a description, then 1-3 amounts;
* lines with amounts but no date inherit the last date (RBC-style "date shown once per day");
* for bank accounts, the running-balance column fixes each amount's sign: between two balance
  checkpoints we pick the sign assignment that makes the arithmetic work, preferring the one that
  agrees most with keyword heuristics.

Anything that doesn't reconcile is sent to the review Inbox rather than guessed at.
"""
import itertools
import re
from datetime import date, timedelta

from . import detect
from .model import ParsedStatement, ParsedTx
from .pdftext import Line

# Bump when parsing changes so statements imported by an older version are re-read on startup.
PARSER_VERSION = "generic-4"

MONTHS = {
    "JAN": 1, "JANUARY": 1, "FEB": 2, "FEBRUARY": 2, "MAR": 3, "MARCH": 3, "APR": 4, "APRIL": 4,
    "MAY": 5, "JUN": 6, "JUNE": 6, "JUL": 7, "JULY": 7, "AUG": 8, "AUGUST": 8, "SEP": 9, "SEPT": 9,
    "SEPTEMBER": 9, "OCT": 10, "OCTOBER": 10, "NOV": 11, "NOVEMBER": 11, "DEC": 12, "DECEMBER": 12,
}
_MON = r"(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEPT?(?:EMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)(?![A-Z])"
_YEAR = r"((?:19|20)\\d{2})(?![\\d.,])"

# Each returns (year|None, month, day) via its own group order.
_DATE_FORMS = [
    ("ymd", re.compile(r"(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})\\b")),
    ("dmy_name", re.compile(rf"(\\d{{1,2}})[\\s\\-]?{_MON}\\.?(?:[\\s,\\-]+{_YEAR})?", re.I)),
    ("mdy_name", re.compile(rf"{_MON}\\.?\\s?(\\d{{1,2}})\\b(?:,?\\s+{_YEAR})?", re.I)),
    ("mdy_num", re.compile(r"(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b")),
]

_AMOUNT = re.compile(r"(\\(?\\s?-?\\s?\\$?\\s?(?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2}\\s?\\)?(?:\\s?(?:CR|DR|-))?)\\s*$", re.I)

SUMMARY_WORDS = re.compile(
    r"OPENING BALANCE|CLOSING BALANCE|BALANCE FORWARD|PREVIOUS (STATEMENT )?BALANCE|NEW BALANCE|"
    r"BEGINNING BALANCE|ENDING BALANCE|STARTING BALANCE|STATEMENT BALANCE|\\bTOTAL|SUBTOTAL|"
    r"MINIMUM PAYMENT|CREDIT LIMIT|AVAILABLE CREDIT|CREDIT AVAILABLE|PAYMENT DUE|INTEREST RATE|"
    r"ANNUAL INTEREST|CASH ADVANCE LIMIT|BALANCE AS OF|YOUR BALANCE|AMOUNT DUE|PAGE \\d",
    re.I,
)
INFLOW_WORDS = re.compile(
    r"DEPOSIT|PAYROLL|SALARY|\\bPAY\\b|RECEIVED|AUTODEPOSIT|AUTO-DEPOSIT|TRANSFER FROM|TFR-FR|FROM ACCT|"
    r"INTEREST (EARNED|PAID|CREDIT)|DEPOSIT INTEREST|REFUND|REVERSAL|REBATE|CASHBACK|CASH BACK|GST|"
    r"CANADA CHILD|\\bCCB\\b|FED\\b|PROV\\b|DIVIDEND|CONTRIBUTION|TRANSFER IN",
    re.I,
)
INVESTMENT_KEEP = re.compile(r"CONTRIBUTION|DEPOSIT|DIVIDEND|INTEREST|WITHDRAWAL|TRANSFER|FEE|DISTRIBUTION", re.I)
INVESTMENT_OUT = re.compile(r"WITHDRAWAL|TRANSFER OUT|FEE", re.I)

_ANY_AMOUNT = re.compile(
    r"(?<![\\w.,/])(\\(?-?\\s?\\$?\\s?(?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2}\\)?(?:\\s?(?:CR|DR)\\b)?)(?![\\w.,/%])", re.I)
_BAL_OPEN = re.compile(r"(OPENING|PREVIOUS|BEGINNING|STARTING)\\s+(STATEMENT\\s+|ACCOUNT\\s+)?BALANCE|BALANCE\\s+FORWARD", re.I)
_BAL_CLOSE = re.compile(r"(CLOSING|NEW|ENDING|TOTAL)\\s+(STATEMENT\\s+|ACCOUNT\\s+)?BALANCE|STATEMENT BALANCE|BALANCE AT END", re.I)
_PRINCIPAL_BAL = re.compile(r"PRINCIPAL BALANCE (?:ON|AS OF)\\b", re.I)
_BARE_LIMIT = re.compile(r"(?<!CASH )\\bLIMIT\\b(?=\\s*\\$)", re.I)  # "Limit $10,000.00" under a "Credit" heading
_CREDIT_LIMIT = re.compile(r"CREDIT LIMIT", re.I)
_MARKET_VALUE = re.compile(
    r"TOTAL\\s+(PORTFOLIO|MARKET|ACCOUNT|INVESTMENT)\\s+VALUE|TOTAL\\s+VALUE|ACCOUNT\\s+VALUE|"
    r"TOTAL\\s+MARKET\\s+VALUE|CLOSING\\s+(MARKET\\s+)?VALUE|ENDING\\s+VALUE|NET\\s+ASSETS",
    re.I,
)
_BOOK_VALUE = re.compile(r"TOTAL\\s+BOOK\\s+(VALUE|COST)|BOOK\\s+(VALUE|COST)\\s+TOTAL", re.I)


# ---------------------------------------------------------------- dates

def _mk(y: int | None, m: int, d: int) -> tuple[int | None, int, int] | None:
    if not (1 <= m <= 12 and 1 <= d <= 31):
        return None
    if y is not None and y < 100:
        y += 2000
    return (y, m, d)


def _date_from(kind: str, m: re.Match) -> tuple[int | None, int, int] | None:
    g = m.groups()
    if kind == "ymd":
        return _mk(int(g[0]), int(g[1]), int(g[2]))
    if kind == "dmy_name":
        return _mk(int(g[2]) if g[2] else None, MONTHS[g[1].upper()], int(g[0]))
    if kind == "mdy_name":
        return _mk(int(g[2]) if g[2] else None, MONTHS[g[0].upper()], int(g[1]))
    a, b = int(g[0]), int(g[1])
    month, day = (b, a) if a > 12 else (a, b)  # Canadian statements mostly MM/DD; DD/MM when unambiguous
    return _mk(int(g[2]) if g[2] else None, month, day)


def match_leading_date(line: str) -> tuple[tuple[int | None, int, int] | None, str]:
    """If the line starts with a date, return (date parts, rest of line)."""
    for kind, rx in _DATE_FORMS:
        m = rx.match(line)
        if m:
            parts = _date_from(kind, m)
            if parts:
                return parts, line[m.end():].strip()
    return None, line


def find_dates(text: str) -> list[tuple[int, tuple[int | None, int, int]]]:
    out = []
    for kind, rx in _DATE_FORMS:
        for m in rx.finditer(text):
            parts = _date_from(kind, m)
            if parts:
                out.append((m.start(), parts))
    return sorted(out)


def _resolve(parts: tuple[int | None, int, int], ref: date) -> date | None:
    y, m, d = parts
    try:
        if y is not None:
            return date(y, m, d)
        candidate = date(ref.year, m, d)
        if candidate > ref + timedelta(days=10):  # e.g. a Dec transaction on a Jan statement
            candidate = date(ref.year - 1, m, d)
        return candidate
    except ValueError:
        return None


_RANGE = re.compile(r"\\s*(?:TO|-|–|—|THROUGH|AU|UNTIL)\\s*", re.I)


def find_period(text: str) -> tuple[date | None, date | None]:
    """Find a 'date to date' statement period; the second date must carry a year."""
    flat = re.sub(r"\\s+", " ", text)
    dates = find_dates(flat)
    best = None
    for (p1, d1), (p2, d2) in zip(dates, dates[1:]):
        gap = flat[p1:p2]
        if d2[0] is None or p2 - p1 > 40 or not _RANGE.search(gap):
            continue
        end = _resolve(d2, date(d2[0], 12, 31))
        start = _resolve(d1, end) if end else None
        if start and end and timedelta(0) < end - start < timedelta(days=100):
            best = (start, end)
            break
    if best:
        return best
    m = re.search(r"STATEMENT DATE\\s*:?\\s*(.{6,25})", flat, re.I)
    if m:
        ds = find_dates(m.group(1))
        if ds and ds[0][1][0]:
            return None, _resolve(ds[0][1], date.today())
    return None, None


# ---------------------------------------------------------------- amounts

def parse_amount(token: str) -> float:
    t = token.strip().upper()
    negative = t.startswith("(") or t.startswith("-") or t.endswith("-") or t.endswith("CR") or "-" in t[:3]
    digits = re.sub(r"[^\\d.]", "", t.replace("CR", "").replace("DR", ""))
    value = float(digits)
    return -value if negative else value


def _peel_amounts(text: str, max_amounts: int = 3) -> list[tuple[float, int, int]]:
    """Trailing amounts as (value, start index, index of last digit), left to right."""
    found: list[tuple[float, int, int]] = []
    rest = text
    while len(found) < max_amounts:
        m = _AMOUNT.search(rest)
        if not m:
            break
        before = rest[: m.start()]
        # an amount must be separated from the description (so "ABC12.50" isn't read as an amount)
        if before and before[-1].isalnum() and not m.group(1)[:1].isspace():
            break
        token = m.group(1)
        last_digit = m.start(1) + max(i for i, ch in enumerate(token) if ch.isdigit())
        start = m.start(1) + (len(token) - len(token.lstrip()))
        found.insert(0, (parse_amount(token), start, last_digit))
        rest = before.rstrip()
    return found


def split_amounts(text: str, max_amounts: int = 3) -> tuple[list[float], str]:
    """Peel trailing amounts off a line. Returns (amounts left-to-right, remaining text)."""
    found = _peel_amounts(text, max_amounts)
    rest = text[: found[0][1]] if found else text
    return [v for v, _, _ in found], rest.strip(" -$")


def _amount_after(line: str, rx: re.Pattern) -> float | None:
    m = rx.search(line)
    if not m:
        return None
    amounts, _ = split_amounts(line[m.end():])
    return amounts[-1] if amounts else None


# ---------------------------------------------------------------- column layout

# Header words that name a money column, and what a number in that column means.
_COLUMN_ROLES = [
    ("fee", re.compile(r"^(INTEREST|FEES?|INSURANCE|CHARGES?)\\b")),
    ("out", re.compile(r"^(WITHDRAW|DEBITS?\\b|CHEQUES?\\b|PURCHASES|ADVANCES|MONEY OUT|FUNDS OUT|PAID OUT)")),
    ("in", re.compile(r"^(DEPOSITS?\\b|CREDITS?\\b|PAYMENTS?\\b|MONEY IN|FUNDS IN|PAID IN)")),
    ("balance", re.compile(r"^BALANCE")),
    ("amount", re.compile(r"^AMOUNT")),
]
_NEUTRAL_HEADER = re.compile(r"^(DATE|DESCRIPTION|TRANSACTION|DETAILS|POSTING|ACTIVITY|PARTICULARS|REFERENCE|CHEQUE ?#)")


def _column_header(line: "Line") -> list[tuple[str, float]] | None:
    """[(role, right edge)] if this line is a transaction-table header.

    A header is short and made almost entirely of column names ("Date Description Withdrawals ($)
    Deposits ($) Balance ($)"), which keeps prose such as "your new balance and minimum payment..."
    from being mistaken for one.
    """
    if not line.x1 or _ANY_AMOUNT.search(line.text) or match_leading_date(line.text)[0]:
        return None
    words = list(re.finditer(r"\\S+", line.text))
    if not 2 <= len(words) <= 16:
        return None
    columns: list[list] = []  # [role, right edge]
    header_like = 0
    for m in words:
        word = m.group(0).upper()
        role = next((r for r, rx in _COLUMN_ROLES if rx.match(word)), None)
        if role or _NEUTRAL_HEADER.match(word):
            columns.append([role, line.x1[m.end() - 1]])
            header_like += 1
        else:
            if re.fullmatch(r"[^\\w\\s]{1,4}|\\(\\$\\)|\\(%\\)|\\(CAD\\)|\\(\\$CAD\\)|OWING|AMT|CAD|\\$|SPEND|CATEGOR(Y|IES)"
                            r"|ANNUAL|RATE|TRANS\\.?|POST(ED)?", word):
                header_like += 1  # "($)", "&", "owing" -- but not reference numbers or ordinary words
            if columns:
                columns[-1][1] = line.x1[m.end() - 1]  # "Balance owing ($)" -> one column
    if header_like / len(words) < 0.75:
        return None
    money = [(r, x) for r, x in columns if r]
    roles = {r for r, _ in money}
    if (len(money) >= 2 and len(roles) >= 2) or roles == {"amount"}:
        return money
    return None


def _column_of(x: float, columns: list[tuple[str, float]]) -> str | None:
    xs = sorted(c for _, c in columns)
    gap = min((b - a for a, b in zip(xs, xs[1:])), default=80.0)
    tolerance = max(12.0, min(45.0, gap * 0.6))
    role, cx = min(columns, key=lambda c: abs(c[1] - x))
    return role if abs(cx - x) <= tolerance else None


# ---------------------------------------------------------------- sign solving

def _heuristic_positive(desc: str) -> bool:
    return bool(INFLOW_WORDS.search(desc)) and not re.search(r"INTEREST CHARGE|CREDIT CARD|FEE", desc, re.I)


def _search_signs(group: list[dict], delta: float) -> bool:
    """Flip as few guessed signs as possible so the group sums to delta."""
    values = [g["value"] for g in group]
    guesses = [g["guess"] for g in group]
    n = len(group)
    if not 0 < n <= 16:
        return False
    for flips in range(n + 1):
        for idx in itertools.combinations(range(n), flips):
            signs = list(guesses)
            for i in idx:
                signs[i] = -signs[i]
            if abs(sum(s * v for s, v in zip(signs, values)) - delta) < 0.005:
                for g, s in zip(group, signs):
                    g["sign"] = s
                return True
        if flips >= 4 and n > 12:  # keep the search bounded
            break
    return False


def _settle(group: list[dict], delta: float | None, synthetic: list[dict]) -> bool:
    """Fix the signs of a group of rows between two known balances. False if it had to guess."""
    for g in group:
        g["sign"] = g["guess"]
    if not group or delta is None:
        return not group or all(g["known"] for g in group)
    total = sum(g["sign"] * g["value"] for g in group)
    if abs(total - delta) < 0.005:
        return True
    fees = [g for g in group if g.get("fee")]
    if fees and all(g["known"] for g in group):
        fee_total = sum(g["value"] for g in fees)
        if abs(total + fee_total - delta) < 0.005:
            # interest/fees/insurance listed on the statement but paid from another account, so the
            # balance didn't move: keep them as costs and add the matching automatic payment
            synthetic.append({"after": fees[-1], "date": fees[-1]["date"], "value": round(fee_total, 2),
                              "desc": "Interest/fees/insurance paid automatically"})
            return True
    return _search_signs(group, delta)


# ---------------------------------------------------------------- main entry

def parse_lines(pages: list[list], institution: str | None = None) -> ParsedStatement:
    """Parse a statement from its text lines (plain strings, or Line objects that carry positions)."""
    line_pages = [[ln if isinstance(ln, Line) else Line(str(ln)) for ln in page] for page in pages]
    text_pages = [[ln.text for ln in page] for page in line_pages]
    all_text = [t for page in text_pages for t in page]
    text = "\\n".join(all_text)
    head = "\\n".join(t for page in text_pages[:2] for t in page)

    # institution and registration come from the letterhead: transaction descriptions on page 1
    # ("transfer to Wealthsimple TFSA") would otherwise be mistaken for the statement's own bank
    letterhead = "\\n".join(_letterhead(text_pages[0])) if text_pages else ""

    st = ParsedStatement(parser=PARSER_VERSION)
    st.institution = institution or detect.detect_institution(letterhead) or detect.detect_institution(head)
    st.account_type = detect.detect_account_type(head)
    st.registration = detect.detect_registration(letterhead)
    if st.account_type == "investment" and st.registration is None:
        st.registration = "NONREG"
    st.last4 = detect.detect_last4(head)

    start, end = find_period(head)
    st.period_start = start.isoformat() if start else None
    st.period_end = end.isoformat() if end else None

    for line in all_text:
        if st.opening_balance is None and _BAL_OPEN.search(line):
            st.opening_balance = _amount_after(line, _BAL_OPEN)
        if st.closing_balance is None and _BAL_CLOSE.search(line) and not _BAL_OPEN.search(line):
            st.closing_balance = _amount_after(line, _BAL_CLOSE)
        if st.credit_limit is None and _CREDIT_LIMIT.search(line):
            st.credit_limit = _amount_after(line, _CREDIT_LIMIT)
        if st.credit_limit is None and _BARE_LIMIT.search(line) and st.account_type in ("credit", "loan"):
            st.credit_limit = _amount_after(line, _BARE_LIMIT)
        if st.market_value is None and _MARKET_VALUE.search(line):
            st.market_value = _amount_after(line, _MARKET_VALUE)
        if st.book_value is None and _BOOK_VALUE.search(line):
            st.book_value = _amount_after(line, _BOOK_VALUE)

    principal = [_amount_after(ln, _PRINCIPAL_BAL) for ln in all_text if _PRINCIPAL_BAL.search(ln)]
    principal = [v for v in principal if v is not None]
    if len(principal) >= 2:
        st.opening_balance = principal[0] if st.opening_balance is None else st.opening_balance
        st.closing_balance = principal[-1] if st.closing_balance is None else st.closing_balance

    ref = end
    if ref is None:
        years = re.findall(r"\\b(20\\d{2})\\b", text)
        ref = date(int(max(set(years), key=years.count)), 12, 31) if years else date.today()

    entries = _collect_entries([ln for page in line_pages for ln in page], ref)
    if st.account_type == "investment":
        st.transactions = _investment_transactions(entries)
        if st.market_value is None and st.closing_balance is not None:
            st.market_value = st.closing_balance
        if st.market_value is not None:
            st.closing_balance = st.market_value
        st.warnings.append("Holdings aren't extracted by the generic parser; only the total value is recorded.")
    else:
        st.transactions = _signed_transactions(entries, st)
        if st.credit_limit is not None:
            st.credit_limit = abs(st.credit_limit)

    if st.transactions:
        dates = sorted(t.date for t in st.transactions)
        st.period_start = st.period_start or dates[0]
        st.period_end = st.period_end or dates[-1]
    return st


def _letterhead(lines: list[str]) -> list[str]:
    """Lines above the first transaction-looking row (at most 15)."""
    out = []
    for line in lines[:15]:
        parts, rest = match_leading_date(line)
        if parts and split_amounts(rest)[0]:
            break
        out.append(line)
    return out


def _collect_entries(lines: list[Line], ref: date) -> list[dict]:
    """Transaction rows: {date, desc, amounts: [values], roles: [column role or None] | None}."""
    entries: list[dict] = []
    cur_date: date | None = None
    pending: str | None = None
    columns: list[tuple[str, float]] | None = None
    # Undated lines with amounts are only rows when we're inside a transaction table, i.e. after a
    # real dated row (or a dated line whose amount is on the next line). Otherwise summary boxes ("Payments $3,300.00") and reports printed
    # after a date line ("August 24 to September 23") would be read as transactions.
    in_table = False
    section: str | None = None   # "in" inside a payments/credits section (amounts printed without "-")
    for ln in lines:
        line = ln.text
        header = _column_header(ln)
        if header:
            columns = header
            pending = None
            in_table = False  # a table only starts at its first dated row (report tables have none)
            continue
        heading = _section_of(line)
        if heading:
            section = heading if heading != "out" else None
            pending = None
            continue
        parts, rest = match_leading_date(line)
        if parts:
            # a second (posting) date directly after the first, as on credit card statements
            parts2, rest2 = match_leading_date(rest)
            if parts2:
                rest = rest2
            d = _resolve(parts, ref)
            if d is None:
                continue
            cur_date = d
        body = rest if parts else line
        offset = len(line) - len(body)
        roles: list[str | None] | None = None
        if columns and ln.x1:
            # position decides: keep numbers sitting under a money column, wherever they are in the
            # line; others are part of the description ("PMT (10,000.00)") or a side panel's text
            found, roles = [], []
            for m in _ANY_AMOUNT.finditer(body):
                token = m.group(1)
                last = m.start(1) + max(i for i, ch in enumerate(token) if ch.isdigit())
                role = _column_of(ln.x1[offset + last], columns)
                if role:
                    found.append((parse_amount(token), m.start(1), last))
                    roles.append(role)
        else:
            found = _peel_amounts(body)
        amounts = [v for v, _, _ in found]
        desc = (body[: found[0][1]] if found else body).strip(" -$")
        if not amounts:
            if parts and desc:
                pending = desc
            elif not parts and pending is not None and len(line) < 60 and not SUMMARY_WORDS.search(line):
                pending = f"{pending} {line}"
            else:
                pending = None
            continue
        if cur_date is None or not (parts or in_table or pending is not None):
            continue
        full = f"{pending} {desc}".strip() if pending else desc
        pending = None
        if not full or SUMMARY_WORDS.search(full) or not re.search(r"[A-Za-z]{2}", full):
            in_table = False  # "Total payments $3,300.00" ends a table
            continue
        if re.search(r"\\$\\s?\\d[\\d,]*\\.\\d{2}", full):
            continue  # a "$" figure inside the description: summary boxes / payment slips, not a purchase
        if roles is not None and all(r is None for r in roles):
            roles = None
        in_table = True
        entries.append({"date": cur_date.isoformat(), "desc": re.sub(r"\\s+", " ", full), "amounts": amounts,
                        "roles": roles, "section": section})
    return entries


_SECTION_IN = re.compile(r"^(YOUR\\s+)?(PAYMENTS?(\\s+(AND|&)\\s+(OTHER\\s+)?CREDITS)?|(OTHER\\s+)?CREDITS|PAYMENTS?\\s+RECEIVED)$", re.I)
_SECTION_OUT = re.compile(r"^(YOUR\\s+)?(NEW\\s+)?(CHARGES|PURCHASES|INTEREST|FEES|CASH ADVANCES|TRANSACTIONS)\\b", re.I)


def _section_of(line: str) -> str | None:
    """Section headings that change what an unsigned amount means on card statements."""
    text = line.strip()
    if len(text) > 50:
        return None
    if _SECTION_IN.match(text):
        return "in"
    if _SECTION_OUT.match(text) and not _ANY_AMOUNT.search(text):
        return "out"
    return None


def _signed_transactions(entries: list[dict], st: ParsedStatement) -> list[ParsedTx]:
    """Turn rows into signed transactions (negative = money out / charge), checked against balances.

    Column positions give each number's meaning when the PDF has them; the running balance column
    then confirms (or fixes) the signs. For credit cards and loans the statement may print what's
    owed as positive or negative; whichever it is, it's normalized to "amount owed" (positive).
    """
    liability = st.account_type in ("credit", "loan")
    items: list[dict] = []   # rows and balance checkpoints, in order
    for e in entries:
        roles = e["roles"]
        if roles:
            balance = next((v for v, r in zip(reversed(e["amounts"]), reversed(roles)) if r == "balance"), None)
            for v, r in zip(e["amounts"], roles):
                if r in (None, "balance"):
                    continue
                if r == "amount":
                    if liability and e.get("section") == "in":
                        guess = 1 if v > 0 else -1  # "Your payments 300.00": a payment, printed unsigned
                    else:
                        guess = (1 if v < 0 else -1) if liability else (1 if v > 0 else -1)
                else:
                    guess = 1 if r == "in" else -1
                items.append({"date": e["date"], "desc": e["desc"], "value": abs(v), "guess": guess,
                              "known": True, "fee": r == "fee"})
            if balance is not None:
                items.append({"checkpoint": balance})
            continue
        amounts = e["amounts"]
        value = amounts[-2] if len(amounts) >= 2 else amounts[-1]
        if liability:
            guess = 1 if (value < 0 or e.get("section") == "in" or re.search(
                r"PAYMENT|PMT|PAIEMENT|CREDIT|REFUND", e["desc"], re.I) and value <= 0) else -1
        else:
            guess = 1 if (value >= 0 and _heuristic_positive(e["desc"])) else -1
        items.append({"date": e["date"], "desc": e["desc"], "value": abs(value), "guess": guess, "known": False})
        if len(amounts) >= 2:
            items.append({"checkpoint": amounts[-1]})

    # Which way does this statement print balances? RBC credit lines print "Balance owing" as negative
    # in the table but "Principal balance" as positive in the summary, so judge each separately.
    summary = [b for b in (st.opening_balance, st.closing_balance) if b is not None]
    if liability and summary and all(b <= 0 for b in summary) and any(b < 0 for b in summary):
        st.opening_balance = -st.opening_balance if st.opening_balance is not None else None
        st.closing_balance = -st.closing_balance if st.closing_balance is not None else None
    printed = [i["checkpoint"] for i in items if "checkpoint" in i]
    owed_negative = liability and bool(printed) and sum(1 for b in printed if b < 0) > len(printed) / 2
    space = 1 if (not liability or owed_negative) else -1

    def to_column(v: float | None) -> float | None:  # summary figure -> the table's sign convention
        if v is None or not liability:
            return v
        return -v if owed_negative else v

    prev = to_column(st.opening_balance)
    group: list[dict] = []
    synthetic: list[dict] = []
    unsolved = 0
    rows: list[dict] = []
    for it in items:
        if "checkpoint" in it:
            delta = space * (it["checkpoint"] - prev) if prev is not None else None
            if not _settle(group, delta, synthetic):
                unsolved += 1
            prev = it["checkpoint"]
            group = []
        else:
            group.append(it)
            rows.append(it)
    closing_col = to_column(st.closing_balance)
    tail = space * (closing_col - prev) if prev is not None and closing_col is not None else None
    if not _settle(group, tail, synthetic):
        unsolved += 1
    if unsolved:
        st.warnings.append(f"{unsolved} group(s) of transactions had signs guessed from keywords.")

    out: list[ParsedTx] = []
    extra = {id(s["after"]): s for s in synthetic}
    for r in rows:
        out.append(ParsedTx(r["date"], r["desc"], round(r["sign"] * r["value"], 2)))
        if id(r) in extra:
            s = extra[id(r)]
            out.append(ParsedTx(s["date"], s["desc"], s["value"]))
    return out


def _investment_transactions(entries: list[dict]) -> list[ParsedTx]:
    out = []
    for e in entries:
        if not INVESTMENT_KEEP.search(e["desc"]) or re.search(r"\\bBUY\\b|\\bSELL\\b|BOUGHT|SOLD", e["desc"], re.I):
            continue
        value = abs(e["amounts"][0])
        out.append(ParsedTx(e["date"], e["desc"], -value if INVESTMENT_OUT.search(e["desc"]) else value))
    return out
`,C=`"""Deleting statements, and deleting or merging accounts.

Deleted statement files are moved to statements/_deleted/ (never erased), so a wrong click can be
undone by moving the file back and rescanning.
"""
import shutil
import sqlite3
from datetime import date, timedelta
from pathlib import Path

from ..config import ROOT, STATEMENTS_DIR
from .model import ParsedTx
from .scanner import DUPLICATE_WINDOW_DAYS, _take_duplicate

DELETED_DIR_NAME = "_deleted"


def deleted_dir() -> Path:
    return STATEMENTS_DIR / DELETED_DIR_NAME


def _move_to_deleted(rel_path: str) -> str | None:
    src = ROOT / rel_path
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
    return dest.relative_to(ROOT).as_posix()


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
`,x=`"""Parser output shared by every statement parser."""
from dataclasses import asdict, dataclass, field


@dataclass
class ParsedTx:
    date: str            # ISO yyyy-mm-dd
    description: str
    amount: float        # negative = money out of the account holder's pocket (spend / charge)


@dataclass
class ParsedHolding:
    symbol: str
    market_value: float
    units: float | None = None
    book_value: float | None = None


@dataclass
class ParsedStatement:
    institution: str | None = None
    account_type: str | None = None          # chequing | savings | credit | investment | loan
    registration: str | None = None          # TFSA | RRSP | FHSA | NONREG
    last4: str | None = None
    period_start: str | None = None
    period_end: str | None = None
    opening_balance: float | None = None     # credit/loan: amount owed
    closing_balance: float | None = None
    market_value: float | None = None        # investment accounts
    book_value: float | None = None
    credit_limit: float | None = None
    transactions: list[ParsedTx] = field(default_factory=list)
    holdings: list[ParsedHolding] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    parser: str = "generic"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "ParsedStatement":
        d = dict(d)
        d["transactions"] = [ParsedTx(**t) for t in d.get("transactions", [])]
        d["holdings"] = [ParsedHolding(**h) for h in d.get("holdings", [])]
        return cls(**d)

    @property
    def is_liability(self) -> bool:
        return self.account_type in ("credit", "loan")

    def reconciles(self) -> bool | None:
        """Does opening + transactions == closing? None when balances are unknown."""
        if self.opening_balance is None or self.closing_balance is None:
            return None
        total = sum(t.amount for t in self.transactions)
        # for liabilities a charge (negative amount) increases what is owed
        expected = self.opening_balance - total if self.is_liability else self.opening_balance + total
        return abs(expected - self.closing_balance) < 0.015
`,D=`"""Remembered PDF passwords, kept in Windows Credential Manager (never in the database).

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
`,M=`"""Read text lines out of a (possibly password-protected) PDF, keeping horizontal positions.

Positions let the parser tell which column a number sits in (Withdrawals vs Deposits vs Balance),
which plain text can't.
"""
import io
from dataclasses import dataclass
from pathlib import Path

import pdfplumber
import pikepdf


class PdfLocked(Exception):
    pass


@dataclass
class Line:
    text: str
    x1: list[float] | None = None  # right edge (points) of each character of \`text\`; None when unknown

    def __str__(self) -> str:
        return self.text


def _open_bytes(path: Path, password: str | None) -> bytes:
    try:
        with pikepdf.open(path, password=password or "") as pdf:
            if not pdf.is_encrypted:
                return path.read_bytes()
            buf = io.BytesIO()
            pdf.save(buf)  # saving drops the encryption; only ever held in memory
            return buf.getvalue()
    except pikepdf.PasswordError as e:
        raise PdfLocked(str(e)) from e


def is_locked(path: Path) -> bool:
    try:
        _open_bytes(path, None)
        return False
    except PdfLocked:
        return True


def _line_positions(text: str, chars: list[dict]) -> list[float] | None:
    """Right edge of every character in \`text\`; spaces take the position of the char before them."""
    out: list[float] = []
    j = 0
    last = chars[0]["x0"] if chars else 0.0
    for ch in text:
        if j < len(chars) and chars[j]["text"] == ch:
            last = chars[j]["x1"]
            j += 1
        elif ch.isspace():
            pass
        else:
            # skip chars pdfplumber dropped from the text (duplicates, whitespace glyphs)
            while j < len(chars) and chars[j]["text"] != ch:
                j += 1
            if j < len(chars):
                last = chars[j]["x1"]
                j += 1
        out.append(last)
    return out


def extract_layout(path: Path, password: str | None = None) -> list[list[Line]]:
    """Text lines per page, in reading order, with per-character right edges."""
    data = _open_bytes(path, password)
    pages: list[list[Line]] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            lines = []
            for ln in page.extract_text_lines(layout=False, strip=True, return_chars=True,
                                              x_tolerance=1.5, y_tolerance=3):
                text = ln["text"].strip()
                if text:
                    lines.append(Line(text, _line_positions(text, ln.get("chars") or [])))
            pages.append(lines)
    return pages


def extract_lines(path: Path, password: str | None = None) -> list[list[str]]:
    """Plain text lines per page."""
    return [[ln.text for ln in page] for page in extract_layout(path, password)]
`,P=`"""RBC Online Banking "Download transactions" export (CSV, or the same opened/saved in Excel).

    Account Type, Account Number, Transaction Date, Cheque Number, Description 1, Description 2, CAD$, USD$

One file can hold every account, and each row names its account, so it imports without review.
Signs already follow our convention (negative = money out / card purchase). There are no balances.
"""
import re
from collections import defaultdict
from datetime import date, datetime

from .model import ParsedStatement, ParsedTx

REQUIRED = {"account type", "account number", "transaction date", "description 1", "cad$"}

TYPE_MAP = [
    (r"VISA|MASTERCARD|MASTER CARD|CREDIT CARD|AMEX", "credit"),
    (r"LINE OF CREDIT|CREDIT LINE|\\bRCL\\b|LOAN|MORTGAGE|\\bLOC\\b|HELOC|HOMELINE", "loan"),
    (r"SAVINGS", "savings"),
    (r"TFSA|RRSP|FHSA|INVEST|GIC", "investment"),
    (r"CHEQUING|CHECKING|CURRENT|ACCOUNT", "chequing"),
]


def is_rbc_export(header: list[str]) -> bool:
    return REQUIRED <= {h.strip().lower() for h in header}


def _account_type(raw: str) -> str:
    up = raw.upper()
    for rx, t in TYPE_MAP:
        if re.search(rx, up):
            return t
    return "chequing"


def _registration(raw: str) -> str | None:
    up = raw.upper()
    for reg in ("TFSA", "RRSP", "FHSA"):
        if reg in up:
            return reg
    return None


def _date(v: str) -> date | None:
    v = v.strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y", "%Y/%m/%d"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    return None


def _amount(v: str) -> float | None:
    v = v.strip().replace("$", "").replace(",", "")
    if not v:
        return None
    neg = v.startswith("(") and v.endswith(")")
    try:
        n = float(v.strip("()"))
    except ValueError:
        return None
    return -n if neg else n


def parse_rows(rows: list[list[str]]) -> list[ParsedStatement]:
    header = [h.strip().lower() for h in rows[0]]
    col = {name: header.index(name) for name in header}

    def get(r: list[str], name: str) -> str:
        i = col.get(name)
        return r[i] if i is not None and i < len(r) else ""

    groups: dict[tuple[str, str], list[ParsedTx]] = defaultdict(list)
    skipped_usd: dict[tuple[str, str], int] = defaultdict(int)
    for r in rows[1:]:
        key = (get(r, "account type"), get(r, "account number"))
        d = _date(get(r, "transaction date"))
        if d is None:
            continue
        cad = _amount(get(r, "cad$"))
        if cad is None:
            if _amount(get(r, "usd$")) is not None:
                skipped_usd[key] += 1
            continue
        d1, d2 = get(r, "description 1").strip(), get(r, "description 2").strip()
        cheque = get(r, "cheque number").strip()
        if d1 and d2 and len(d1.split()) <= 3 and not re.search(r"\\d", d1):
            desc = f"{d2} ({d1})"  # d1 is RBC's transaction type ("Payroll Deposit"), d2 the payee
        else:
            desc = " ".join(x for x in (d1, d2) if x) or "(no description)"
        if cheque:
            desc += f" (cheque {cheque})"
        groups[key].append(ParsedTx(d.isoformat(), re.sub(r"\\s+", " ", desc), round(cad, 2)))

    out = []
    for (acct_type, acct_no), txs in groups.items():
        digits = re.sub(r"\\D", "", acct_no)
        dates = sorted(t.date for t in txs)
        st = ParsedStatement(
            institution="RBC", account_type=_account_type(acct_type), registration=_registration(acct_type),
            last4=digits[-4:] if len(digits) >= 4 else None,
            period_start=dates[0], period_end=dates[-1], transactions=txs, parser="rbc-export",
        )
        if st.account_type == "investment" and not st.registration:
            st.registration = "NONREG"
        if skipped_usd[(acct_type, acct_no)]:
            st.warnings.append(f"{skipped_usd[(acct_type, acct_no)]} USD-only rows skipped.")
        out.append(st)
    return out
`,k=`"""Walk the statements folder, parse anything new, and store the results."""
import hashlib
import json
import sqlite3
import traceback
from datetime import date, timedelta
from pathlib import Path

from .. import categorize, transfers
from ..config import ROOT, STATEMENT_EXTENSIONS, STATEMENTS_DIR
from . import passwords
from . import rbc_export
from .csvparse import parse_table
from .generic import parse_lines
from .model import ParsedStatement
from .pdftext import PdfLocked, extract_layout
from .tables import TABLE_EXTENSIONS, read_rows

# A transaction already imported from another file (same account, same amount, within this many
# days) is treated as the same transaction. PDFs, CSVs and Excel exports word descriptions
# differently and may use posting vs transaction dates, so descriptions can't be compared exactly.
DUPLICATE_WINDOW_DAYS = 3

TYPE_LABEL = {"chequing": "Chequing", "savings": "Savings", "credit": "Credit Card",
              "investment": "Investment", "loan": "Line of Credit / Loan"}


def _hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _file_hash(conn: sqlite3.Connection, path: Path, rel: str) -> str:
    stat = path.stat()
    row = conn.execute("SELECT size, mtime, file_hash FROM files WHERE path = ?", (rel,)).fetchone()
    if row and row["size"] == stat.st_size and abs(row["mtime"] - stat.st_mtime) < 1e-6:
        return row["file_hash"]
    digest = _hash(path)
    conn.execute(
        "INSERT INTO files(path, size, mtime, file_hash) VALUES (?,?,?,?) "
        "ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, file_hash=excluded.file_hash",
        (rel, stat.st_size, stat.st_mtime, digest),
    )
    return digest


def scan(conn: sqlite3.Connection) -> dict:
    """Import every statement file not seen before. Safe to call on every page load."""
    STATEMENTS_DIR.mkdir(parents=True, exist_ok=True)
    summary = {"new": 0, "parsed": 0, "needs_review": 0, "locked": 0, "failed": 0}
    for path in sorted(STATEMENTS_DIR.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in STATEMENT_EXTENSIONS or path.name.startswith("~$"):
            continue
        if "_deleted" in path.relative_to(STATEMENTS_DIR).parts:
            continue  # files removed from the dashboard
        rel = path.relative_to(ROOT).as_posix()
        digest = _file_hash(conn, path, rel)
        existing = conn.execute("SELECT id, path FROM statements WHERE file_hash = ?", (digest,)).fetchone()
        if existing:
            if existing["path"] != rel and not (ROOT / existing["path"]).exists():
                conn.execute("UPDATE statements SET path = ? WHERE id = ?", (rel, existing["id"]))  # file moved
            continue
        summary["new"] += 1
        status = process_new_file(conn, path, rel, digest)
        summary[status] += 1
    if summary["new"]:
        refresh_derived(conn)
    from .. import members
    members.organize_by_month(conn)  # file statements under the month they cover
    return summary


def _stored_reconciles(conn: sqlite3.Connection, st: sqlite3.Row) -> bool:
    if st["opening_balance"] is None or st["closing_balance"] is None or st["account_id"] is None:
        return False
    acct = conn.execute("SELECT type FROM accounts WHERE id = ?", (st["account_id"],)).fetchone()
    total = conn.execute("SELECT coalesce(sum(amount), 0) FROM transactions WHERE statement_id = ?",
                         (st["id"],)).fetchone()[0]
    if acct["type"] == "investment":
        return True
    liability = acct["type"] in ("credit", "loan")
    expected = st["opening_balance"] - total if liability else st["opening_balance"] + total
    return abs(expected - st["closing_balance"]) < 0.015


def upgrade_old_parses(conn: sqlite3.Connection) -> int:
    """Re-read PDFs imported by an older parser.

    * Automatic imports from an older generic parser are simply re-read.
    * Imports you confirmed on the review screen are only replaced when their stored rows don't add
      up to the statement's balances AND the current parser's reading does, to the cent. So a
      reviewed import that balances (your edits) is never touched.
    Also drops leftover records for files that were moved/removed and hold no transactions.
    """
    from .generic import PARSER_VERSION, parse_lines
    from .pdftext import extract_layout

    for s in conn.execute(
        "SELECT id, path FROM statements WHERE status = 'parsed' "
        "AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.statement_id = statements.id)"
    ).fetchall():
        if not (ROOT / s["path"]).exists():
            conn.execute("DELETE FROM balance_snapshots WHERE statement_id = ?", (s["id"],))
            conn.execute("DELETE FROM statements WHERE id = ?", (s["id"],))

    redone = 0
    for s in conn.execute(
        "SELECT * FROM statements WHERE status IN ('parsed', 'needs_review') AND path LIKE '%.pdf' "
        "AND (parser IN ('generic', 'generic-2', 'generic-3') OR parser LIKE 'generic%+reviewed')"
    ).fetchall():
        path = ROOT / s["path"]
        if not path.exists():
            continue
        stored_ok = _stored_reconciles(conn, s)
        if s["parser"].endswith("+reviewed") and stored_ok:
            continue  # your reviewed import balances: never touch it
        if s["parser"].endswith("+reviewed") or stored_ok:
            # only swap in the new reading if it balances too, so an upgrade can't make things worse
            try:
                fresh = parse_lines(extract_layout(path))
            except Exception:
                continue  # locked or unreadable: keep what we have
            if not fresh.reconciles():
                continue
        for table in ("transactions", "balance_snapshots", "holdings"):
            conn.execute(f"DELETE FROM {table} WHERE statement_id = ?", (s["id"],))
        parse_statement_file(conn, s["id"], path)
        redone += 1
    if redone:
        print(f"Re-read {redone} statement(s) with parser {PARSER_VERSION}")
    return redone


def refresh_derived(conn: sqlite3.Connection) -> None:
    from .. import people

    categorize.apply_rules(conn)
    people.relink(conn)  # keeps "Lent / Borrowed" links across re-imports
    transfers.detect(conn)


def process_new_file(conn: sqlite3.Connection, path: Path, rel: str, digest: str) -> str:
    if path.suffix.lower() in TABLE_EXTENSIONS:
        try:
            rows = read_rows(path)
        except Exception as e:
            rows = None
            error = f"{type(e).__name__}: {e}"
        if rows and rbc_export.is_rbc_export(rows[0]):
            return _import_multi_account(conn, rel, digest, rbc_export.parse_rows(rows))
        if rows is None:
            conn.execute("INSERT INTO statements(file_hash, path, status, message) VALUES (?, ?, 'failed', ?)",
                         (digest, rel, error))
            return "failed"
    cur = conn.execute(
        "INSERT INTO statements(file_hash, path, status) VALUES (?, ?, 'failed')", (digest, rel)
    )
    return parse_statement_file(conn, cur.lastrowid, path)


def _part_key(parsed: ParsedStatement) -> str:
    return f"{parsed.account_type}:{parsed.registration or ''}:{parsed.last4 or ''}"


def _import_multi_account(conn: sqlite3.Connection, rel: str, digest: str, parts: list[ParsedStatement]) -> str:
    """A bank export covering several accounts: one statements row per account."""
    if not parts:
        conn.execute("INSERT INTO statements(file_hash, path, status, message) VALUES (?, ?, 'failed', ?)",
                     (digest, rel, "No transactions found in this export."))
        return "failed"
    for parsed in parts:
        cur = conn.execute("INSERT INTO statements(file_hash, part, path, status) VALUES (?, ?, ?, 'failed')",
                           (digest, _part_key(parsed), rel))
        commit_statement(conn, cur.lastrowid, parsed)
    return "parsed"


def _candidates(conn: sqlite3.Connection, password: str | None):
    if password:
        yield password
        return
    yield None
    yield from passwords.remembered(conn)  # only touched when the file is actually locked


def parse_statement_file(conn: sqlite3.Connection, statement_id: int, path: Path,
                         password: str | None = None) -> str:
    """Parse one file into the given statement row. Returns the resulting status."""
    try:
        if path.suffix.lower() in TABLE_EXTENSIONS:
            rows = read_rows(path)
            if rows and rbc_export.is_rbc_export(rows[0]):
                part = conn.execute("SELECT part FROM statements WHERE id = ?", (statement_id,)).fetchone()["part"]
                match = [p for p in rbc_export.parse_rows(rows) if _part_key(p) == part]
                if not match:
                    _set_status(conn, statement_id, "failed", "That account is no longer in this file.")
                    return "failed"
                commit_statement(conn, statement_id, match[0])
                return "parsed"
            parsed = parse_table(rows)
            return _stage(conn, statement_id, parsed, "needs_review",
                          "Spreadsheet import: choose the account and confirm the rows.")
        pages = None
        for candidate in _candidates(conn, password):
            try:
                pages = extract_layout(path, candidate)
                break
            except PdfLocked:
                continue
        if pages is None:
            _set_status(conn, statement_id, "locked", "This PDF is password protected.")
            return "locked"
        parsed = parse_lines(pages)
    except Exception as e:  # a bad file must never break the scan
        _set_status(conn, statement_id, "failed", f"{type(e).__name__}: {e}")
        traceback.print_exc()
        return "failed"

    status, message = assess(parsed)
    if status == "parsed":
        try:
            commit_statement(conn, statement_id, parsed)
        except AmbiguousAccount as e:
            return _stage(conn, statement_id, parsed, "needs_review", str(e))
        return "parsed"
    return _stage(conn, statement_id, parsed, status, message)


def assess(parsed: ParsedStatement) -> tuple[str, str | None]:
    if parsed.account_type == "investment":
        if parsed.market_value is None:
            return "needs_review", "Couldn't find the account's total value."
        return "parsed", None
    if not parsed.transactions and parsed.closing_balance is None:
        return "failed", "No transactions or balances found. This layout may need a dedicated parser."
    ok = parsed.reconciles()
    if ok is None:
        return "needs_review", "Opening/closing balance not found, so the totals couldn't be verified."
    if not ok:
        return "needs_review", "Transactions don't add up to the closing balance. Please check the rows."
    return "parsed", None


def _set_status(conn, statement_id: int, status: str, message: str | None) -> None:
    conn.execute("UPDATE statements SET status = ?, message = ? WHERE id = ?", (status, message, statement_id))


def _stage(conn, statement_id: int, parsed: ParsedStatement, status: str, message: str | None) -> str:
    conn.execute(
        "UPDATE statements SET status = ?, message = ?, staged_json = ?, institution = ?, detected_type = ?, "
        "period_start = ?, period_end = ?, opening_balance = ?, closing_balance = ?, market_value = ?, "
        "book_value = ?, credit_limit = ?, parser = ? WHERE id = ?",
        (status, message, json.dumps(parsed.to_dict()), parsed.institution, parsed.account_type,
         parsed.period_start, parsed.period_end, parsed.opening_balance, parsed.closing_balance,
         parsed.market_value, parsed.book_value, parsed.credit_limit, parsed.parser, statement_id),
    )
    return status


class AmbiguousAccount(Exception):
    """More than one existing account could be this statement's; the user has to pick."""


def find_or_create_account(conn: sqlite3.Connection, parsed: ParsedStatement, member_id: int) -> int:
    """The member's matching account, or a new one for them.

    Match by account number first. A statement with a number can also be the first statement of an
    account you added by hand (no number yet), which then learns its number. When several accounts
    fit and nothing tells them apart, raise AmbiguousAccount rather than guess or duplicate.
    """
    inst = parsed.institution or "Unknown bank"
    atype = parsed.account_type or "chequing"
    same_kind = conn.execute(
        "SELECT id, last4 FROM accounts WHERE lower(institution) = lower(?) AND type = ? AND member_id = ? AND "
        "coalesce(registration,'') = coalesce(?, '') AND archived = 0",
        (inst, atype, member_id, parsed.registration)).fetchall()
    if parsed.last4:
        row = conn.execute(
            "SELECT id FROM accounts WHERE lower(institution) = lower(?) AND type = ? AND last4 = ? AND member_id = ?",
            (inst, atype, parsed.last4, member_id)).fetchone()
        if row is None:
            # same bank + same account digits is the same account, even if an older parser (or you)
            # filed it under a different type
            same = conn.execute("SELECT id FROM accounts WHERE lower(institution) = lower(?) AND last4 = ? AND member_id = ?",
                                (inst, parsed.last4, member_id)).fetchall()
            row = same[0] if len(same) == 1 else None
        if row is None:
            unnumbered = [a for a in same_kind if not a["last4"]]
            if len(unnumbered) == 1:
                conn.execute("UPDATE accounts SET last4 = ? WHERE id = ?", (parsed.last4, unnumbered[0]["id"]))
                return unnumbered[0]["id"]
            if len(unnumbered) > 1:
                raise AmbiguousAccount(f"More than one {inst} account could be this one; pick which.")
    else:
        if len(same_kind) > 1:
            raise AmbiguousAccount(f"More than one {inst} {parsed.registration or atype} account could be this "
                                   "one and the statement shows no account number; pick which.")
        row = same_kind[0] if same_kind else None
    if row:
        return row["id"]
    label = TYPE_LABEL[atype]
    if parsed.registration and parsed.registration != "NONREG":
        label = f"{parsed.registration} {label}"
    name = f"{inst} {label}" + (f" ••{parsed.last4}" if parsed.last4 else "")
    try:
        cur = conn.execute(
            "INSERT INTO accounts(institution, name, type, registration, last4, credit_limit, member_id) "
            "VALUES (?,?,?,?,?,?,?)",
            (inst, name, atype, parsed.registration, parsed.last4, parsed.credit_limit, member_id),
        )
    except sqlite3.IntegrityError:
        # the very same account already belongs to another family member (e.g. a card both of you
        # receive statements for): keep using that one rather than splitting its history
        return conn.execute("SELECT id FROM accounts WHERE institution = ? AND type = ? AND last4 = ?",
                            (inst, atype, parsed.last4)).fetchone()["id"]
    return cur.lastrowid


def statement_member(conn: sqlite3.Connection, statement_id: int) -> int:
    """Owner of a statement = the family member whose folder the file is in."""
    from .. import members

    row = conn.execute("SELECT path FROM statements WHERE id = ?", (statement_id,)).fetchone()
    return members.member_for_path(conn, ROOT / row["path"]) if row else members.primary_id(conn)


def commit_statement(conn: sqlite3.Connection, statement_id: int, parsed: ParsedStatement,
                     account_id: int | None = None) -> int:
    """Write a parsed statement's transactions and balances. Idempotent per statement."""
    if account_id is None:
        account_id = find_or_create_account(conn, parsed, statement_member(conn, statement_id))
    acct = conn.execute("SELECT type FROM accounts WHERE id = ?", (account_id,)).fetchone()
    if acct["type"] == "credit" and parsed.account_type == "loan":
        # earlier versions filed lines of credit as credit cards
        conn.execute("UPDATE accounts SET type = 'loan' WHERE id = ?", (account_id,))
        acct = {"type": "loan"}
    if parsed.credit_limit:
        conn.execute("UPDATE accounts SET credit_limit = ? WHERE id = ?", (parsed.credit_limit, account_id))
    if parsed.last4:  # an account picked on the review screen (or added by hand) learns its number
        conn.execute("UPDATE OR IGNORE accounts SET last4 = ? WHERE id = ? AND last4 IS NULL",
                     (parsed.last4, account_id))

    for table in ("transactions", "balance_snapshots", "holdings"):
        conn.execute(f"DELETE FROM {table} WHERE statement_id = ?", (statement_id,))

    pool = _other_files_transactions(conn, account_id, statement_id, parsed)
    duplicates = 0
    seen: dict[tuple, int] = {}
    for tx in parsed.transactions:
        if _take_duplicate(pool, tx):
            duplicates += 1
            continue
        base = (account_id, tx.date, round(tx.amount, 2), tx.description.upper())
        seen[base] = seen.get(base, 0) + 1
        key = hashlib.sha1(repr((*base, seen[base])).encode()).hexdigest()
        conn.execute(
            "INSERT OR IGNORE INTO transactions(account_id, statement_id, date, description, merchant, amount, "
            "dedupe_key) VALUES (?,?,?,?,?,?,?)",
            (account_id, statement_id, tx.date, tx.description, categorize.merchant_key(tx.description),
             round(tx.amount, 2), key),
        )

    closing = parsed.market_value if acct["type"] == "investment" else parsed.closing_balance
    if closing is not None and parsed.period_end:
        conn.execute(
            "INSERT INTO balance_snapshots(account_id, date, balance, book_value, source, statement_id) "
            "VALUES (?,?,?,?, 'statement', ?) ON CONFLICT(account_id, date, source) DO UPDATE SET "
            "balance = excluded.balance, book_value = excluded.book_value, statement_id = excluded.statement_id",
            (account_id, parsed.period_end, closing, parsed.book_value, statement_id),
        )
    if parsed.opening_balance is not None and parsed.period_start and acct["type"] != "investment":
        conn.execute(
            "INSERT OR IGNORE INTO balance_snapshots(account_id, date, balance, source, statement_id) "
            "VALUES (?,?,?, 'statement', ?)",
            (account_id, parsed.period_start, parsed.opening_balance, statement_id),
        )
    for h in parsed.holdings:
        conn.execute(
            "INSERT INTO holdings(account_id, statement_id, as_of, symbol, units, market_value, book_value) "
            "VALUES (?,?,?,?,?,?,?)",
            (account_id, statement_id, parsed.period_end, h.symbol, h.units, h.market_value, h.book_value),
        )
    conn.execute(
        "UPDATE statements SET account_id = ?, status = 'parsed', message = NULL, staged_json = NULL, "
        "institution = ?, detected_type = ?, period_start = ?, period_end = ?, opening_balance = ?, "
        "closing_balance = ?, market_value = ?, book_value = ?, credit_limit = ?, parser = ?, duplicates = ?, "
        "message = ? WHERE id = ?",
        (account_id, parsed.institution, parsed.account_type, parsed.period_start, parsed.period_end,
         parsed.opening_balance, parsed.closing_balance, parsed.market_value, parsed.book_value,
         parsed.credit_limit, parsed.parser, duplicates, _duplicate_message(duplicates, len(parsed.transactions)),
         statement_id),
    )
    return account_id


def _duplicate_message(duplicates: int, total: int) -> str | None:
    if not duplicates:
        return None
    if duplicates == total:
        return f"Duplicate: all {total} transactions were already imported from other files."
    return f"{duplicates} of {total} transactions were already imported from other files and were skipped."


def _other_files_transactions(conn: sqlite3.Connection, account_id: int, statement_id: int,
                              parsed: ParsedStatement) -> dict[float, list[dict]]:
    """This account's transactions from other files around this statement's dates, keyed by amount."""
    if not parsed.transactions:
        return {}
    dates = sorted(t.date for t in parsed.transactions)
    lo = (date.fromisoformat(dates[0]) - timedelta(days=DUPLICATE_WINDOW_DAYS)).isoformat()
    hi = (date.fromisoformat(dates[-1]) + timedelta(days=DUPLICATE_WINDOW_DAYS)).isoformat()
    pool: dict[float, list[dict]] = {}
    for r in conn.execute(
        "SELECT id, date, amount, upper(description) description FROM transactions "
        "WHERE account_id = ? AND coalesce(statement_id, -1) != ? AND date BETWEEN ? AND ?",
        (account_id, statement_id, lo, hi),
    ):
        pool.setdefault(round(r["amount"], 2), []).append(dict(r))
    return pool


def _take_duplicate(pool: dict[float, list[dict]], tx) -> bool:
    """Match tx one-to-one against an already-imported transaction; prefer same text, then nearest date."""
    candidates = pool.get(round(tx.amount, 2))
    if not candidates:
        return False
    d = date.fromisoformat(tx.date)
    desc = tx.description.upper()

    def score(c: dict) -> tuple[int, int]:
        gap = abs((date.fromisoformat(c["date"]) - d).days)
        return (0 if c["description"] == desc else 1, gap)

    best = min(candidates, key=score)
    if abs((date.fromisoformat(best["date"]) - d).days) > DUPLICATE_WINDOW_DAYS:
        return False
    candidates.remove(best)
    return True
`,F=`"""Read CSV / Excel exports into rows of strings (dates normalized to ISO)."""
import csv
import io
from datetime import date, datetime
from pathlib import Path

TABLE_EXTENSIONS = {".csv", ".xlsx", ".xls"}


def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer() and abs(v) >= 1e6:
        return str(int(v))  # long account numbers Excel turned into floats
    return str(v).strip()


def read_rows(path: Path) -> list[list[str]]:
    """All non-empty rows of the first sheet (or the CSV)."""
    suffix = path.suffix.lower()
    if suffix == ".csv":
        raw = path.read_bytes()
        for enc in ("utf-8-sig", "cp1252"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        sample = text[:4096]
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\\t")
        except csv.Error:
            dialect = csv.excel
        rows = [[c.strip() for c in r] for r in csv.reader(io.StringIO(text), dialect)]
    elif suffix == ".xlsx":
        import openpyxl

        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        try:
            rows = [[_cell(c) for c in r] for r in wb.worksheets[0].iter_rows(values_only=True)]
        finally:
            wb.close()
    elif suffix == ".xls":
        import xlrd

        book = xlrd.open_workbook(path)
        sheet = book.sheet_by_index(0)
        rows = []
        for i in range(sheet.nrows):
            row = []
            for cell in sheet.row(i):
                if cell.ctype == xlrd.XL_CELL_DATE:
                    row.append(xlrd.xldate_as_datetime(cell.value, book.datemode).date().isoformat())
                else:
                    row.append(_cell(cell.value))
            rows.append(row)
    else:
        raise ValueError(f"Not a table file: {path.name}")
    return [r for r in rows if any(c for c in r)]
`,U=`"""Monthly review: comparisons, watch list, wins, suggested cutdowns and alerts.

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
        return f"New this month: {best} (\${spent:,.0f} over {len(now[best])} purchase(s))."
    return f"{best}: {len(now[best])} purchases (\${spent:,.0f}) vs about {usual:.0f} usually."


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
        elif month in monthly and prev_month in monthly and monthly[month] > monthly[prev_month] * 1.03 \\
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
                title = f"New spending in {r['category']}: \${r['this']:,.0f}"
                detail = "Nothing in this category in the previous months. If it was a one-off, it won't repeat."
                one_off = True
            else:
                big = one_offs.get(r["category"], [])
                big_total = -sum(x["amount"] for x in big)
                habit = r["delta"] - big_total  # what's left above usual without the one-off purchases
                if big and habit < max(INCREASE_MIN_DOLLARS, INCREASE_MIN_PCT * r["avg3"]):
                    names = ", ".join(f"{x['merchant']} \${-x['amount']:,.0f}" for x in big)
                    title = f"{r['category']} was up because of a one-off: {names}"
                    detail = (f"Without it, {r['category']} was \${r['this'] - big_total:,.0f}, close to your usual "
                              f"\${r['avg3']:,.0f}. Nothing to cut every month.")
                    one_off = True
                else:
                    title = f"Bring {r['category']} back to your usual \${r['avg3']:,.0f}/mo"
                    detail = f"You spent \${r['this']:,.0f} this month, \${r['delta']:,.0f} above your 3-month average."
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
                "detail": f"\${r['this']:,.0f} spent against a \${budget:,.0f} budget.",
                "monthly_saving": r["this"] - budget,
            })

    disc_subs = [s for s in subs if s["kind"] == "discretionary"]
    for s in disc_subs:
        if s["status"] == "new":
            add(f"sub:{s['merchant']}", {
                "type": "subscription", "category": s["category"],
                "title": f"New recurring charge: {s['merchant']}",
                "detail": f"\${s['amount']:,.2f}/mo (\${s['annual']:,.0f}/yr). Keep it only if you'll use it.",
                "monthly_saving": s["amount"],
            })
        elif s["status"] == "price_up":
            add(f"sub:{s['merchant']}", {
                "type": "subscription", "category": s["category"],
                "title": f"{s['merchant']} went up in price",
                "detail": f"\${s['previous_amount']:,.2f} → \${s['amount']:,.2f}/mo. Check for a cheaper plan or cancel.",
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
            "title": f"{len(streaming)} video streaming services (\${total:,.0f}/mo)",
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
            "title": f"{label}: \${f['total']:,.2f} ({', '.join(sorted(f['accounts']))})",
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
                "title": f"{merchant}: {len(amounts)} purchases, \${total:,.0f}",
                "detail": f"About \${statistics.mean(amounts):,.2f} each time. Cutting visits in half saves the amount shown.",
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
              + "Income, savings rate and \\"lower than usual\\" checks are skipped until they're in.")

    unexplained = [r for r in month_rows if r["category"] in UNEXPLAINED and r["amount"] < 0]
    if unexplained:
        total = -sum(r["amount"] for r in unexplained)
        alert("info", f"{len(unexplained)} e-transfer/cash withdrawal(s) without a purpose (\${total:,.0f})",
              "Set what they were for on the Spending page (rent, family, a purchase), or record them on "
              "People & loans if it was a loan, so they land in the right place.")

    sr = cur.get("savings_rate")
    if partial:
        pass  # income and savings aren't meaningful until all of the month's statements are in
    elif cur["income"] > 0:
        if cur["expenses"] > cur["income"]:
            alert("bad", "Spent more than you earned",
                  f"Expenses \${cur['expenses']:,.0f} vs income \${cur['income']:,.0f} (shortfall \${cur['expenses'] - cur['income']:,.0f}).")
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
            alert("warn", f"Check this income: \${r['amount']:,.2f} on {r['date']}",
                  f"\\"{r['description']}\\" ({r['account']}). If it's money moved between your own accounts, "
                  "set its category to Transfer on the Spending page so it isn't counted as income.")

    base_income = [totals.get(m, {}).get("income", 0) for m in base_months]
    if not partial and base_income and statistics.mean(base_income) > 0 and cur["income"] < 0.85 * statistics.mean(base_income):
        alert("info", "Income lower than usual",
              f"\${cur['income']:,.0f} vs ~\${statistics.mean(base_income):,.0f} average. Could be pay timing.")

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
                  f"\${liquid:,.0f} in chequing/savings vs \${avg_spend:,.0f} average monthly spending. 3-6 months is the usual guideline.")
        elif months_cov >= 6:
            alert("good", f"Emergency fund covers {months_cov:.1f} months")

    for r in large_purchases(rows, month_rows, month):
        alert("info", f"Large purchase: \${-r['amount']:,.2f} at {r['merchant']}",
              f"{r['date']}, {r['category']}. That's over 3x your typical {r['category']} purchase.")


    year = int(month[:4])
    rooms = an.contribution_room(conn, year)
    several = len({r["member_id"] for r in rooms}) > 1
    for room in rooms:
        who = f"{room['member']}'s " if several else ""
        if room["remaining"] > 0:
            alert("info", f"{who}{room['registration']}: \${room['remaining']:,.0f} of {year} room unused",
                  "Based on the room you entered. Figures only; not advice on what to invest.")
        elif room["remaining"] < 0:
            alert("bad", f"{who}{room['registration']} over-contributed by \${-room['remaining']:,.0f}",
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
`,H=`"""Insurance: policies you enter (coverages, premiums, renewal) + what your statements show you paid."""
import json
import sqlite3
from collections import defaultdict
from datetime import date, timedelta

from . import analytics as an
from . import scope
from .categorize import compile_pattern, normalize

POLICY_TYPES = {
    "car": "Car", "home": "Home", "tenant": "Tenant", "life": "Life", "health": "Health", "dental": "Dental",
    "vision": "Vision", "disability": "Disability", "critical_illness": "Critical illness", "travel": "Travel",
    "pet": "Pet", "umbrella": "Umbrella / liability", "mortgage": "Mortgage insurance", "bundle": "Bundle",
    "other": "Other",
}
PER_YEAR = {"monthly": 12, "biweekly": 26, "quarterly": 4, "semiannual": 2, "annual": 1}
RENEWAL_ALERT_DAYS = 45


def _policy_rows(conn: sqlite3.Connection, include_inactive: bool = True) -> list[dict]:
    """Policies for the people being viewed (a policy with no insured person counts as the primary member's)."""
    sql = ("SELECT p.*, m.name insured_member FROM insurance_policies p "
           "LEFT JOIN members m ON m.id = p.insured_member_id") + ("" if include_inactive else " WHERE p.active = 1")
    out = []
    for r in conn.execute(sql + " ORDER BY p.active DESC, p.policy_type, p.name"):
        if not scope.owner_visible(conn, r["insured_member_id"]):  # no insured person = primary member's
            continue
        p = dict(r)
        p["coverages"] = json.loads(p.pop("coverages_json") or "[]")
        p["annual_premium"] = round((p["premium"] or 0) * PER_YEAR.get(p["frequency"], 12), 2)
        pattern = (p["match_pattern"] or p["provider"] or "").strip()
        p["effective_pattern"] = pattern.upper() or None
        out.append(p)
    return out


def next_renewal(renewal: str | None, today: date) -> date | None:
    """Renewal dates repeat yearly; roll a past date forward to its next anniversary."""
    if not renewal:
        return None
    try:
        d = date.fromisoformat(renewal)
    except ValueError:
        return None
    while d < today:
        try:
            d = d.replace(year=d.year + 1)
        except ValueError:  # Feb 29
            d = d.replace(year=d.year + 1, day=28)
    return d


def summary(conn: sqlite3.Connection) -> dict:
    today = date.today()
    since = (today.replace(day=1) - timedelta(days=365)).replace(day=1)
    policies = _policy_rows(conn)
    active = [p for p in policies if p["active"]]

    # Insurance-looking spending: the Insurance category plus anything a policy keyword matches
    clause, args = scope.account_filter()
    txs = [dict(r) for r in conn.execute(
        "SELECT t.id, t.date, substr(t.date,1,7) month, t.description, t.merchant, t.amount, t.category, "
        "a.name account FROM transactions t JOIN accounts a ON a.id = t.account_id "
        f"WHERE t.is_transfer = 0 AND t.date >= ?{clause} ORDER BY t.date", [since.isoformat(), *args])]
    matchers = [(p, compile_pattern(p["effective_pattern"])) for p in policies if p["effective_pattern"]]
    by_policy: dict[int, list[dict]] = defaultdict(list)
    unassigned: list[dict] = []
    for t in txs:
        padded = f" {normalize(t['description'])} "
        owner = next((p for p, rx in matchers if rx.search(padded)), None)
        if owner:
            by_policy[owner["id"]].append(t)
        elif t["category"] == "Insurance":
            unassigned.append(t)

    months = an.month_range(since.strftime("%Y-%m"), today.strftime("%Y-%m"))
    monthly = {m: {"month": m} for m in months}
    for p in policies:
        for t in by_policy.get(p["id"], []):
            row = monthly.get(t["month"])
            if row is not None:
                row[p["name"]] = round(row.get(p["name"], 0) - t["amount"], 2)
        paid = by_policy.get(p["id"], [])
        p["paid_12m"] = round(-sum(t["amount"] for t in paid), 2)
        p["payments_12m"] = len(paid)
        p["last_payment"] = {"date": paid[-1]["date"], "amount": -paid[-1]["amount"]} if paid else None
        nr = next_renewal(p["renewal_date"], today)
        p["next_renewal"] = nr.isoformat() if nr else None
        p["renews_in_days"] = (nr - today).days if nr else None
    for t in unassigned:
        row = monthly.get(t["month"])
        if row is not None:
            row["Not linked to a policy"] = round(row.get("Not linked to a policy", 0) - t["amount"], 2)

    unassigned_by_merchant: dict[str, dict] = {}
    for t in unassigned:
        u = unassigned_by_merchant.setdefault(t["merchant"], {"merchant": t["merchant"], "total": 0.0, "count": 0,
                                                              "example": t["description"], "last_date": t["date"]})
        u["total"] = round(u["total"] - t["amount"], 2)
        u["count"] += 1
        u["last_date"] = t["date"]

    coverage: dict[str, dict] = {}
    for p in active:
        for c in p["coverages"] or [{"type": p["policy_type"], "amount": None}]:
            ctype = c.get("type") or p["policy_type"]
            g = coverage.setdefault(ctype, {"type": ctype, "label": POLICY_TYPES.get(ctype, ctype.title()),
                                            "amount": 0.0, "policies": []})
            if c.get("amount"):
                g["amount"] += float(c["amount"])
            if p["name"] not in g["policies"]:
                g["policies"].append(p["name"])

    premium_by_type: dict[str, float] = defaultdict(float)
    for p in active:
        premium_by_type[POLICY_TYPES.get(p["policy_type"], p["policy_type"])] += p["annual_premium"]

    return {
        "policies": policies,
        "types": POLICY_TYPES,
        "frequencies": list(PER_YEAR),
        "totals": {
            "annual_premiums": round(sum(p["annual_premium"] for p in active), 2),
            "payroll_annual": round(sum(p["annual_premium"] for p in active if p["paid_via"] == "payroll"), 2),
            "paid_12m": round(sum(p["paid_12m"] for p in policies) + sum(u["total"] for u in unassigned_by_merchant.values()), 2),
            "unassigned_12m": round(sum(u["total"] for u in unassigned_by_merchant.values()), 2),
            "life_coverage": round(coverage.get("life", {}).get("amount", 0.0), 2),
            "policies": len(active),
        },
        "coverage": sorted(coverage.values(), key=lambda g: g["label"]),
        "premium_by_type": [{"name": k, "value": round(v, 2)} for k, v in sorted(premium_by_type.items(), key=lambda x: -x[1])],
        "monthly": list(monthly.values()),
        "series": [p["name"] for p in policies if p["paid_12m"]] + (["Not linked to a policy"] if unassigned else []),
        "unassigned": sorted(unassigned_by_merchant.values(), key=lambda u: -u["total"]),
        "renewals": sorted(
            [{"name": p["name"], "provider": p["provider"], "date": p["next_renewal"], "days": p["renews_in_days"]}
             for p in active if p["renews_in_days"] is not None and p["renews_in_days"] <= RENEWAL_ALERT_DAYS],
            key=lambda r: r["days"]),
    }
`,B=`"""Family members and groups.

A member is a top-level folder under statements\\\\ (statements\\\\Sam\\\\2026-09\\\\...). Files directly in
statements\\\\ or in a statements\\\\YYYY-MM\\\\ folder belong to the primary member until they choose a
folder name for themselves (move_primary_files).
"""
import json
import re
import shutil
import sqlite3
from pathlib import Path

from .config import ROOT, STATEMENTS_DIR

_MONTH_FOLDER = re.compile(r"^\\d{4}-\\d{2}$")
RESERVED = {"_deleted"}
PALETTE = ["#4f7d3a", "#2a78d6", "#b0703a", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7", "#e34948"]


def primary_id(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT id FROM members WHERE is_primary = 1").fetchone()["id"]


def folder_of(path: Path) -> str | None:
    """The member folder a statement file sits in, or None for the top level."""
    try:
        parts = path.resolve().relative_to(STATEMENTS_DIR.resolve()).parts
    except ValueError:
        return None
    if len(parts) < 2 or parts[0] in RESERVED or _MONTH_FOLDER.match(parts[0]):
        return None
    return parts[0]


def member_for_path(conn: sqlite3.Connection, path: Path) -> int:
    """Member owning a statement file; a new folder name creates a new member."""
    folder = folder_of(path)
    if folder is None:
        return primary_id(conn)
    row = conn.execute("SELECT id FROM members WHERE lower(folder) = lower(?)", (folder,)).fetchone()
    if row:
        return row["id"]
    row = conn.execute("SELECT id FROM members WHERE lower(name) = lower(?) AND folder IS NULL", (folder,)).fetchone()
    if row:  # a member created by hand before their folder existed
        conn.execute("UPDATE members SET folder = ? WHERE id = ?", (folder, row["id"]))
        return row["id"]
    name = folder
    while conn.execute("SELECT 1 FROM members WHERE name = ?", (name,)).fetchone():
        name += " (2)"
    n = conn.execute("SELECT count(*) FROM members").fetchone()[0]
    return conn.execute("INSERT INTO members(name, folder, color) VALUES (?, ?, ?)",
                        (name, folder, PALETTE[n % len(PALETTE)])).lastrowid


def list_members(conn: sqlite3.Connection) -> list[dict]:
    out = []
    for m in conn.execute("SELECT * FROM members ORDER BY is_primary DESC, name COLLATE NOCASE"):
        stats = conn.execute(
            "SELECT count(DISTINCT a.id) accounts, count(t.id) transactions FROM accounts a "
            "LEFT JOIN transactions t ON t.account_id = a.id WHERE a.member_id = ?", (m["id"],)).fetchone()
        folder = f"statements\\\\{m['folder']}" if m["folder"] else "statements (top level)"
        out.append({**dict(m), "accounts": stats["accounts"], "transactions": stats["transactions"],
                    "folder_path": folder})
    return out


def create_member(conn: sqlite3.Connection, name: str, folder: str | None) -> int:
    name = name.strip()
    folder = _clean_folder(folder or name)
    n = conn.execute("SELECT count(*) FROM members").fetchone()[0]
    mid = conn.execute("INSERT INTO members(name, folder, color) VALUES (?, ?, ?)",
                       (name, folder, PALETTE[n % len(PALETTE)])).lastrowid
    (STATEMENTS_DIR / folder).mkdir(parents=True, exist_ok=True)
    return mid


def update_member(conn: sqlite3.Connection, member_id: int, name: str | None, color: str | None) -> None:
    if name is not None:
        conn.execute("UPDATE members SET name = ? WHERE id = ?", (name.strip(), member_id))
    if color is not None:
        conn.execute("UPDATE members SET color = ? WHERE id = ?", (color, member_id))


def delete_member(conn: sqlite3.Connection, member_id: int) -> None:
    """Only for members with no accounts (e.g. a folder created by mistake)."""
    m = conn.execute("SELECT is_primary FROM members WHERE id = ?", (member_id,)).fetchone()
    if m is None:
        raise KeyError(member_id)
    if m["is_primary"]:
        raise ValueError("The primary member can't be removed.")
    if conn.execute("SELECT 1 FROM accounts WHERE member_id = ?", (member_id,)).fetchone():
        raise ValueError("Move or delete this person's accounts first.")
    conn.execute("DELETE FROM members WHERE id = ?", (member_id,))
    for g in conn.execute("SELECT id, member_ids FROM member_groups").fetchall():
        ids = [i for i in json.loads(g["member_ids"]) if i != member_id]
        conn.execute("UPDATE member_groups SET member_ids = ? WHERE id = ?", (json.dumps(ids), g["id"]))


def _clean_folder(folder: str) -> str:
    folder = re.sub(r'[<>:"/\\\\|?*]', "", folder).strip().strip(".")
    if not folder or folder.lower() in RESERVED or _MONTH_FOLDER.match(folder):
        raise ValueError("Pick a different folder name.")
    return folder


def move_primary_files(conn: sqlite3.Connection, name: str) -> dict:
    """Give the primary member a name + folder and move their top-level files into it."""
    pid = primary_id(conn)
    folder = _clean_folder(name)
    other = conn.execute("SELECT id FROM members WHERE lower(folder) = lower(?) AND id != ?", (folder, pid)).fetchone()
    if other:
        raise ValueError(f"statements\\\\{folder} already belongs to someone else.")
    conn.execute("UPDATE members SET name = ?, folder = ? WHERE id = ?", (name.strip(), folder, pid))
    target = STATEMENTS_DIR / folder
    target.mkdir(parents=True, exist_ok=True)
    moved = 0
    for path in sorted(STATEMENTS_DIR.iterdir()):
        if path == target or path.name in RESERVED:
            continue
        if path.is_dir() and not _MONTH_FOLDER.match(path.name):
            continue  # another member's folder
        if path.is_dir():  # a month folder: move its files, merging into any existing one
            for f in path.rglob("*"):
                if f.is_file():
                    moved += _move_file(conn, f, target / f.relative_to(STATEMENTS_DIR))
            shutil.rmtree(path, ignore_errors=True)
        else:
            moved += _move_file(conn, path, target / path.name)
    return {"folder": f"statements\\\\{folder}", "files_moved": moved}


def _move_file(conn: sqlite3.Connection, src: Path, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest = dest.with_name(f"{dest.stem} (moved){dest.suffix}")
    old = src.relative_to(ROOT).as_posix()
    shutil.move(str(src), str(dest))
    new = dest.relative_to(ROOT).as_posix()
    conn.execute("UPDATE statements SET path = ? WHERE path = ?", (new, old))
    conn.execute("UPDATE files SET path = ? WHERE path = ?", (new, old))
    return 1


# ---------------------------------------------------------------- groups

def list_groups(conn: sqlite3.Connection) -> list[dict]:
    return [{"id": g["id"], "name": g["name"], "member_ids": json.loads(g["member_ids"])}
            for g in conn.execute("SELECT * FROM member_groups ORDER BY name COLLATE NOCASE")]


def save_group(conn: sqlite3.Connection, name: str, member_ids: list[int], group_id: int | None = None) -> int:
    ids = sorted(set(member_ids))
    if len(ids) < 2:
        raise ValueError("A group needs at least two people.")
    if group_id:
        conn.execute("UPDATE member_groups SET name = ?, member_ids = ? WHERE id = ?",
                     (name.strip(), json.dumps(ids), group_id))
        return group_id
    return conn.execute("INSERT INTO member_groups(name, member_ids) VALUES (?, ?)",
                        (name.strip(), json.dumps(ids))).lastrowid


def organize_by_month(conn: sqlite3.Connection) -> int:
    """Move each statement into the month folder it belongs to (the month its period ends in).

    Only files already sitting in a month folder (statements\\[person\\]YYYY-MM\\) are moved, so a
    layout you arranged yourself is left alone. Uploads land in the current month first; this puts
    an August statement uploaded in September into ...\\2026-08\\.
    """
    moved = 0
    rows = conn.execute(
        "SELECT path, max(period_end) period_end FROM statements WHERE status IN ('parsed', 'needs_review') "
        "AND period_end IS NOT NULL GROUP BY path").fetchall()
    for r in rows:
        src = ROOT / r["path"]
        month = r["period_end"][:7]
        if not src.exists() or not _MONTH_FOLDER.match(src.parent.name) or src.parent.name == month:
            continue
        try:
            src.parent.relative_to(STATEMENTS_DIR)
        except ValueError:
            continue
        moved += _move_file(conn, src, src.parent.parent / month / src.name)
        try:
            src.parent.rmdir()  # drop the old month folder if it's now empty
        except OSError:
            pass
    return moved
`,W=`"""People & loans: money lent to / borrowed from contacts, from e-transfers or cash entries.

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
_ETRANSFER = re.compile(r"E-?TRANSFER|E-TFR|EMAIL TRFS|INTERAC|AUTODEPOSIT|\\bEMT\\b|REQUEST MONEY", re.I)
_BANK_WORDS = re.compile(
    r"^(?:INTERAC\\s+)?(?:E-?TRANSFER|E-TFR|EMAIL TRFS|EMT)\\s*(?:-\\s*)?(?:SENT|RECEIVED|AUTODEPOSIT|AUTO-DEPOSIT|"
    r"CANCELLED|REQUEST(?:\\s+FULFILLED)?)?\\s*(?:-\\s*)?(?:AUTODEPOSIT\\s*)?", re.I)


def suggested_name(description: str) -> str:
    """Best guess at the person in an e-transfer line: "e-Transfer sent jordan LL85WQ" -> "Jordan"."""
    text = re.sub(r"\\(.*?\\)", " ", description)
    text = _BANK_WORDS.sub("", text.strip())
    text = re.sub(r"^(?:FROM|TO)\\s+", "", text.strip(), flags=re.I)  # "FROM HUSBAND (e-Transfer ...)"
    words = [w for w in text.split()
             if not re.fullmatch(r"(?=\\w*\\d)[A-Z0-9]{5,}", w)   # confirmation codes like LL85WQ
             and not re.search(r"\\d{3,}", w)]
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
    name = re.sub(r"\\s+", " ", name).strip()
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
`,Y=`"""Bills that repeat every month (rent, utilities, phone, insurance, subscriptions, loan payments),
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
`,G=`"""Canadian registered-account limits, for estimating room from your own accounts.

CRA My Account is the authority (it knows withdrawals, over-contributions and exact dates); these
estimates are for when you'd rather not look it up. Update TFSA_LIMITS each November when the
next year's limit is announced.
"""

# Annual TFSA dollar limits (CRA)
TFSA_LIMITS = {
    2009: 5000, 2010: 5000, 2011: 5000, 2012: 5000, 2013: 5500, 2014: 5500, 2015: 10000, 2016: 5500,
    2017: 5500, 2018: 5500, 2019: 6000, 2020: 6000, 2021: 6000, 2022: 6000, 2023: 6500, 2024: 7000,
    2025: 7000, 2026: 7000,
}
FHSA_ANNUAL = 8000
FHSA_CARRY_MAX = 8000
FHSA_LIFETIME = 40000


def tfsa_limit(year: int) -> tuple[int, bool]:
    """(limit, known). Years after the table reuse the latest known limit."""
    if year in TFSA_LIMITS:
        return TFSA_LIMITS[year], True
    return TFSA_LIMITS[max(TFSA_LIMITS)], False


def tfsa_cumulative(since_year: int, year: int) -> tuple[int, list[str]]:
    """Total TFSA room accumulated from \`since_year\` (turned 18 and resident, 2009 at the earliest)
    through \`year\`, assuming no withdrawals."""
    notes = []
    start = max(since_year, 2009)
    total = 0
    for y in range(start, year + 1):
        limit, known = tfsa_limit(y)
        total += limit
        if not known:
            notes.append(f"{y} limit assumed \${limit:,}")
    return total, notes


def fhsa_room(opened_year: int, year: int, contributed_total: float) -> tuple[float, float, list[str]]:
    """(room available this year, total limit so far, notes) for an FHSA opened in \`opened_year\`.

    Each year adds $8,000; unused room carries forward but at most $8,000; lifetime cap $40,000.
    Without year-by-year contributions we assume they were spread evenly, which is the usual case
    for the carry-forward limit to bite only when little was contributed.
    """
    years = max(0, year - opened_year + 1)
    total_limit = min(FHSA_LIFETIME, FHSA_ANNUAL * years)
    left_lifetime = max(0.0, FHSA_LIFETIME - contributed_total)
    # at most this year's $8,000 plus $8,000 carried forward
    available = min(total_limit - contributed_total, FHSA_ANNUAL + FHSA_CARRY_MAX, left_lifetime)
    notes = [] if years <= 2 else ["assumes contributions spread over the years (carry-forward is capped at $8,000)"]
    return round(available, 2), float(total_limit), notes
`,V=`"""Built-in categorization keywords (Canada-focused). Seeded into the database on startup.

Matching rules (see categorize.py):
* a keyword must start at the beginning of a word: "PHO" matches "PHO HOA" but not "IPHONE",
  "SUSHI" matches "SUSHIYA"; add a trailing space to require a whole word ("BAR ");
* when several keywords match, the longest wins ("UBER EATS" beats "UBER");
* your own rules always beat these.

Everything here can be edited, disabled or re-assigned from the Rules page; this file only
provides the starting set.
"""

CATEGORIES = {
    # name: kind  (essential / discretionary drive the cutdown suggestions)
    "Income": "income",
    "Interest Earned": "income",
    "Refunds": "income",
    "Rent/Mortgage": "essential",
    "Utilities": "essential",
    "Phone/Internet": "essential",
    "Groceries": "essential",
    "Transit": "essential",
    "Gas/Fuel": "essential",
    "Car": "essential",
    "Insurance": "essential",
    "Health/Pharmacy": "essential",
    "Childcare/Education": "essential",
    "Taxes/Government": "essential",
    "Loan Payment": "essential",
    "Family Support": "essential",   # money sent to support family; never suggested as a cutdown
    "Dining": "discretionary",
    "Food Delivery": "discretionary",
    "Coffee": "discretionary",
    "Alcohol": "discretionary",
    "Shopping": "discretionary",
    "Online Shopping": "discretionary",
    "Subscriptions": "discretionary",
    "Entertainment": "discretionary",
    "Travel": "discretionary",
    "Rideshare/Taxi": "discretionary",
    "Personal Care": "discretionary",
    "Home": "discretionary",
    "Pets": "discretionary",
    "Gifts/Donations": "discretionary",
    "Fees/Interest": "discretionary",
    "Cash Withdrawal": "discretionary",
    "E-Transfer Out": "discretionary",
    "Other": "discretionary",
    "Transfer": "transfer",
    "Credit Card Payment": "transfer",
    "Investment Contribution": "transfer",
    "Lent / Borrowed": "transfer",   # money lent to or borrowed from people (People & loans page)
    "Family Transfer": "transfer",   # money moved between family members' own accounts
}

SEED_RULES: dict[str, list[str]] = {
    "Income": [
        "PAYROLL", "PAY DEPOSIT", "DIRECT DEP", "SALARY", "CANADA PRO DEPOSIT", "GST/HST CREDIT", "GST CREDIT",
        "CANADA CHILD BENEFIT", "CCB ", "EI BENEFIT", "EI CANADA", "FED DEPOSIT", "PROV DEPOSIT",
        "CANADA CARBON REBATE", "CLIMATE ACTION INCENTIVE", "CPP ", "OAS ", "TAX REFUND", "CRA REFUND",
    ],
    "Interest Earned": ["INTEREST EARNED", "INTEREST PAID", "INTEREST CREDIT", "DEPOSIT INTEREST", "DIVIDEND"],
    "Refunds": ["CASHBACK", "CASH BACK REWARD", "REWARDS REDEMPTION", "STATEMENT CREDIT"],

    # ---------------------------------------------------------------- housing & bills
    "Rent/Mortgage": ["MORTGAGE", "RENT ", "RENTAL PMT", "PROPERTY MGMT", "PROPERTY MANAGEMENT", "CONDO FEE",
                      "CONDO CORP", "STRATA", "MAINTENANCE FEE"],
    "Utilities": [
        "HYDRO ONE", "TORONTO HYDRO", "HYDRO OTTAWA", "BC HYDRO", "HYDRO-QUEBEC", "HYDRO QUEBEC", "ENBRIDGE",
        "FORTISBC", "FORTIS ALBERTA", "EPCOR", "ENMAX", "ALECTRA", "ATCO", "ELEXICON", "LONDON HYDRO",
        "NOVA SCOTIA POWER", "NB POWER", "SASKPOWER", "SASKENERGY", "MANITOBA HYDRO", "RELIANCE HOME",
        "ENERCARE", "DIRECT ENERGY", "JUST ENERGY", "WATER BILL", "UTILITIES", "UTILITY",
    ],
    "Phone/Internet": [
        "ROGERS", "BELL CANADA", "BELL MOBILITY", "BELL MTS", "TELUS", "FIDO", "KOODO", "VIRGIN PLUS",
        "VIRGIN MOBILE", "FREEDOM MOBILE", "PUBLIC MOBILE", "CHATR", "SHAW", "VIDEOTRON", "COGECO", "TEKSAVVY",
        "LUCKY MOBILE", "EASTLINK", "SASKTEL", "FIZZ", "START.CA", "DISTRIBUTEL", "ORBIT", "STARLINK",
    ],

    # ---------------------------------------------------------------- food
    "Groceries": [
        "LOBLAWS", "NO FRILLS", "NOFRILLS", "METRO ", "SOBEYS", "FRESHCO", "FOOD BASICS", "FARM BOY",
        "WHOLE FOODS", "T&T", "SAVE ON FOODS", "SAVE-ON-FOODS", "SUPERSTORE", "REAL CANADIAN", "WALMART SUPERCENTER",
        "COSTCO WHOLESALE", "FORTINOS", "ZEHRS", "VALU-MART", "VALUMART", "YOUR INDEPENDENT", "IGA ", "MAXI ",
        "PROVIGO", "SAFEWAY", "FOODLAND", "LONGOS", "LONGO'S", "INSTACART", "VOILA", "PC EXPRESS", "ADONIS",
        "NATIONS FRESH", "GALLERIA", "H MART", "HMART", "SUNNY FOODMART", "BULK BARN", "GIANT TIGER",
        "SUPER C", "CO-OP FOOD", "CALGARY CO-OP", "COUCHE-TARD", "CIRCLE K", "MAC'S", "7-ELEVEN", "7 ELEVEN",
        "HASTY MARKET", "HELLOFRESH", "HELLO FRESH", "CHEFS PLATE", "GOODFOOD", "FRUITICANA", "BUTCHER",
        "FRUIT MARKET", "SUPERMARKET", "GROCERY", "GROCERIES", "FOOD MART", "FOODMART", "PRODUCE",
    ],
    "Dining": [
        # generic words that show up in restaurant names
        "RESTAURANT", "RESTO", "RISTORANTE", "BISTRO", "BRASSERIE", "TRATTORIA", "OSTERIA", "PIZZERIA",
        "PIZZA", "SUSHI", "RAMEN", "UDON", "PHO ", "NOODLE", "DUMPLING", "DIM SUM", "HOT POT", "HOTPOT", "BAO ",
        "BURGER", "BURRITO", "TACO", "TAQUERIA", "CANTINA", "SHAWARMA", "KEBAB", "KABOB", "DONAIR", "FALAFEL",
        "GYRO", "SOUVLAKI", "BIRYANI", "TANDOOR", "CURRY", "DOSA", "MASALA", "THALI", "SWEETS", "BBQ",
        "BARBECUE", "SMOKEHOUSE", "STEAKHOUSE", "STEAK HOUSE", "SEAFOOD", "FISH & CHIPS", "FISH AND CHIPS",
        "WINGS", "FRIED CHICKEN", "CHICKEN", "POUTINE", "DELI ", "DINER", "EATERY", "EATS ", "KITCHEN", "GRILL",
        "TAVERN", "PUB ", "GASTROPUB", "BAR ", "BAR & GRILL", "BAR AND GRILL", "BREWPUB", "LOUNGE", "CUISINE",
        "BRUNCH", "BREAKFAST", "PANCAKE", "WAFFLE", "CREPE", "BAKERY", "PATISSERIE", "BOULANGERIE", "DONUT",
        "DOUGHNUT", "GELATO", "ICE CREAM", "FROZEN YOGURT", "DESSERT", "CHURRO", "POKE", "SALAD", "SANDWICH",
        "SUB SHOP", "PITA", "THAI", "INDIAN", "CHINESE", "KOREAN", "JAPANESE", "VIETNAMESE", "MEXICAN",
        "ITALIAN", "GREEK", "LEBANESE", "PERSIAN", "AFGHAN", "ETHIOPIAN", "JAMAICAN", "CARIBBEAN", "FILIPINO",
        "SZECHUAN", "SICHUAN", "CANTONESE", "HAKKA", "IZAKAYA", "YAKITORI", "TERIYAKI", "WOK ", "HALAL",
        "FOOD COURT", "FOODCOURT", "CAFETERIA", "CATERING", "FOOD TRUCK",
        # chains
        "MCDONALD", "A&W", "WENDY", "BURGER KING", "HARVEY", "SUBWAY", "CHIPOTLE", "MARY BROWN", "POPEYES",
        "KFC", "SWISS CHALET", "ST-HUBERT", "ST HUBERT", "EAST SIDE MARIO", "BOSTON PIZZA", "MONTANA",
        "KELSEY", "THE KEG", "KEG STEAK", "CACTUS CLUB", "EARLS", "JOEY ", "MOXIES", "OSMOW", "LAZEEZ",
        "PARAMOUNT FINE FOODS", "FRESHII", "PIZZA PIZZA", "PIZZA HUT", "DOMINO", "LITTLE CAESAR", "PIZZA NOVA",
        "PANAGO", "FIVE GUYS", "DAIRY QUEEN", "TACO BELL", "NANDO", "JOLLIBEE", "MR. SUB", "MR SUB", "QUIZNOS",
        "EDO JAPAN", "THAI EXPRESS", "MANCHU WOK", "NEW YORK FRIES", "SMOKE'S", "BARBURRITO", "MUCHO BURRITO",
        "GUAC MEX", "FAT BASTARD", "PITA PIT", "PITA LAND", "SUSHI SHOP", "MANDARIN", "CORA ", "DENNY",
        "IHOP", "EGGSMART", "EGGSPECTATION", "SCORES", "JACK ASTOR", "MILESTONES", "BROWNS SOCIAL", "WHITE SPOT",
        "BLACK+BLUE", "RICHTREE", "CHUCK E", "WINGSTOP", "WING MACHINE", "ST. LOUIS BAR", "ST LOUIS BAR",
        "SHAKE SHACK", "IN-N-OUT", "PANERA", "COBS BREAD", "COBS ", "FRESH BURGER", "HERO CERTIFIED",
        "CHOP STEAK", "RED LOBSTER", "OLIVE GARDEN", "APPLEBEE", "TGI FRIDAY", "CHEESECAKE FACTORY",
        "SPUD", "BOOSTER JUICE", "JUGO JUICE", "SMOOTHIE", "OPA OF GREECE", "BUNS MASTER", "COLD STONE",
        "MARBLE SLAB", "BASKIN", "KRISPY KREME", "BEAVERTAILS", "GREAT CANADIAN BAGEL", "BAGEL",
    ],
    "Food Delivery": ["UBER EATS", "UBEREATS", "UBER* EATS", "DOORDASH", "DOOR DASH", "SKIPTHEDISHES",
                      "SKIP THE DISHES", "SKIP*", "FANTUAN", "RITUAL", "GRUBHUB", "FOODORA", "INSTACART RESTAURANT"],
    "Coffee": ["TIM HORTON", "TIMS ", "STARBUCKS", "SECOND CUP", "BALZAC", "COFFEE", "ESPRESSO", "CAFE",
               "CAFFE", "BRIDGEHEAD", "DAVIDSTEA", "DAVIDS TEA", "PILOT COFFEE", "BLENZ", "JJ BEAN", "WAVES COFFEE",
               "COFFEE CULTURE", "COUNTRY STYLE", "COFFEE TIME", "BUBBLE TEA", "BOBA", "CHATIME", "GONG CHA",
               "SHARETEA", "PRESOTEA", "COCO FRESH", "THE ALLEY", "TEA HOUSE", "TEAHOUSE"],
    "Alcohol": ["LCBO", "BEER STORE", "SAQ ", "BC LIQUOR", "LIQUOR", "WINE RACK", "WINE SHOP", "WINERY",
                "BREWERY", "BREWING", "DISTILLERY", "ALCANNA", "WINE AND BEYOND", "NSLC", "ANBL"],

    # ---------------------------------------------------------------- getting around
    "Transit": ["PRESTO", "TTC ", "GO TRANSIT", "OC TRANSPO", "TRANSLINK", "COMPASS", "UP EXPRESS", "VIA RAIL",
                "MIWAY", "CALGARY TRANSIT", "EDMONTON TRANSIT", "STM ", "EXO ", "YRT", "BRAMPTON TRANSIT",
                "HSR ", "GRT ", "BC FERRIES", "METROLINX", "OPUS"],
    "Gas/Fuel": ["PETRO-CANADA", "PETRO CANADA", "PETROCAN", "ESSO", "SHELL ", "HUSKY", "PIONEER", "ULTRAMAR",
                 "CANADIAN TIRE GAS", "CDN TIRE GAS", "GAS BAR", "COSTCO GAS", "MOBIL", "SUNOCO", "CHEVRON",
                 "FAS GAS", "IRVING", "ONROUTE", "EV CHARGING", "FLO ", "CHARGEPOINT", "ELECTRIFY", "TESLA SUPERCHARG"],
    "Car": ["407 ETR", "PARKING", "IMPARK", "GREEN P", "INDIGO PARK", "HONK MOBILE", "PAYBYPHONE",
            "SERVICEONTARIO", "SERVICE ONTARIO", "ICBC", "SAAQ", "REGISTRY", "JIFFY LUBE", "MR. LUBE", "MR LUBE",
            "CAR WASH", "AUTO REPAIR", "AUTO SERVICE", "TIRE ", "KAL TIRE", "MIDAS", "CANADIAN TIRE AUTO",
            "COLLISION", "TOWING", "CAA ", "CARFAX", "AUTOPARTS", "NAPA "],
    "Rideshare/Taxi": ["UBER", "LYFT", "TAXI", "BECK TAXI", "CO-OP CAB", "BLUELINE", "COMMUNAUTO", "EVO CAR",
                       "BIKE SHARE", "LIME*", "BIRD "],
    "Travel": ["AIR CANADA", "WESTJET", "PORTER AIR", "FLAIR AIR", "AIRBNB", "EXPEDIA", "BOOKING.COM", "HOTEL",
               "MARRIOTT", "HILTON", "HYATT", "FAIRMONT", "BEST WESTERN", "HOLIDAY INN", "AIR TRANSAT", "SUNWING",
               "ENTERPRISE RENT", "HERTZ", "AVIS ", "BUDGET RENT", "NATIONAL CAR", "DUTY FREE", "AIRPORT",
               "HOSTEL", "VRBO", "TRIVAGO", "KAYAK", "AEROPLAN", "NEXUS", "PASSPORT CANADA", "RESORT", "MOTEL"],

    # ---------------------------------------------------------------- insurance, health, government
    "Insurance": ["INSURANCE", "INS PREM", "ASSURANCE", "INTACT", "AVIVA", "DESJARDINS INS", "DESJARDINS GEN",
                  "BELAIR", "TD INSURANCE", "SUN LIFE", "SUNLIFE", "MANULIFE", "CANADA LIFE", "GREAT-WEST LIFE",
                  "SQUARE ONE", "ALLSTATE", "CO-OPERATORS", "COOPERATORS", "ECONOMICAL", "SONNET", "WAWANESA",
                  "RBC INSURANCE", "BMO INSURANCE", "SCOTIA INSURANCE", "EMPIRE LIFE", "EQUITABLE LIFE",
                  "INDUSTRIAL ALLIANCE", "IA FINANCIAL", "iA ", "PEMBRIDGE", "GORE MUTUAL", "DEFINITY",
                  "ONLIA", "APOLLO INS", "PBL INS", "BLUE CROSS", "GREEN SHIELD", "TRUPANION", "PETSECURE",
                  "PETS PLUS US", "POLICYME", "HUMANIA", "BENEVA", "LA CAPITALE", "SSQ"],
    "Health/Pharmacy": ["SHOPPERS DRUG", "SHOPPERS", "REXALL", "PHARMA", "DRUG MART", "DRUGSTORE", "DENTAL",
                        "DENTIST", "ORTHODONT", "PHYSIO", "CHIRO", "CLINIC", "MEDICAL", "OPTOMETR", "OPTICAL",
                        "EYEWEAR", "SPECSAVERS", "MASSAGE", "LONDON DRUGS", "JEAN COUTU", "UNIPRIX", "PHARMASAVE",
                        "GUARDIAN PHARM", "IDA PHARM", "LIFELABS", "DYNACARE", "HOSPITAL", "WALK-IN", "WALK IN",
                        "PSYCHOLOG", "THERAP", "COUNSELL", "NATUROPATH", "WELL.CA", "HEALTH"],
    "Childcare/Education": ["DAYCARE", "CHILDCARE", "CHILD CARE", "MONTESSORI", "TUITION", "UNIVERSITY",
                            "COLLEGE", "SCHOOL", "UDEMY", "COURSERA", "KUMON", "SYLVAN", "MASTERCLASS",
                            "SKILLSHARE", "BOOKSTORE", "CAMP "],
    "Taxes/Government": ["CANADA REVENUE", "CRA ", "RECEIVER GENERAL", "PROPERTY TAX", "CITY OF ", "TOWN OF ",
                         "MUNICIPALITY", "REVENU QUEBEC", "SERVICE CANADA", "IRCC", "GOV "],
    "Family Support": ["REMITLY", "WESTERN UNION", "MONEYGRAM", "XOOM", "RIA MONEY", "INSTAREM",
                       "WORLDREMIT", "FAMILY SUPPORT"],
    "Loan Payment": ["LOAN PAYMENT", "LOAN PMT", "STUDENT LOAN", "NSLSC", "CAR LOAN", "AUTO LOAN",
                     "LINE OF CREDIT PMT", "LOC PMT", "FINANCE PMT", "LEASE PMT",
                     "TOYOTA FINANCIAL", "HONDA FINANCIAL", "FORD CREDIT", "GM FINANCIAL", "HYUNDAI CAPITAL"],

    # ---------------------------------------------------------------- shopping & lifestyle
    "Shopping": ["WALMART", "CANADIAN TIRE", "WINNERS", "HOMESENSE", "MARSHALLS", "DOLLARAMA", "DOLLAR TREE",
                 "BEST BUY", "STAPLES", "INDIGO", "CHAPTERS", "SPORT CHEK", "SPORTCHEK", "SPORTING LIFE", "MEC ",
                 "LULULEMON", "H&M", "ZARA", "UNIQLO", "OLD NAVY", "GAP ", "SIMONS", "HUDSON'S BAY", "THE BAY",
                 "SEPHORA", "APPLE STORE", "COSTCO", "MARKS ", "MARK'S", "ROOTS", "ARITZIA", "AMERICAN EAGLE",
                 "FOOT LOCKER", "SOFTMOON", "NIKE", "ADIDAS", "SKECHERS", "ALDO", "CALL IT SPRING", "PAYLESS",
                 "PARTY CITY", "MICHAELS", "TOYS R US", "EB GAMES", "GAMESTOP", "THE SOURCE", "VISIONS",
                 "LONDON DRUGS", "SAAN", "RW&CO", "REITMANS", "SUZY SHIER", "LA SENZA", "BOOTLEGGER", "GARAGE",
                 "DYNAMITE", "URBAN OUTFITTERS", "ZARA", "MANGO", "GUESS", "CLUB MONACO", "HOLT RENFREW",
                 "NORDSTROM", "SAKS", "PANDORA", "PEOPLES JEWELL", "MALL"],
    "Online Shopping": ["AMAZON", "AMZN", "EBAY", "ETSY", "SHEIN", "TEMU", "ALIEXPRESS", "WAYFAIR", "PAYPAL",
                        "SHOPIFY", "BESTBUY.CA", "WALMART.CA", "NEWEGG", "MEMORY EXPRESS", "CANADACOMPUTERS"],
    "Home": ["HOME DEPOT", "RONA", "LOWE'S", "LOWES", "HOME HARDWARE", "IKEA", "LEON'S", "LEONS", "THE BRICK",
             "STRUCTUBE", "BED BATH", "CLEANING", "HARDWARE", "FURNITURE", "MATTRESS", "SLEEP COUNTRY", "LAWN",
             "GARDEN", "PLUMBING", "ELECTRICIAN", "HVAC", "PEST CONTROL", "KITCHEN STUFF", "BOUCLAIR", "JYSK"],
    "Pets": ["PETSMART", "PET VALU", "PETVALU", "PET SMART", "GLOBAL PET", "RENS PETS", "VETERINAR", "VET CLINIC",
             "ANIMAL HOSPITAL", "PET HOSPITAL", "GROOMING", "CHEWY"],
    "Personal Care": ["SALON", "BARBER", "SPA ", "NAIL", "HAIR", "COSMETIC", "ESTHETIC", "WAXING", "LASER",
                      "TATTOO", "FIRST CHOICE HAIR", "GREAT CLIPS", "BENEFIT COSMETIC", "MAC COSMETIC"],
    "Subscriptions": [
        "NETFLIX", "SPOTIFY", "DISNEY PLUS", "DISNEY+", "DISNEYPLUS", "CRAVE", "PRIME VIDEO", "AMAZON PRIME",
        "AMAZON CHANNELS", "PRIME MEMBER", "APPLE.COM/BILL", "APPLE COM BILL", "ITUNES", "GOOGLE STORAGE",
        "GOOGLE ONE", "YOUTUBE", "ICLOUD", "MICROSOFT", "XBOX", "PLAYSTATION", "NINTENDO", "AUDIBLE", "KOBO",
        "PATREON", "OPENAI", "CHATGPT", "ANTHROPIC", "CLAUDE.AI", "ADOBE", "DROPBOX", "PARAMOUNT+", "PARAMOUNTPLUS",
        "DAZN", "SPORTSNET", "TSN ", "APPLE TV", "HAYU", "BRITBOX", "MUBI", "SIRIUSXM", "NEW YORK TIMES",
        "GLOBE AND MAIL", "TORONTO STAR", "MEDIUM.COM", "LINKEDIN", "CANVA", "NOTION", "1PASSWORD", "LASTPASS",
        "NORDVPN", "EXPRESSVPN", "DUOLINGO", "HEADSPACE", "CALM.COM", "STRAVA", "GOODLIFE", "FIT4LESS",
        "PLANET FITNESS", "ANYTIME FITNESS", "LA FITNESS", "ORANGETHEORY", "F45", "CROSSFIT", "YMCA", "PELOTON",
        "CLASSPASS", "MEMBERSHIP", "SUBSCRIPTION",
    ],
    "Entertainment": ["CINEPLEX", "LANDMARK CINEMA", "IMAX", "TICKETMASTER", "STUBHUB", "STEAMGAMES",
                      "STEAM PURCHASE", "EVENTBRITE", "BOWLING", "ESCAPE ROOM", "MUSEUM", "ZOO ", "GOLF",
                      "CANADA'S WONDERLAND", "WONDERLAND", "RIPLEY", "SCIENCE CENTRE", "THEATRE", "THEATER",
                      "CONCERT", "ARCADE", "RECROOM", "THE REC ROOM", "TOPGOLF", "SKI ", "BLUE MOUNTAIN",
                      "WHISTLER", "PARKS CANADA", "LOTTO", "OLG", "LOTO-QUEBEC", "CASINO", "BET365", "FANDUEL"],
    "Gifts/Donations": ["DONATION", "CHARITY", "CANADAHELPS", "UNITED WAY", "RED CROSS", "GOFUNDME",
                        "SICKKIDS", "SALVATION ARMY", "WORLD VISION", "UNICEF", "CHURCH", "MOSQUE", "TEMPLE",
                        "GURDWARA", "FOUNDATION", "FLORIST", "FLOWERS", "HALLMARK", "GIFT"],
    "Fees/Interest": ["SERVICE CHARGE", "MONTHLY FEE", "MONTHLY PLAN FEE", "ACCOUNT FEE", "NSF", "OVERDRAFT",
                      "OVERLIMIT", "OVER LIMIT", "INTEREST CHARGE", "PURCHASE INTEREST", "CASH ADVANCE INTEREST",
                      "ANNUAL FEE", "FOREIGN TRANSACTION", "FX FEE", "ATM FEE", "ABM FEE", "NETWORK FEE",
                      "LATE FEE", "LATE PAYMENT FEE", "E-TRANSFER FEE", "INTERAC FEE", "ACCOUNT MAINTENANCE",
                      "SERVICE FEE", "RETURNED ITEM", "STOP PAYMENT", "PAPER STATEMENT", "INTEREST PAYMENT",
                      "LOAN INTEREST", "LOC INTEREST", "REGULAR PURCHASES", "CASH ADVANCES INTEREST", "CREDIT LINE INTEREST", "INTEREST ON LOAN", "STANDBY FEE"],
    "Cash Withdrawal": ["ATM WITHDRAWAL", "ABM WITHDRAWAL", "CASH WITHDRAWAL", "ATM W/D", "ABM W/D",
                        "CASH ADVANCE"],
    "E-Transfer Out": ["E-TRANSFER SENT", "SEND E-TFR", "INTERAC E-TRANSFER SENT", "E-TFR SENT", "EMT SENT",
                       "E-TRANSFER TO"],

    # ---------------------------------------------------------------- money moving between your accounts
    "Credit Card Payment": ["PAYMENT - THANK YOU", "PAYMENT THANK YOU", "PAYMENT RECEIVED", "PAIEMENT MERCI",
                            "CREDIT CARD PAYMENT", "VISA PAYMENT", "MASTERCARD PAYMENT", "MC PAYMENT",
                            "AMEX PAYMENT", "AMERICAN EXPRESS PAYMENT", "TD VISA", "RBC VISA", "CIBC VISA",
                            "BMO MASTERCARD", "SCOTIABANK VISA", "SCOTIA VISA", "BILL PAYMENT VISA",
                            "ROGERS BANK", "TRIANGLE MASTERCARD", "PC MASTERCARD", "CAPITAL ONE",
                            "PAID AUTOMATICALLY", "WWW PMT", "PRINCIPAL PAYMENT", "CREDIT LINE PAYMENT",
                            "LOC PAYMENT"],
    "Investment Contribution": ["WEALTHSIMPLE", "QUESTRADE", "TFSA CONTRIBUTION", "RRSP CONTRIBUTION",
                                "FHSA CONTRIBUTION", "INVESTMENT PURCHASE", "MUTUAL FUND", "DIRECT INVESTING",
                                "INVESTORLINE", "WEBBROKER", "INTERACTIVE BROKERS", "NATIONAL BANK DIRECT",
                                "MOOMOO", "NEST WEALTH", "JUSTWEALTH", "CI DIRECT"],
    "Transfer": ["WWW TRANSFER", "WWW TFR", "TRANSFER TO", "TRANSFER FROM", "TFR-TO", "TFR-FR", "TFR TO", "TFR FROM",
                 "INTERNET TRANSFER", "ONLINE TRANSFER", "ONLINE BANKING TRANSFER", "MB-TRANSFER", "WWW TRF",
                 "INTERNAL TRANSFER", "ACCOUNT TRANSFER"],
}
`,q=`"""Whose data a request is about: one family member, several, or everyone.

The API reads \`?members=1,2\` into a context variable (see the middleware in app.py); the analytics
code then calls \`account_filter()\` so every total only includes those members' accounts.
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
    """SQL fragment (starting with AND) restricting \`alias\` (an accounts row) to the selection."""
    ids = current()
    if ids is None:
        return "", []
    return f" AND {alias}.member_id IN ({','.join('?' * len(ids))})", list(ids)


def primary_id(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT id FROM members WHERE is_primary = 1").fetchone()[0]


def owner_visible(conn: sqlite3.Connection, member_id: int | None) -> bool:
    """Is something owned by \`member_id\` (None = unassigned, i.e. the primary member's) in view?"""
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
`,K=`"""Locked snapshot of the database for the phone app.

The PC writes \`finance-snapshot.fmsnap\` into a folder you choose (e.g. your Google Drive folder). The
phone app opens it read-only. The file is encrypted with your passphrase, so the cloud only ever
holds unreadable bytes. The passphrase is kept in Windows Credential Manager, never in the database.

File layout (the phone decrypts it with WebCrypto, see frontend/src/phone/snapshot.ts):
    b"FMS1" | iterations: uint32 BE | salt: 16 bytes | iv: 12 bytes | AES-256-GCM ciphertext + tag
The header (first 36 bytes) is the GCM associated data. The key is PBKDF2-HMAC-SHA256(NFC passphrase,
salt, iterations). The plaintext is gzip(meta_len: uint32 BE | meta JSON | SQLite database bytes).
"""
import gzip
import hashlib
import json
import os
import sqlite3
import string
import struct
import threading
import unicodedata
from datetime import datetime
from pathlib import Path

import keyring

from .config import DB_PATH, ROOT

MAGIC = b"FMS1"
ITERATIONS = 600_000
FILE_NAME = "finance-snapshot.fmsnap"
MIN_PASSPHRASE = 10
SERVICE = "finance-dashboard-snapshot"
_USER = f"passphrase {ROOT}"  # per data folder, so the demo never touches your real passphrase
_FOLDER_KEY = "snapshot_folder"
_LAST_KEY = "snapshot_last"
# settings rows the phone has no use for
_PRIVATE_SETTINGS = ("pdf_password_labels", _FOLDER_KEY, _LAST_KEY)


def _key(passphrase: str, salt: bytes, iterations: int) -> bytes:
    # NFC so a passphrase typed on the phone's keyboard matches the one typed on the PC
    return hashlib.pbkdf2_hmac("sha256", unicodedata.normalize("NFC", passphrase).encode(), salt, iterations, dklen=32)


def encrypt(plain: bytes, passphrase: str, iterations: int = ITERATIONS) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    salt, iv = os.urandom(16), os.urandom(12)
    header = MAGIC + struct.pack(">I", iterations) + salt + iv
    return header + AESGCM(_key(passphrase, salt, iterations)).encrypt(iv, plain, header)


def decrypt(blob: bytes, passphrase: str) -> bytes:
    """Inverse of encrypt (the phone does this in JavaScript; here for tests)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if blob[:4] != MAGIC:
        raise ValueError("not a Finance Master snapshot")
    (iterations,) = struct.unpack(">I", blob[4:8])
    salt, iv, header = blob[8:24], blob[24:36], blob[:36]
    return AESGCM(_key(passphrase, salt, iterations)).decrypt(iv, blob[36:], header)


def pack(db_bytes: bytes, meta: dict) -> bytes:
    m = json.dumps(meta).encode()
    return gzip.compress(struct.pack(">I", len(m)) + m + db_bytes, 6)


def unpack(plain: bytes) -> tuple[dict, bytes]:
    raw = gzip.decompress(plain)
    (n,) = struct.unpack(">I", raw[:4])
    return json.loads(raw[4:4 + n]), raw[4 + n:]


def database_copy(db_path: Path = DB_PATH) -> tuple[bytes, dict]:
    """Consistent copy of the live database (safe while the app runs), minus PC-only settings."""
    src = sqlite3.connect(db_path)
    mem = sqlite3.connect(":memory:")
    try:
        src.backup(mem)
    finally:
        src.close()
    mem.execute(f"DELETE FROM settings WHERE key IN ({','.join('?' * len(_PRIVATE_SETTINGS))})", _PRIVATE_SETTINGS)
    mem.commit()
    mem.execute("VACUUM")
    meta = {
        "app": "Finance Master",
        "format": 1,
        "created": datetime.now().astimezone().isoformat(timespec="seconds"),
        "transactions": mem.execute("SELECT count(*) FROM transactions").fetchone()[0],
        "accounts": mem.execute("SELECT count(*) FROM accounts WHERE archived = 0").fetchone()[0],
    }
    data = mem.serialize()
    mem.close()
    return data, meta


# ---------------------------------------------------------------- settings


def _get(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def _set(conn: sqlite3.Connection, key: str, value: str | None) -> None:
    if value is None:
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))
    else:
        conn.execute("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (key, value))


def _passphrase() -> str | None:
    try:
        return keyring.get_password(SERVICE, _USER)
    except Exception:
        return None


def suggested_folders() -> list[str]:
    """Google Drive / OneDrive folders on this PC, each with a Finance Master subfolder."""
    found: list[Path] = []
    home = Path.home()
    for letter in string.ascii_uppercase[3:]:  # Google Drive for desktop mounts as a drive, usually G:
        found += [Path(f"{letter}:/My Drive")]
    found += [home / "My Drive", home / "Google Drive", home / "Google Drive" / "My Drive"]
    if os.environ.get("OneDrive"):
        found.append(Path(os.environ["OneDrive"]))
    out = []
    for p in found:
        try:
            if p.is_dir():
                out.append(str(p / "Finance Master"))
        except OSError:
            pass
    return out


def status(conn: sqlite3.Connection) -> dict:
    folder = _get(conn, _FOLDER_KEY)
    last = _get(conn, _LAST_KEY)
    return {
        "folder": folder,
        "enabled": bool(folder and _passphrase()),
        "last": json.loads(last) if last else None,
        "suggestions": suggested_folders(),
        "file_name": FILE_NAME,
        "min_passphrase": MIN_PASSPHRASE,
    }


def configure(conn: sqlite3.Connection, folder: str, passphrase: str | None) -> None:
    path = Path(folder.strip().strip('"')).expanduser()
    if not path.is_absolute():
        raise ValueError("Choose a full folder path, e.g. G:\\\\My Drive\\\\Finance Master")
    if not path.parent.exists():
        raise ValueError(f"{path.parent} doesn't exist. Is Google Drive for desktop running?")
    path.mkdir(exist_ok=True)
    if passphrase is not None:
        if len(passphrase) < MIN_PASSPHRASE:
            raise ValueError(f"Use a passphrase of at least {MIN_PASSPHRASE} characters, e.g. four random words")
        keyring.set_password(SERVICE, _USER, passphrase)
    elif not _passphrase():
        raise ValueError("Choose a passphrase")
    _set(conn, _FOLDER_KEY, str(path))


def disable(conn: sqlite3.Connection) -> None:
    try:
        keyring.delete_password(SERVICE, _USER)
    except Exception:
        pass
    _set(conn, _FOLDER_KEY, None)
    _set(conn, _LAST_KEY, None)


# ---------------------------------------------------------------- writing

_lock = threading.Lock()
_timer: threading.Timer | None = None


def write(conn: sqlite3.Connection) -> dict | None:
    """Write the snapshot now if it's set up. Returns what was written (None when switched off)."""
    folder, passphrase = _get(conn, _FOLDER_KEY), _passphrase()
    if not folder or not passphrase:
        return None
    with _lock:
        db_bytes, meta = database_copy()
        blob = encrypt(pack(db_bytes, meta), passphrase)
        target = Path(folder) / FILE_NAME
        tmp = target.with_suffix(".tmp")
        tmp.write_bytes(blob)
        os.replace(tmp, target)  # sync clients never see a half-written file
    last = {"time": meta["created"], "path": str(target), "size": len(blob), "transactions": meta["transactions"]}
    _set(conn, _LAST_KEY, json.dumps(last))
    return last


def write_soon(delay: float = 20.0) -> None:
    """Rewrite the snapshot a little after the last change (edits often come in bursts)."""
    global _timer
    if _timer:
        _timer.cancel()
    _timer = threading.Timer(delay, _write_in_background)
    _timer.daemon = True
    _timer.start()


def _write_in_background() -> None:
    from .db import session

    try:
        with session() as conn:
            write(conn)
    except Exception as e:  # a locked/offline Drive folder shouldn't break the dashboard
        print(f"Phone snapshot not written: {e}")
`,X=`"""Flag money moving between the user's own accounts so it isn't counted as spending or income."""
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
    return {m[-4:] for m in re.findall(r"\\d{4,}", description)}


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
`;class p extends Error{constructor(e,t){super(t),this.code=e}}const j="FMS1";function z(n){return n.byteLength>52&&new TextDecoder().decode(new Uint8Array(n,0,4))===j}async function $(n,e){if(!z(n))throw new p("not-snapshot","That file isn't a Finance Master snapshot. Pick finance-snapshot.fmsnap.");const t=new Uint8Array(n),a=new DataView(n).getUint32(4),d=t.slice(0,36),l=await crypto.subtle.importKey("raw",new TextEncoder().encode(e.normalize("NFC")),"PBKDF2",!1,["deriveKey"]),s=await crypto.subtle.deriveKey({name:"PBKDF2",salt:t.slice(8,24),iterations:a,hash:"SHA-256"},l,{name:"AES-GCM",length:256},!1,["decrypt"]);let i;try{i=await crypto.subtle.decrypt({name:"AES-GCM",iv:t.slice(24,36),additionalData:d},s,t.slice(36))}catch{throw new p("wrong-passphrase","Wrong passphrase.")}try{const o=new Blob([i]).stream().pipeThrough(new DecompressionStream("gzip")),r=new Uint8Array(await new Response(o).arrayBuffer()),m=new DataView(r.buffer,r.byteOffset).getUint32(0);return{meta:JSON.parse(new TextDecoder().decode(r.subarray(4,4+m))),db:r.slice(4+m)}}catch{throw new p("damaged","The snapshot file is damaged. Update it on the PC and pick it again.")}}const _=n=>new URL(n,self.location.href).origin===self.location.origin,J=self.fetch.bind(self);self.fetch=(n,e)=>{const t=n instanceof Request?n.url:n;return _(t)?J(n,e):Promise.reject(new TypeError("The phone app doesn't contact other sites"))};const Z=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(...n){if(!_(n[1]))throw new TypeError("The phone app doesn't contact other sites");return Z.apply(this,n)};for(const n of["WebSocket","EventSource","WebTransport"])self[n]=void 0;const Q=Object.assign({"../../../backend/__init__.py":T,"../../../backend/analytics.py":N,"../../../backend/app.py":b,"../../../backend/categorize.py":y,"../../../backend/checks.py":g,"../../../backend/config.py":A,"../../../backend/coverage.py":R,"../../../backend/db.py":S,"../../../backend/family.py":O,"../../../backend/ingest/__init__.py":I,"../../../backend/ingest/csvparse.py":w,"../../../backend/ingest/detect.py":L,"../../../backend/ingest/generic.py":v,"../../../backend/ingest/manage.py":C,"../../../backend/ingest/model.py":x,"../../../backend/ingest/passwords.py":D,"../../../backend/ingest/pdftext.py":M,"../../../backend/ingest/rbc_export.py":P,"../../../backend/ingest/scanner.py":k,"../../../backend/ingest/tables.py":F,"../../../backend/insights.py":U,"../../../backend/insurance.py":H,"../../../backend/members.py":B,"../../../backend/people.py":W,"../../../backend/recurring.py":Y,"../../../backend/room_rules.py":G,"../../../backend/rules_library.py":V,"../../../backend/scope.py":q,"../../../backend/snapshot.py":K,"../../../backend/transfers.py":X}),E="/home/pyodide/finance",h="/home/pyodide/app",nn=`
import os, sys, types, asyncio, warnings
warnings.filterwarnings("ignore", category=SyntaxWarning)  # old docstrings with Windows paths
os.environ["FINANCE_HOME"] = "${E}"
sys.path.insert(0, "${h}")

class _PcOnly(types.ModuleType):
    """Libraries only the PC needs (reading PDFs/spreadsheets, Windows Credential Manager)."""
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        raise RuntimeError(f"{self.__name__} isn't available in the phone app")

for _m in ("pikepdf", "pdfplumber", "keyring", "openpyxl", "xlrd"):
    sys.modules[_m] = _PcOnly(_m)
_mp = types.ModuleType("python_multipart"); _mp.__version__ = "0.0.20"
sys.modules["python_multipart"] = _mp  # FastAPI checks it's installed; the phone never uploads

# Browsers don't have threads: run FastAPI's sync endpoints inline.
import fastapi.concurrency, fastapi.dependencies.utils, fastapi.routing, starlette.concurrency
async def _inline(func, *args, **kwargs):
    return func(*args, **kwargs)
for _mod in (fastapi.concurrency, fastapi.dependencies.utils, fastapi.routing, starlette.concurrency):
    if hasattr(_mod, "run_in_threadpool"):
        _mod.run_in_threadpool = _inline

from backend import db as _db
_db.init_db()  # brings a snapshot from an older PC version up to this schema (in memory only)
from backend.app import app as _app

async def handle(method, path, query, body):
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
             "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "",
             "query_string": query.encode(), "client": ("127.0.0.1", 0), "server": ("phone", 80),
             "headers": [(b"host", b"phone"), (b"content-type", b"application/json")]}
    done = asyncio.Event()
    sent = False
    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body.encode(), "more_body": False}
        await done.wait()
        return {"type": "http.disconnect"}
    status, chunks = 500, []
    async def send(message):
        nonlocal status
        if message["type"] == "http.response.start":
            status = message["status"]
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))
            if not message.get("more_body"):
                done.set()
    await _app(scope, receive, send)
    done.set()
    return [status, b"".join(chunks).decode()]
`;let f=null;const c=n=>self.postMessage(n);async function en(n,e,t,a){const{meta:d,db:l}=await $(e,t);c({type:"progress",text:"Starting the engine…"});const s=`${a}pyodide/314.0.7/`,{loadPyodide:i}=await import(`${s}pyodide.mjs`),o=await i({indexURL:s,packageBaseUrl:s,stdout:()=>{},stderr:r=>console.warn(r)});c({type:"progress",text:"Loading Python packages…"}),await o.loadPackage(["fastapi"],{messageCallback:()=>{}});for(const[r,m]of Object.entries(Q)){const u=`${h}/${r.replace(/^(\.\.\/)+/,"")}`;o.FS.mkdirTree(u.slice(0,u.lastIndexOf("/"))),o.FS.writeFile(u,m)}o.FS.mkdirTree(`${E}/data`),o.FS.mkdirTree(`${E}/statements`),o.FS.writeFile(`${E}/data/finance.db`,l),c({type:"progress",text:"Opening your data…"}),await o.runPythonAsync(nn),f=o.globals.get("handle"),c({type:"opened",id:n,meta:d})}async function tn(n,e,t,a){if(!f)throw new Error("The engine isn't running");const[d,l=""]=t.split("?"),s=await f(e,d,l,a),[i,o]=s.toJs();s.destroy(),c({type:"response",id:n,status:i,text:o})}self.onmessage=n=>{const e=n.data;(e.type==="open"?en(e.id,e.bytes,e.passphrase,e.base):tn(e.id,e.method,e.url,e.body??"")).catch(a=>c({type:"error",id:e.id,code:a instanceof p?a.code:"engine",message:a instanceof Error?a.message:String(a)}))};
