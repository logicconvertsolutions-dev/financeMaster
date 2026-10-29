"""Keyword rule engine for transaction categories.

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
    r"^(?:(?:POS|OPOS|APOS|IDP|POINT OF SALE|CONTACTLESS|INTERAC|VISA DEBIT|DEBIT|RETAIL)\s+)*"
    r"(?:PURCHASE\s*-?\s*|PRE-?AUTHORI[SZ]ED\s+(?:PAYMENT|DEBIT|PMT)\s*-?\s*|PRE-AUTH\s+|"
    r"ONLINE BANKING PAYMENT\s*-?\s*|BILL PAYMENT\s*-?\s*|MISC PAYMENT\s*-?\s*|PAYMENT\s*-\s*|"
    r"E-TRANSFER SENT\s*|INTERAC E-TRANSFER SENT\s*|SEND E-TFR\s*\S*\s*)?"
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
    return re.sub(r"\s+", " ", description.upper()).strip()


def merchant_key(description: str) -> str:
    """A stable short merchant name: drop payment-processor prefixes, store numbers and location.

    Two words is the sweet spot: enough to tell "UBER EATS" from "UBER TRIP", short enough to
    drop the city that most statements append ("TIM HORTONS #123 TORONTO ON" -> "TIM HORTONS").
    """
    text = re.sub(r"\(.*?\)", " ", normalize(description)).strip()  # "(Payroll Deposit)"-style notes
    stripped = _PREFIXES.sub("", text)
    if re.search(r"[A-Z]{2,}", re.sub(r"\S*\d\S*", " ", stripped)):
        text = stripped  # keep the bank wording when it's all there is ("E-TRANSFER SENT")
    text = re.sub(r"^(SQ|TST|SP|PAYPAL|PP|DD)\s*\*\s*", "", text)
    text = re.sub(r"[#*]\s*\S*\d\S*", " ", text)          # store / reference numbers
    text = re.sub(r"\S*\d\S*", " ", text)                 # any token containing digits
    text = re.sub(rf"\s+{_PROVINCES}$", "", text.strip())  # trailing province code
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
    pattern = re.sub(r"\s+", " ", pattern.upper()).strip()
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
