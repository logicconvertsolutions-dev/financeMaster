"""Walk the statements folder, parse anything new, and store the results."""
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
