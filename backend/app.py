"""FastAPI app: JSON API under /api, the built React dashboard everywhere else."""
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
from .config import BACKUP_DIR, DATA_DIR, FRONTEND_DIST, STATEMENT_EXTENSIONS, STATEMENTS_DIR, abs_path, code_version, rel_path
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
    """`?members=1,2` limits every figure to those family members' accounts (absent = everyone)."""
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
    pattern = re.sub(r"\s+", " ", pattern.upper()).strip()
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
        owners = {s["id"]: members.member_for_path(conn, abs_path(s["path"])) for s in out} if wanted else {}
    if wanted:
        out = [s for s in out if owners[s["id"]] in wanted]
    for s in out:
        s["file_exists"] = (abs_path(s["path"])).exists()
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
        result = scanner.parse_statement_file(conn, statement_id, abs_path(s["path"]), password=body.password)
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
        result = scanner.parse_statement_file(conn, statement_id, abs_path(s["path"]))
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
        saved.append(rel_path(dest))
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
                z.write(p, rel_path(p))
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
