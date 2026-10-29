import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Card, Loading, PageHead } from "../components/ui";
import { useApi, useApp } from "../context";
import { moneyCents, monthLabel } from "../format";

const COVERAGE_CELLS = {
  full: {
    text: "✓",
    title: "Whole month covered",
    cls: "cov-full",
  },
  partial: {
    text: "◐",
    title: "Part of the month: the next statement will complete it",
    cls: "cov-partial",
  },
  none: {
    text: "✕",
    title: "No statement for this month yet",
    cls: "cov-none",
  },
  "n/a": {
    text: "",
    title: "Before this account's first statement, or it stopped",
    cls: "",
  },
};

function StatementCoverage() {
  const { data } = useApi("/coverage?months=12");
  if (!data || !data.accounts.length) {
    return null;
  }
  const t = data.months;
  const n = new Set(data.accounts.map((a) => a.member));
  const r = data.accounts.flatMap((a) =>
    t
      .slice(0, -1)
      .filter((i) => a.cells[i] === "none")
      .map((i) => `${a.name} ${monthLabel(i)}`),
  );
  return (
    <section
      className="card flush"
      style={{
        marginTop: 16,
      }}
    >
      <div
        style={{
          padding: "14px 18px 4px",
        }}
        className="card-head"
      >
        <h2>Statement coverage</h2>
        <span className="small muted">✓ whole month · ◐ part · ✕ missing</span>
      </div>
      {r.length > 0 && (
        <p
          className="small"
          style={{
            padding: "0 18px",
            margin: "0 0 6px",
          }}
        >
          <span className="badge warn">Missing</span> {r.slice(0, 6).join(", ")}
          {r.length > 6 ? ` and ${r.length - 6} more` : ""}. Without them those months' spending and income are too low.
        </p>
      )}
      <div
        style={{
          overflowX: "auto",
        }}
      >
        <table className="coverage">
          <thead>
            <tr>
              <th>Account</th>
              {t.map((a) => {
                var i;
                return (
                  <th
                    className="num"
                    title={
                      (i = data.status[a]) != null && i.complete
                        ? "Complete"
                        : `Waiting for: ${data.status[a]?.missing.join(", ")}`
                    }
                    key={a}
                  >
                    {monthLabel(a)}
                    {data.status[a] && !data.status[a].complete ? "*" : ""}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((a) => (
              <tr key={a.id}>
                <td
                  style={{
                    whiteSpace: "nowrap",
                  }}
                >
                  {a.name}
                  {n.size > 1 && a.member ? <span className="muted small"> · {a.member}</span> : null}
                </td>
                {t.map((i) => {
                  const o = COVERAGE_CELLS[a.cells[i]];
                  return (
                    <td className={`num ${o.cls}`} title={o.title} key={i}>
                      {o.text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p
        className="small muted"
        style={{
          padding: "4px 18px 12px",
          margin: 0,
        }}
      >
        * Month not complete yet. Pages open on the latest complete month so a half-imported month doesn't look like a
        drop in income.
      </p>
    </section>
  );
}

const STATUS = {
  parsed: {
    label: "Imported",
    color: "var(--good)",
  },
  needs_review: {
    label: "Needs review",
    color: "var(--warning)",
  },
  locked: {
    label: "Password needed",
    color: "var(--serious)",
  },
  failed: {
    label: "Couldn't read",
    color: "var(--critical)",
  },
  ignored: {
    label: "Ignored",
    color: "var(--other)",
  },
};

export function StatementsPage() {
  const { bump, toast, viewing } = useApp();
  const { data, error, reload } = useApi("/statements");
  const [o, u] = useState("");
  const l =
    viewing.members.find((x) => String(x.id) === o) ?? viewing.single ?? viewing.members.find((x) => x.is_primary);
  const c = ["statements", l?.folder].filter(Boolean).join("\\") + "\\";
  const [d, f] = useState(null);
  const [p, h] = useState(new Set());
  const [y, b] = useState(false);
  const v = useRef(null);
  async function m(x) {
    if (x != null && x.length) {
      try {
        const j = await api.upload(l ? `/upload?member_id=${l.id}` : "/upload", x);
        toast(
          `${j.saved.length} file(s) saved · ${j.parsed} imported, ${j.needs_review} need review, ${j.locked} locked, ${j.failed} unreadable`,
        );
        reload();
        bump();
      } catch (j) {
        toast(`Upload failed: ${j.message}`);
      }
    }
  }
  async function g() {
    const x = await api.post("/scan");
    toast(x.new ? `${x.new} new file(s) found` : "No new files in the statements folder");
    reload();
    bump();
  }
  if (!data) {
    return <Loading error={error} />;
  }
  const w = data.filter((x) => ["needs_review", "locked", "failed"].includes(x.status));
  const S = data.filter((x) => !["needs_review", "locked", "failed"].includes(x.status));
  return (
    <>
      <PageHead
        title="Statements"
        sub="Every PDF, CSV or Excel file in the statements folder. Transactions already imported from another file are skipped automatically. New files are picked up whenever you open the dashboard."
      >
        {viewing.members.length > 1 && (
          <label
            className="row small"
            style={{
              gap: 6,
            }}
          >
            Upload for
            <select value={o || String(l?.id ?? "")} onChange={(x) => u(x.target.value)} aria-label="Upload for">
              {viewing.members.map((x) => (
                <option value={x.id} key={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="btn" onClick={g}>
          Rescan folder
        </button>
      </PageHead>
      <div
        className={`drop ${y ? "over" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => {
          var x;
          if ((x = v.current) == null) {
            return undefined;
          } else {
            return x.click();
          }
        }}
        onKeyDown={(x) => {
          return x.key === "Enter" && v.current?.click();
        }}
        onDragOver={(x) => {
          x.preventDefault();
          x.stopPropagation();
          b(true);
        }}
        onDragLeave={() => b(false)}
        onDrop={(x) => {
          x.preventDefault();
          x.stopPropagation();
          b(false);
          m(x.dataTransfer.files);
        }}
      >
        <strong>Drop statements here</strong> (PDF, CSV or Excel) or click to choose files. They go into{" "}
        <code>{c}</code>, filed under the month each statement covers.
        <input
          ref={v}
          type="file"
          accept=".pdf,.csv,.xlsx,.xls"
          multiple={true}
          hidden={true}
          onChange={(x) => m(x.target.files)}
        />
      </div>
      {w.length > 0 && (
        <Card
          title={`Needs your attention (${w.length})`}
          style={{
            marginTop: 16,
          }}
        >
          <div
            className="stack"
            style={{
              gap: 10,
            }}
          >
            {w.map((x) => (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: 12,
                }}
                key={x.id}
              >
                <AttentionRow
                  s={x}
                  onToggle={() => f(d === x.id ? null : x.id)}
                  isOpen={d === x.id}
                  all={data}
                  onDeleted={() => {
                    reload();
                    bump();
                  }}
                />
                {d === x.id && (
                  <StatementReview
                    id={x.id}
                    onDone={() => {
                      f(null);
                      reload();
                      bump();
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
      <StatementCoverage />
      <section
        className="card flush"
        style={{
          marginTop: 16,
        }}
      >
        <div
          style={{
            padding: "14px 18px 4px",
          }}
          className="card-head"
        >
          <h2>Imported ({S.length})</h2>
          {p.size > 0 && (
            <div className="row">
              <span className="small muted">{p.size} selected</span>
              <button className="btn small" onClick={() => h(new Set())}>
                Clear
              </button>
              <button
                className="btn small danger"
                onClick={async () => {
                  const x = new Set(data.filter((_) => p.has(_.id)).map((_) => _.path));
                  if (
                    !confirm(
                      `Delete ${x.size} file(s)? Their transactions are removed and the files move to statements\\_deleted\\ (move them back to restore).`,
                    )
                  ) {
                    return;
                  }
                  const j = new Set();
                  for (const _ of data.filter((O) => p.has(O.id))) {
                    if (!j.has(_.path)) {
                      j.add(_.path);
                      await api.del(`/statements/${_.id}`);
                    }
                  }
                  toast(`${j.size} file(s) deleted`);
                  h(new Set());
                  reload();
                  bump();
                }}
              >
                Delete selected
              </button>
            </div>
          )}
        </div>
        {S.length === 0 ? (
          <p
            className="muted"
            style={{
              padding: "0 18px 14px",
            }}
          >
            Nothing imported yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th
                    style={{
                      width: 28,
                    }}
                  >
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={p.size > 0 && p.size === S.length}
                      onChange={(x) => h(x.target.checked ? new Set(S.map((j) => j.id)) : new Set())}
                    />
                  </th>
                  <th>File</th>
                  <th>Account</th>
                  <th>Period</th>
                  <th className="num">Rows</th>
                  <th className="num">Closing</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {S.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${x.path}`}
                        checked={p.has(x.id)}
                        onChange={(j) => {
                          const _ = new Set(p);
                          if (j.target.checked) {
                            _.add(x.id);
                          } else {
                            _.delete(x.id);
                          }
                          h(_);
                        }}
                      />
                    </td>
                    <td className="small" title={x.path}>
                      {x.path.split("/").pop()}
                      {!x.file_exists && <span className="muted"> (file moved)</span>}
                      {x.message && (
                        <div
                          className="muted"
                          style={{
                            maxWidth: 320,
                          }}
                        >
                          {x.duplicates ? "⧉ " : ""}
                          {x.message}
                        </div>
                      )}
                    </td>
                    <td>{x.account ?? "–"}</td>
                    <td className="muted small">
                      {x.period_start} → {x.period_end}
                    </td>
                    <td className="num">{x.n_tx}</td>
                    <td className="num">{moneyCents(x.market_value ?? x.closing_balance)}</td>
                    <td>
                      <StatusBadge status={x.status} />
                    </td>
                    <td>
                      <StatementActions
                        s={x}
                        all={data}
                        onChange={() => {
                          reload();
                          bump();
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function StatusBadge({ status }) {
  const t = STATUS[status] ?? {
    label: status,
    color: "var(--other)",
  };
  return (
    <span className="badge">
      <i
        className="status-dot"
        style={{
          background: t.color,
        }}
      />
      {t.label}
    </span>
  );
}

function DeleteStatementButton({ s, all, onDeleted }) {
  const { toast } = useApp();
  const a = all.filter((i) => i.path === s.path);
  return (
    <button
      className="btn small danger"
      title={"Remove this file's transactions and move the file to statements\\\\_deleted\\\\"}
      onClick={async () => {
        const i = s.path.split("/").pop();
        const o =
          a.length > 1
            ? `

This file covers ${a.length} accounts (${a.map((l) => l.account ?? "?").join(", ")}); all of them lose its transactions.`
            : "";
        if (
          !confirm(`Delete ${i}?

Its transactions are removed from the dashboard and the file moves to statements\\_deleted\\ (move it back to restore).${o}`)
        ) {
          return;
        }
        const u = await api.del(`/statements/${s.id}`);
        toast(`Deleted ${i} (${u.transactions_removed} transactions removed)`);
        onDeleted();
      }}
    >
      Delete
    </button>
  );
}

function AttentionRow({ s, onToggle, isOpen, all, onDeleted }) {
  return (
    <div className="row">
      <StatusBadge status={s.status} />
      <div
        style={{
          flex: 1,
          minWidth: 200,
        }}
      >
        <div
          style={{
            fontWeight: 600,
          }}
        >
          {s.path.split("/").pop()}
        </div>
        <div className="small muted">
          {[s.institution, s.detected_type, s.period_start && `${s.period_start} → ${s.period_end}`]
            .filter(Boolean)
            .join(" · ")}
          {s.message && <> · {s.message}</>}
        </div>
      </div>
      <button className="btn small" onClick={onToggle}>
        {isOpen ? "Close" : s.status === "locked" ? "Unlock" : "Review"}
      </button>
      <DeleteStatementButton s={s} all={all} onDeleted={onDeleted} />
    </div>
  );
}

function StatementActions({ s, all, onChange }) {
  const { toast } = useApp();
  return (
    <div
      className="row"
      style={{
        gap: 4,
        flexWrap: "nowrap",
      }}
    >
      <button
        className="btn small"
        title="Parse the file again"
        onClick={async () => {
          const a = await api.post(`/statements/${s.id}/reparse`);
          toast(`Re-parsed: ${STATUS[a.status]?.label ?? a.status}`);
          onChange();
        }}
      >
        Re-parse
      </button>
      {s.status !== "ignored" && (
        <button
          className="btn small danger"
          title="Remove this statement's data (the file stays in the folder)"
          onClick={async () => {
            if (
              confirm(
                "Remove this statement's transactions from the dashboard? The PDF stays in the folder and won't be re-imported.",
              )
            ) {
              await api.post(`/statements/${s.id}/ignore`);
              onChange();
            }
          }}
        >
          Ignore
        </button>
      )}
      <DeleteStatementButton s={s} all={all} onDeleted={onChange} />
    </div>
  );
}

function StatementReview({ id, onDone }) {
  const { data } = useApi(`/statements/${id}`);
  const r = useApi("/accounts").data ?? [];
  if (data) {
    if (data.status === "locked") {
      return <UnlockForm id={id} path={data.path} onDone={onDone} />;
    } else {
      return <StagedReview d={data} accounts={r} onDone={onDone} />;
    }
  } else {
    return <Loading />;
  }
}

function UnlockForm({ id, path, onDone }) {
  const { toast } = useApp();
  const [a, i] = useState("");
  const [o, u] = useState(true);
  const [l, c] = useState(path.split("/").pop()?.split(/[-_ ]/)[0] ?? "bank");
  const [d, f] = useState(false);
  async function p(y) {
    y.preventDefault();
    f(true);
    try {
      const v = await api.post(`/statements/${id}/unlock`, {
        password: a,
        remember: o,
        label: l,
      });
      toast(`Unlocked: ${STATUS[v.status]?.label ?? v.status}`);
      onDone();
    } catch (v) {
      toast(v.message);
    } finally {
      f(false);
      i("");
    }
  }
  return (
    <form
      onSubmit={p}
      className="stack"
      style={{
        gap: 10,
        marginTop: 12,
      }}
    >
      <p
        className="small muted"
        style={{
          margin: 0,
        }}
      >{`The password is used only on this PC to open the file. If you tick "remember", it's stored in Windows Credential Manager (not in the app's database) and tried automatically on future statements.`}</p>
      <div className="row">
        <input
          type="password"
          autoComplete="off"
          placeholder="PDF password"
          value={a}
          onChange={(y) => i(y.target.value)}
          aria-label="PDF password"
        />
        <label
          className="row small"
          style={{
            gap: 4,
          }}
        >
          <input type="checkbox" checked={o} onChange={(y) => u(y.target.checked)} /> Remember as
        </label>
        <input
          value={l}
          onChange={(y) => c(y.target.value)}
          disabled={!o}
          style={{
            width: 120,
          }}
          aria-label="Password label"
        />
        <button className="btn primary" disabled={!a || d}>
          Unlock
        </button>
      </div>
    </form>
  );
}

function StagedReview({ d: e, accounts, onDone }) {
  const { toast } = useApp();
  const a = e.staged;
  const i = a.account_type ?? e.detected_type ?? "chequing";
  const o = (a.institution ?? e.institution ?? "").toLowerCase();
  const u = (T) => T.institution.toLowerCase() === o && T.type === i;
  const l = accounts.find((T) => u(T) && (!a.last4 || T.last4 === a.last4)) ?? accounts.find((T) => u(T) && !T.last4);
  const [c, d] = useState(l ? String(l.id) : e.account_id ? String(e.account_id) : "new");
  const [f, p] = useState({
    institution: e.institution ?? "",
    name: "",
    type: i,
    registration: a.registration ?? "",
    last4: a.last4 ?? "",
  });
  const [h, y] = useState(a.transactions);
  const [b, v] = useState({
    opening: e.opening_balance?.toString() ?? "",
    closing: e.closing_balance?.toString() ?? "",
    market: e.market_value?.toString() ?? "",
    start: e.period_start ?? "",
    end: e.period_end ?? "",
  });
  useEffect(() => {
    if (!f.name) {
      p((T) => ({
        ...T,
        name: `${T.institution || "Bank"} ${T.type}${T.last4 ? ` ••${T.last4}` : ""}`,
      }));
    }
  }, [f.name]);
  const m = c === "new" ? f.type : (accounts.find((T) => String(T.id) === c)?.type ?? f.type);
  const g = m === "credit" || m === "loan";
  const w = h.reduce((T, B) => T + (Number(B.amount) || 0), 0);
  const S = parseFloat(b.opening);
  const x = parseFloat(b.closing);
  const j = g ? S - w : S + w;
  const _ = !isNaN(S) && !isNaN(x) && m !== "investment";
  const O = _ && Math.abs(j - x) < 0.015;
  const P = (T, B) =>
    y((C) =>
      C.map((R, F) =>
        F === T
          ? {
              ...R,
              ...B,
            }
          : R,
      ),
    );
  async function A() {
    try {
      await api.post(`/statements/${e.id}/approve`, {
        account_id: c === "new" ? null : Number(c),
        new_account: c === "new" ? f : null,
        period_start: b.start || null,
        period_end: b.end || null,
        opening_balance: isNaN(S) ? null : S,
        closing_balance: isNaN(x) ? null : x,
        market_value: b.market ? Number(b.market) : null,
        transactions: h,
      });
      toast("Statement imported");
      onDone();
    } catch (T) {
      toast(T.message);
    }
  }
  return (
    <div
      className="stack"
      style={{
        gap: 12,
        marginTop: 12,
      }}
    >
      {a.warnings?.map((T) => (
        <div className="small muted" key={T}>
          ⚠️ {T}
        </div>
      ))}
      <div
        className="row"
        style={{
          alignItems: "flex-end",
        }}
      >
        <label className="field">
          Account
          <select value={c} onChange={(T) => d(T.target.value)}>
            {accounts.map((T) => (
              <option value={T.id} key={T.id}>
                {T.name}
              </option>
            ))}
            <option value="new">+ New account…</option>
          </select>
        </label>
        {c === "new" && (
          <>
            <label className="field">
              Bank
              <input
                value={f.institution}
                onChange={(T) =>
                  p({
                    ...f,
                    institution: T.target.value,
                  })
                }
                style={{
                  width: 110,
                }}
              />
            </label>
            <label className="field">
              Name
              <input
                value={f.name}
                onChange={(T) =>
                  p({
                    ...f,
                    name: T.target.value,
                  })
                }
              />
            </label>
            <label className="field">
              Type
              <select
                value={f.type}
                onChange={(T) =>
                  p({
                    ...f,
                    type: T.target.value,
                  })
                }
              >
                {["chequing", "savings", "credit", "investment", "loan"].map((T) => (
                  <option key={T}>{T}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Registered
              <select
                value={f.registration}
                onChange={(T) =>
                  p({
                    ...f,
                    registration: T.target.value,
                  })
                }
              >
                <option value="">–</option>
                {["TFSA", "RRSP", "FHSA", "NONREG"].map((T) => (
                  <option key={T}>{T}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Last 4
              <input
                value={f.last4}
                onChange={(T) =>
                  p({
                    ...f,
                    last4: T.target.value,
                  })
                }
                style={{
                  width: 70,
                }}
              />
            </label>
          </>
        )}
      </div>
      <div
        className="row"
        style={{
          alignItems: "flex-end",
        }}
      >
        <label className="field">
          Period start
          <input
            type="date"
            value={b.start}
            onChange={(T) =>
              v({
                ...b,
                start: T.target.value,
              })
            }
          />
        </label>
        <label className="field">
          Period end
          <input
            type="date"
            value={b.end}
            onChange={(T) =>
              v({
                ...b,
                end: T.target.value,
              })
            }
          />
        </label>
        {m === "investment" ? (
          <label className="field">
            Total market value
            <input
              type="number"
              step="0.01"
              value={b.market}
              onChange={(T) =>
                v({
                  ...b,
                  market: T.target.value,
                })
              }
            />
          </label>
        ) : (
          <>
            <label className="field">
              {g ? "Previous balance owed" : "Opening balance"}
              <input
                type="number"
                step="0.01"
                value={b.opening}
                onChange={(T) =>
                  v({
                    ...b,
                    opening: T.target.value,
                  })
                }
              />
            </label>
            <label className="field">
              {g ? "New balance owed" : "Closing balance"}
              <input
                type="number"
                step="0.01"
                value={b.closing}
                onChange={(T) =>
                  v({
                    ...b,
                    closing: T.target.value,
                  })
                }
              />
            </label>
          </>
        )}
        {_ && (
          <span
            className={O ? "up-good" : "up-bad"}
            style={{
              paddingBottom: 6,
            }}
          >
            {O ? "✓ Balances reconcile" : `✗ Off by ${moneyCents(x - j)}. Check signs or missing rows`}
          </span>
        )}
      </div>
      <p
        className="small muted"
        style={{
          margin: 0,
        }}
      >
        Amounts: negative = money out (purchases, withdrawals); positive = money in (deposits, payments to a card,
        refunds).
      </p>
      <div
        className="table-wrap"
        style={{
          maxHeight: 380,
          border: "1px solid var(--border)",
          borderRadius: 8,
        }}
      >
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {h.map((T, B) => (
              <tr key={B}>
                <td>
                  <input
                    type="date"
                    value={T.date}
                    onChange={(C) =>
                      P(B, {
                        date: C.target.value,
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    value={T.description}
                    onChange={(C) =>
                      P(B, {
                        description: C.target.value,
                      })
                    }
                    style={{
                      width: "100%",
                    }}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    step="0.01"
                    value={T.amount}
                    onChange={(C) =>
                      P(B, {
                        amount: C.target.value,
                      })
                    }
                    style={{
                      width: 110,
                      textAlign: "right",
                    }}
                  />
                </td>
                <td
                  style={{
                    whiteSpace: "nowrap",
                  }}
                >
                  <button
                    className="btn small"
                    title="Flip sign"
                    onClick={() =>
                      P(B, {
                        amount: -Number(T.amount),
                      })
                    }
                  >
                    ±
                  </button>{" "}
                  <button
                    className="btn small danger"
                    title="Delete row"
                    onClick={() => y(h.filter((C, R) => R !== B))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button
          className="btn small"
          onClick={() =>
            y([
              ...h,
              {
                date: b.end || "",
                description: "",
                amount: 0,
              },
            ])
          }
        >
          + Add row
        </button>
        <span className="small muted">
          {h.length} rows · sum {moneyCents(w)}
        </span>
        <span className="spacer" />
        <button
          className="btn danger"
          onClick={async () => {
            await api.post(`/statements/${e.id}/ignore`);
            onDone();
          }}
        >
          Ignore file
        </button>
        <button className="btn primary" onClick={A} disabled={c === "new" && !f.name}>
          Import statement
        </button>
      </div>
    </div>
  );
}
