"""Cross-page consistency checks: the same figure must be the same number everywhere it appears.

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
