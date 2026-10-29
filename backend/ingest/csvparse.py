"""Generic CSV/Excel exports from online banking.

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
        desc = re.sub(r"\s+", " ", r[si]).strip()
        st.transactions.append(ParsedTx(d.isoformat(), desc, round(amount, 2)))
    if st.transactions:
        ds = sorted(t.date for t in st.transactions)
        st.period_start, st.period_end = ds[0], ds[-1]
    st.warnings.append("This export doesn't say which account it belongs to - pick one and check the signs.")
    return st
