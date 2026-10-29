"""Identify institution, account type and registration from statement text."""
import re

# Checked in order; the first institution with a matching pattern wins.
INSTITUTIONS: list[tuple[str, list[str]]] = [
    ("Wealthsimple", [r"WEALTHSIMPLE"]),
    ("Questrade", [r"QUESTRADE"]),
    ("KOHO", [r"\bKOHO\b"]),
    ("EQ Bank", [r"\bEQ BANK\b", r"EQUITABLE BANK"]),
    ("Tangerine", [r"TANGERINE"]),
    ("Simplii", [r"SIMPLII"]),
    ("RBC", [r"ROYAL BANK OF CANADA", r"\bRBC\b"]),
    ("TD", [r"TORONTO-DOMINION", r"TD CANADA TRUST", r"\bTD BANK\b", r"\bTD\b"]),
    ("Scotiabank", [r"SCOTIABANK", r"BANK OF NOVA SCOTIA", r"\bSCOTIA\b"]),
    ("BMO", [r"BANK OF MONTREAL", r"\bBMO\b"]),
    ("CIBC", [r"CANADIAN IMPERIAL BANK", r"\bCIBC\b"]),
    ("Amex", [r"AMERICAN EXPRESS"]),
]

REGISTRATIONS: list[tuple[str, list[str]]] = [
    ("FHSA", [r"\bFHSA\b", r"FIRST HOME SAVINGS", r"\bCELIAPP\b"]),
    ("TFSA", [r"\bTFSA\b", r"TAX[- ]FREE SAVINGS", r"\bCELI\b"]),
    ("RRSP", [r"\bRRSP\b", r"RETIREMENT SAVINGS PLAN", r"\bREER\b", r"\bRRIF\b"]),
]

CREDIT_SIGNALS = [r"CREDIT LIMIT", r"MINIMUM PAYMENT", r"AVAILABLE CREDIT", r"PAYMENT DUE DATE",
                  r"CREDIT AVAILABLE", r"LIMITE DE CR"]
INVESTMENT_SIGNALS = [r"MARKET VALUE", r"BOOK VALUE", r"BOOK COST", r"HOLDINGS", r"PORTFOLIO",
                      r"ASSET ALLOCATION", r"SELF[- ]DIRECTED", r"INVESTMENT ACCOUNT", r"SECURITIES"]
LOAN_SIGNALS = [r"MORTGAGE STATEMENT", r"PRINCIPAL BALANCE", r"AMORTIZATION", r"LOAN STATEMENT",
                r"LINE OF CREDIT STATEMENT", r"OUTSTANDING PRINCIPAL", r"LOAN BALANCE"]
LOC_SIGNAL = r"LINE OF CREDIT|CREDIT LINE|\bHELOC\b|HOME EQUITY|MARGE DE CR"
CARD_NETWORKS = r"\bVISA\b|MASTERCARD|MASTER CARD|AMERICAN EXPRESS|\bAMEX\b|CREDIT CARD|CARTE DE CR"
SAVINGS_SIGNALS = [r"SAVINGS ACCOUNT", r"HIGH INTEREST", r"\bSAVINGS\b", r"E-SAVINGS", r"SAVINGS PLUS"]


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
    r"(?:ACCOUNT|ACCT|CARD)\s*(?:NUMBER|NO\.?|#)?\s*:?\s*([0-9Xx*•\- ]{4,30}\d{3,4})\b", re.IGNORECASE
)


_ACCT_ALNUM = re.compile(
    # the id must contain a digit, so plain words ("Account Account number: HQ8X12345") never match
    r"(?:ACCOUNT|ACCT)\s*(?:NUMBER|NO\.?|#|ID)?\s*:?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,19})\b", re.IGNORECASE)


def detect_last4(text: str) -> str | None:
    """Last 4 characters of the account number (digits, or letters+digits like brokerage ids)."""
    for m in _ACCT_NO.finditer(text):  # keep looking: "Investment Account  Account number: ..."
        digits = re.sub(r"\D", "", m.group(1))
        if len(digits) >= 4:
            return digits[-4:]
    for m in _ACCT_ALNUM.finditer(text):
        if re.search(r"\d", m.group(1)):  # "HQ8X12345" -> "2345"; needs a digit so words don't match
            ident = re.sub(r"[^A-Z0-9]", "", m.group(1).upper())
            if len(ident) >= 5:
                return ident[-4:]
    # masked card numbers like "4520 **** **** 1234"
    m = re.search(r"(?:\*{2,}|X{2,}|•{2,})\s?(\d{4})\b", text)
    return m.group(1) if m else None
