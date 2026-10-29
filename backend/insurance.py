"""Insurance: policies you enter (coverages, premiums, renewal) + what your statements show you paid."""
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
