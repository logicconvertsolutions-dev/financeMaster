"""SQLite schema and connection helper."""
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
    member_id INTEGER REFERENCES members(id),  -- whose account (from the statements\<name>\ folder)
    UNIQUE (institution, type, last4)
);

CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    folder TEXT UNIQUE,              -- statements\<folder>\ holds their files; NULL = the top level (you, before moving)
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
