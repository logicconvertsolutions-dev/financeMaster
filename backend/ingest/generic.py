"""Layout-independent statement parser.

Works line by line on extracted PDF text, so it copes with most Canadian bank layouts without a
per-bank template:

* a transaction line starts with a date (``Sep 03``, ``03 SEP``, ``2026-09-03``, ``09/03``...),
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
_YEAR = r"((?:19|20)\d{2})(?![\d.,])"

# Each returns (year|None, month, day) via its own group order.
_DATE_FORMS = [
    ("ymd", re.compile(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b")),
    ("dmy_name", re.compile(rf"(\d{{1,2}})[\s\-]?{_MON}\.?(?:[\s,\-]+{_YEAR})?", re.I)),
    ("mdy_name", re.compile(rf"{_MON}\.?\s?(\d{{1,2}})\b(?:,?\s+{_YEAR})?", re.I)),
    ("mdy_num", re.compile(r"(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b")),
]

_AMOUNT = re.compile(r"(\(?\s?-?\s?\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\s?\)?(?:\s?(?:CR|DR|-))?)\s*$", re.I)

SUMMARY_WORDS = re.compile(
    r"OPENING BALANCE|CLOSING BALANCE|BALANCE FORWARD|PREVIOUS (STATEMENT )?BALANCE|NEW BALANCE|"
    r"BEGINNING BALANCE|ENDING BALANCE|STARTING BALANCE|STATEMENT BALANCE|\bTOTAL|SUBTOTAL|"
    r"MINIMUM PAYMENT|CREDIT LIMIT|AVAILABLE CREDIT|CREDIT AVAILABLE|PAYMENT DUE|INTEREST RATE|"
    r"ANNUAL INTEREST|CASH ADVANCE LIMIT|BALANCE AS OF|YOUR BALANCE|AMOUNT DUE|PAGE \d",
    re.I,
)
INFLOW_WORDS = re.compile(
    r"DEPOSIT|PAYROLL|SALARY|\bPAY\b|RECEIVED|AUTODEPOSIT|AUTO-DEPOSIT|TRANSFER FROM|TFR-FR|FROM ACCT|"
    r"INTEREST (EARNED|PAID|CREDIT)|DEPOSIT INTEREST|REFUND|REVERSAL|REBATE|CASHBACK|CASH BACK|GST|"
    r"CANADA CHILD|\bCCB\b|FED\b|PROV\b|DIVIDEND|CONTRIBUTION|TRANSFER IN",
    re.I,
)
INVESTMENT_KEEP = re.compile(r"CONTRIBUTION|DEPOSIT|DIVIDEND|INTEREST|WITHDRAWAL|TRANSFER|FEE|DISTRIBUTION", re.I)
INVESTMENT_OUT = re.compile(r"WITHDRAWAL|TRANSFER OUT|FEE", re.I)

_ANY_AMOUNT = re.compile(
    r"(?<![\w.,/])(\(?-?\s?\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?(?:\s?(?:CR|DR)\b)?)(?![\w.,/%])", re.I)
_BAL_OPEN = re.compile(r"(OPENING|PREVIOUS|BEGINNING|STARTING)\s+(STATEMENT\s+|ACCOUNT\s+)?BALANCE|BALANCE\s+FORWARD", re.I)
_BAL_CLOSE = re.compile(r"(CLOSING|NEW|ENDING|TOTAL)\s+(STATEMENT\s+|ACCOUNT\s+)?BALANCE|STATEMENT BALANCE|BALANCE AT END", re.I)
_PRINCIPAL_BAL = re.compile(r"PRINCIPAL BALANCE (?:ON|AS OF)\b", re.I)
_BARE_LIMIT = re.compile(r"(?<!CASH )\bLIMIT\b(?=\s*\$)", re.I)  # "Limit $10,000.00" under a "Credit" heading
_CREDIT_LIMIT = re.compile(r"CREDIT LIMIT", re.I)
_MARKET_VALUE = re.compile(
    r"TOTAL\s+(PORTFOLIO|MARKET|ACCOUNT|INVESTMENT)\s+VALUE|TOTAL\s+VALUE|ACCOUNT\s+VALUE|"
    r"TOTAL\s+MARKET\s+VALUE|CLOSING\s+(MARKET\s+)?VALUE|ENDING\s+VALUE|NET\s+ASSETS",
    re.I,
)
_BOOK_VALUE = re.compile(r"TOTAL\s+BOOK\s+(VALUE|COST)|BOOK\s+(VALUE|COST)\s+TOTAL", re.I)


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


_RANGE = re.compile(r"\s*(?:TO|-|–|—|THROUGH|AU|UNTIL)\s*", re.I)


def find_period(text: str) -> tuple[date | None, date | None]:
    """Find a 'date to date' statement period; the second date must carry a year."""
    flat = re.sub(r"\s+", " ", text)
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
    m = re.search(r"STATEMENT DATE\s*:?\s*(.{6,25})", flat, re.I)
    if m:
        ds = find_dates(m.group(1))
        if ds and ds[0][1][0]:
            return None, _resolve(ds[0][1], date.today())
    return None, None


# ---------------------------------------------------------------- amounts

def parse_amount(token: str) -> float:
    t = token.strip().upper()
    negative = t.startswith("(") or t.startswith("-") or t.endswith("-") or t.endswith("CR") or "-" in t[:3]
    digits = re.sub(r"[^\d.]", "", t.replace("CR", "").replace("DR", ""))
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
    ("fee", re.compile(r"^(INTEREST|FEES?|INSURANCE|CHARGES?)\b")),
    ("out", re.compile(r"^(WITHDRAW|DEBITS?\b|CHEQUES?\b|PURCHASES|ADVANCES|MONEY OUT|FUNDS OUT|PAID OUT)")),
    ("in", re.compile(r"^(DEPOSITS?\b|CREDITS?\b|PAYMENTS?\b|MONEY IN|FUNDS IN|PAID IN)")),
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
    words = list(re.finditer(r"\S+", line.text))
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
            if re.fullmatch(r"[^\w\s]{1,4}|\(\$\)|\(%\)|\(CAD\)|\(\$CAD\)|OWING|AMT|CAD|\$|SPEND|CATEGOR(Y|IES)"
                            r"|ANNUAL|RATE|TRANS\.?|POST(ED)?", word):
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
    text = "\n".join(all_text)
    head = "\n".join(t for page in text_pages[:2] for t in page)

    # institution and registration come from the letterhead: transaction descriptions on page 1
    # ("transfer to Wealthsimple TFSA") would otherwise be mistaken for the statement's own bank
    letterhead = "\n".join(_letterhead(text_pages[0])) if text_pages else ""

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
        years = re.findall(r"\b(20\d{2})\b", text)
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
        if re.search(r"\$\s?\d[\d,]*\.\d{2}", full):
            continue  # a "$" figure inside the description: summary boxes / payment slips, not a purchase
        if roles is not None and all(r is None for r in roles):
            roles = None
        in_table = True
        entries.append({"date": cur_date.isoformat(), "desc": re.sub(r"\s+", " ", full), "amounts": amounts,
                        "roles": roles, "section": section})
    return entries


_SECTION_IN = re.compile(r"^(YOUR\s+)?(PAYMENTS?(\s+(AND|&)\s+(OTHER\s+)?CREDITS)?|(OTHER\s+)?CREDITS|PAYMENTS?\s+RECEIVED)$", re.I)
_SECTION_OUT = re.compile(r"^(YOUR\s+)?(NEW\s+)?(CHARGES|PURCHASES|INTEREST|FEES|CASH ADVANCES|TRANSACTIONS)\b", re.I)


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
        if not INVESTMENT_KEEP.search(e["desc"]) or re.search(r"\bBUY\b|\bSELL\b|BOUGHT|SOLD", e["desc"], re.I):
            continue
        value = abs(e["amounts"][0])
        out.append(ParsedTx(e["date"], e["desc"], -value if INVESTMENT_OUT.search(e["desc"]) else value))
    return out
