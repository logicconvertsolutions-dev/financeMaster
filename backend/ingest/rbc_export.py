"""RBC Online Banking "Download transactions" export (CSV, or the same opened/saved in Excel).

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
    (r"LINE OF CREDIT|CREDIT LINE|\bRCL\b|LOAN|MORTGAGE|\bLOC\b|HELOC|HOMELINE", "loan"),
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
        if d1 and d2 and len(d1.split()) <= 3 and not re.search(r"\d", d1):
            desc = f"{d2} ({d1})"  # d1 is RBC's transaction type ("Payroll Deposit"), d2 the payee
        else:
            desc = " ".join(x for x in (d1, d2) if x) or "(no description)"
        if cheque:
            desc += f" (cheque {cheque})"
        groups[key].append(ParsedTx(d.isoformat(), re.sub(r"\s+", " ", desc), round(cad, 2)))

    out = []
    for (acct_type, acct_no), txs in groups.items():
        digits = re.sub(r"\D", "", acct_no)
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
