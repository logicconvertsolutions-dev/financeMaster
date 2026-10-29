import { Fragment, useState } from "react";
import { api } from "../api";
import { Card, Loading, PageHead } from "../components/ui";
import { useApi, useApp } from "../context";
import { dayLabel, money, moneyCents, parseAmount, today } from "../format";

const ROOM_TAGS = [
  {
    value: "TFSA",
    label: "TFSA",
  },
  {
    value: "FHSA",
    label: "FHSA",
  },
  {
    value: "RRSP",
    label: "RRSP",
  },
  {
    value: "NONE",
    label: "Not a contribution",
  },
];

function RoomCandidates({ year, onChange }) {
  const { toast } = useApp();
  const r = useApi(`/room/candidates?year=${year}`);
  const a = useApi(`/room/tags?year=${year}`);
  async function i(l, c) {
    await api.put("/room/tag", {
      account_id: l.account_id,
      date: l.date,
      amount: l.raw_amount,
      description: l.description,
      registration: c,
    });
    toast(c === "" ? "Undone" : c === "NONE" ? "Marked as not a contribution" : `Counted toward ${c}`);
    r.reload();
    a.reload();
    onChange();
  }
  const o = r.data ?? [];
  const u = a.data ?? [];
  if (!o.length && !u.length) {
    return null;
  } else {
    return (
      <div
        style={{
          marginTop: 14,
          borderTop: "1px solid var(--border)",
          paddingTop: 12,
        }}
      >
        {o.length > 0 && (
          <>
            <h3
              style={{
                marginBottom: 2,
              }}
            >
              Possible contributions in {year} ({o.length})
            </h3>
            <p
              className="small muted"
              style={{
                marginTop: 0,
              }}
            >
              Money you sent to investment companies. The statement doesn't say which account it went into, so pick one
              and it counts toward that room. Your answer is remembered, even if the statement is imported again.
            </p>
            <table>
              <tbody>
                {o.map((l) => (
                  <tr key={`${l.account_id}-${l.date}-${l.raw_amount}-${l.description}`}>
                    <td
                      className="muted small"
                      style={{
                        whiteSpace: "nowrap",
                      }}
                    >
                      {dayLabel(l.date)}
                    </td>
                    <td className="small">
                      {l.description}
                      <div className="muted">
                        {l.account}
                        {l.member ? ` · ${l.member}` : ""}
                      </div>
                    </td>
                    <td className="num">{moneyCents(l.amount)}</td>
                    <td
                      style={{
                        whiteSpace: "nowrap",
                      }}
                    >
                      {l.suggested && (
                        <button className="btn small primary" onClick={() => i(l, l.suggested)}>
                          {l.suggested}
                        </button>
                      )}{" "}
                      <select
                        value=""
                        onChange={(c) => c.target.value && i(l, c.target.value)}
                        aria-label="Which account"
                      >
                        <option value="">{l.suggested ? "Other…" : "Which account?"}</option>
                        {ROOM_TAGS.map((c) => (
                          <option value={c.value} key={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {u.length > 0 && (
          <details
            style={{
              marginTop: 10,
            }}
          >
            <summary
              className="small muted"
              style={{
                cursor: "pointer",
              }}
            >
              Transfers you've marked ({u.length})
            </summary>
            <table>
              <tbody>
                {u.map((l) => (
                  <tr key={`${l.account_id}-${l.date}-${l.raw_amount}-${l.description}`}>
                    <td className="muted small">{dayLabel(l.date)}</td>
                    <td className="small">{l.description}</td>
                    <td className="num">{moneyCents(l.amount)}</td>
                    <td className="small">{l.registration === "NONE" ? "Not a contribution" : l.registration}</td>
                    <td>
                      <button className="btn small" onClick={() => i(l, "")}>
                        Undo
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    );
  }
}

function FamilyMembers() {
  const { bump, toast, viewing } = useApp();
  const r = viewing.members;
  const a = r.find((f) => f.is_primary);
  const [i, o] = useState("");
  const [u, l] = useState("");
  async function c(f) {
    f.preventDefault();
    try {
      await api.post("/members", {
        name: i,
      });
      toast(`Added ${i}. Put their statements in statements\\${i}\\`);
      o("");
      bump();
    } catch (p) {
      toast(p.message);
    }
  }
  async function d(f) {
    f.preventDefault();
    if (confirm(`Move all your statements into statements\\${u}\\ ? Nothing is re-imported; only the files move.`)) {
      try {
        const p = await api.post("/members/primary/move-files", {
          name: u,
        });
        toast(`${p.files_moved} file(s) moved to ${p.folder}`);
        bump();
      } catch (p) {
        toast(p.message);
      }
    }
  }
  return (
    <Card
      title="Family members"
      extra={
        <span className="small muted">
          Each person is a folder in <code>statements\</code>; everything in it is theirs. Pick who to view at the top
          of the sidebar.
        </span>
      }
    >
      <table>
        <thead>
          <tr>
            <th>Person</th>
            <th>Statements folder</th>
            <th className="num">Accounts</th>
            <th className="num">Transactions</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {r.map((f) => (
            <MemberRow m={f} key={f.id} />
          ))}
        </tbody>
      </table>
      {a && !a.folder && (
        <form
          onSubmit={d}
          className="editor"
          style={{
            marginTop: 12,
          }}
        >
          <div
            style={{
              flex: "1 1 100%",
            }}
            className="small"
          >
            <strong>Your statements are loose in the top-level folder.</strong> Give yourself a folder so each person's
            files sit side by side (<code>statements\YourName\2026-09\…</code>). This moves your existing files; nothing
            is imported twice.
          </div>
          <input
            required={true}
            placeholder="Your name, e.g. Alex"
            value={u}
            onChange={(f) => l(f.target.value)}
            aria-label="Your name"
          />
          <button className="btn primary small" disabled={!u.trim()}>
            Move my files into my folder
          </button>
        </form>
      )}
      <form
        onSubmit={c}
        className="row"
        style={{
          marginTop: 12,
        }}
      >
        <input
          placeholder="Add a person, e.g. your wife's name"
          value={i}
          onChange={(f) => o(f.target.value)}
          aria-label="New family member"
        />
        <button className="btn" disabled={!i.trim()}>
          Add person
        </button>
        <span className="small muted">
          Creates <code>statements\{i.trim() || "Name"}\</code>. A new folder you create yourself is picked up
          automatically too.
        </span>
      </form>
    </Card>
  );
}

function MemberRow({ m }) {
  const { bump, toast } = useApp();
  const [r, a] = useState(m.name);
  return (
    <tr>
      <td>
        <div
          className="row"
          style={{
            gap: 6,
            flexWrap: "nowrap",
          }}
        >
          <input
            type="color"
            value={m.color ?? "#4f7d3a"}
            aria-label={`${m.name} colour`}
            style={{
              width: 28,
              height: 26,
              padding: 0,
              border: 0,
              background: "none",
            }}
            onChange={async (i) => {
              await api.patch(`/members/${m.id}`, {
                color: i.target.value,
              });
              bump();
            }}
          />
          <input
            value={r}
            onChange={(i) => a(i.target.value)}
            aria-label="Name"
            style={{
              width: 150,
            }}
            onBlur={async () => {
              if (r.trim() && r !== m.name) {
                try {
                  await api.patch(`/members/${m.id}`, {
                    name: r,
                  });
                  bump();
                } catch (i) {
                  toast(i.message);
                  a(m.name);
                }
              }
            }}
          />
          {m.is_primary ? <span className="badge">you</span> : null}
        </div>
      </td>
      <td className="small">
        <code>{m.folder_path}</code>
      </td>
      <td className="num">{m.accounts}</td>
      <td className="num">{m.transactions.toLocaleString()}</td>
      <td>
        {!m.is_primary && m.accounts === 0 && (
          <button
            className="btn small danger"
            onClick={async () => {
              try {
                await api.del(`/members/${m.id}`);
                bump();
              } catch (i) {
                toast(i.message);
              }
            }}
          >
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

export function AccountsPage() {
  return (
    <>
      <PageHead
        title="Accounts & assets"
        sub="Fix account details, add things statements don't cover, and set your contribution room."
      />
      <div className="stack">
        <FamilyMembers />
        <AccountsTable />
        <ManualItems />
        <ContributionRoom />
      </div>
    </>
  );
}

function AccountsTable() {
  const { bump, toast, viewing } = useApp();
  const { data, reload } = useApi("/accounts");
  const [i, o] = useState(false);
  const [u, l] = useState(null);
  const [c, d] = useState(null);
  const [f, p] = useState({
    institution: "",
    name: "",
    type: "chequing",
    registration: "",
  });
  if (!data) {
    return <Loading />;
  }
  async function h(v, m) {
    await api.patch(`/accounts/${v}`, m);
    reload();
    bump();
  }
  async function y() {
    const v = await api.post("/accounts", {
      ...f,
      registration: f.registration || null,
      member_id: viewing.single?.id ?? null,
    });
    o(false);
    p({
      institution: "",
      name: "",
      type: "chequing",
      registration: "",
    });
    reload();
    toast("Account added. Set its balance with 'Update balance'.");
    return v;
  }
  const b = (v) => (v.trim() === "" ? null : Number(v));
  return (
    <section className="card flush">
      <div
        style={{
          padding: "14px 18px 4px",
        }}
        className="card-head"
      >
        <h2>Accounts</h2>
        <button className="btn small" onClick={() => o(!i)}>
          + Add account
        </button>
      </div>
      {i && (
        <div
          className="row"
          style={{
            padding: "4px 18px 12px",
            alignItems: "flex-end",
          }}
        >
          <label className="field">
            Bank
            <input
              value={f.institution}
              onChange={(v) =>
                p({
                  ...f,
                  institution: v.target.value,
                })
              }
            />
          </label>
          <label className="field">
            Name
            <input
              value={f.name}
              onChange={(v) =>
                p({
                  ...f,
                  name: v.target.value,
                })
              }
              placeholder="e.g. Mortgage"
            />
          </label>
          <label className="field">
            Type
            <select
              value={f.type}
              onChange={(v) =>
                p({
                  ...f,
                  type: v.target.value,
                })
              }
            >
              {["chequing", "savings", "credit", "investment", "loan"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Registered
            <select
              value={f.registration}
              onChange={(v) =>
                p({
                  ...f,
                  registration: v.target.value,
                })
              }
            >
              <option value="">–</option>
              {["TFSA", "RRSP", "FHSA", "NONREG"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <button className="btn primary" disabled={!f.institution || !f.name} onClick={y}>
            Add
          </button>
        </div>
      )}
      {data.length === 0 ? (
        <p
          className="muted"
          style={{
            padding: "0 18px 14px",
          }}
        >
          Accounts are created automatically from statements, or add one here.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                {viewing.members.length > 1 && <th>Owner</th>}
                <th>Type</th>
                <th>Registered</th>
                <th className="num">Balance</th>
                <th className="num">Credit limit</th>
                <th className="num">Rate %</th>
                <th className="num">Payment/mo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((v) => (
                <Fragment key={v.id}>
                  <tr
                    style={{
                      opacity: v.archived ? 0.5 : 1,
                    }}
                  >
                    <td>
                      <input
                        defaultValue={v.name}
                        onBlur={(m) =>
                          m.target.value !== v.name &&
                          h(v.id, {
                            name: m.target.value,
                          })
                        }
                        aria-label="Account name"
                        style={{
                          width: 220,
                        }}
                      />
                    </td>
                    {viewing.members.length > 1 && (
                      <td>
                        <select
                          value={v.member_id ?? ""}
                          aria-label="Owner"
                          onChange={(m) =>
                            h(v.id, {
                              member_id: Number(m.target.value),
                            })
                          }
                        >
                          {viewing.members.map((m) => (
                            <option value={m.id} key={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </td>
                    )}
                    <td>
                      <select
                        defaultValue={v.type}
                        onChange={(m) =>
                          h(v.id, {
                            type: m.target.value,
                          })
                        }
                        aria-label="Type"
                      >
                        {["chequing", "savings", "credit", "investment", "loan"].map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        defaultValue={v.registration ?? ""}
                        onChange={(m) =>
                          h(v.id, {
                            registration: m.target.value || null,
                          })
                        }
                        aria-label="Registration"
                      >
                        <option value="">–</option>
                        {["TFSA", "RRSP", "FHSA", "NONREG"].map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                    </td>
                    <td className="num">
                      {money(v.balance)}
                      <div className="small muted">{v.balance_as_of ?? ""}</div>
                      <div className="small muted">
                        {v.transactions} txns
                        {findDuplicate(v, data) && (
                          <span
                            className="badge"
                            style={{
                              marginLeft: 4,
                            }}
                            title={`Same bank and type as ${findDuplicate(v, data).name}`}
                          >
                            possible duplicate
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="num">
                      {v.type === "credit" ? (
                        <input
                          type="number"
                          defaultValue={v.credit_limit ?? ""}
                          style={{
                            width: 90,
                          }}
                          onBlur={(m) =>
                            h(v.id, {
                              credit_limit: b(m.target.value),
                            })
                          }
                          aria-label="Credit limit"
                        />
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className="num">
                      {v.type === "credit" || v.type === "loan" ? (
                        <input
                          type="number"
                          step="0.01"
                          defaultValue={v.interest_rate ?? ""}
                          style={{
                            width: 70,
                          }}
                          onBlur={(m) =>
                            h(v.id, {
                              interest_rate: b(m.target.value),
                            })
                          }
                          aria-label="Interest rate"
                        />
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className="num">
                      {v.type === "loan" ? (
                        <input
                          type="number"
                          defaultValue={v.payment ?? ""}
                          style={{
                            width: 90,
                          }}
                          onBlur={(m) =>
                            h(v.id, {
                              payment: b(m.target.value),
                            })
                          }
                          aria-label="Monthly payment"
                        />
                      ) : (
                        "–"
                      )}
                    </td>
                    <td
                      style={{
                        whiteSpace: "nowrap",
                      }}
                    >
                      <button className="btn small" onClick={() => d(c === v.id ? null : v.id)}>
                        Update balance
                      </button>{" "}
                      <button
                        className="btn small"
                        onClick={() =>
                          h(v.id, {
                            archived: v.archived ? 0 : 1,
                          })
                        }
                      >
                        {v.archived ? "Restore" : "Hide"}
                      </button>{" "}
                      <button className="btn small" onClick={() => l(u === v.id ? null : v.id)}>
                        Remove / merge…
                      </button>
                    </td>
                  </tr>
                  {c === v.id && (
                    <tr>
                      <td
                        colSpan={viewing.members.length > 1 ? 9 : 8}
                        style={{
                          background: "var(--surface-2)",
                        }}
                      >
                        <BalanceForm
                          a={v}
                          onDone={(m) => {
                            d(null);
                            if (m) {
                              toast(m);
                            }
                            reload();
                            bump();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                  {u === v.id && (
                    <tr>
                      <td
                        colSpan={viewing.members.length > 1 ? 9 : 8}
                        style={{
                          background: "var(--surface-2)",
                        }}
                      >
                        <RemoveOrMerge
                          a={v}
                          all={data}
                          onDone={() => {
                            l(null);
                            reload();
                            bump();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BalanceForm({ a: e, onDone }) {
  const n = e.type === "credit" || e.type === "loan";
  const [r, a] = useState(e.balance != null ? String(e.balance) : "");
  const [i, o] = useState("");
  const [u, l] = useState(today());
  const [c, d] = useState(null);
  async function f(p) {
    p.preventDefault();
    const h = parseAmount(r);
    const y = i.trim() ? parseAmount(i) : null;
    if (isNaN(h)) {
      return d("Enter the balance as a number, e.g. 12,345.67");
    }
    if (y !== null && isNaN(y)) {
      return d("Book value must be a number, or leave it empty");
    }
    try {
      await api.post(`/accounts/${e.id}/balance`, {
        date: u > today() ? today() : u,
        balance: h,
        book_value: y,
      });
      onDone(`${e.name}: balance ${money(h)} as of ${u}`);
    } catch (b) {
      d(b.message);
    }
  }
  return (
    <form
      onSubmit={f}
      className="row"
      style={{
        alignItems: "flex-end",
        padding: "4px 0",
      }}
    >
      <label className="field">
        {n ? "Amount owed" : e.type === "investment" ? "Market value" : "Balance"}
        <input
          autoFocus={true}
          value={r}
          onChange={(p) => {
            a(p.target.value);
            d(null);
          }}
          placeholder="e.g. 12,345.67"
          style={{
            width: 140,
          }}
        />
      </label>
      {e.type === "investment" && (
        <label className="field" title="What you've put in (cost). Needed for gain/loss.">
          Book value (optional)
          <input
            value={i}
            onChange={(p) => {
              o(p.target.value);
              d(null);
            }}
            placeholder="e.g. 10,000"
            style={{
              width: 140,
            }}
          />
        </label>
      )}
      <label className="field">
        As of
        <input type="date" value={u} max={today()} onChange={(p) => l(p.target.value)} />
      </label>
      <button className="btn primary small">Save balance</button>
      <button type="button" className="btn small" onClick={() => onDone()}>
        Cancel
      </button>
      {c && <span className="small up-bad">{c}</span>}
      <span
        className="small muted"
        style={{
          flexBasis: "100%",
        }}
      >
        The newest balance (from a statement or entered here) is the one every page uses.
      </span>
    </form>
  );
}

function findDuplicate(e, t) {
  return t.find(
    (n) =>
      n.id !== e.id &&
      n.member_id === e.member_id &&
      n.institution.toLowerCase() === e.institution.toLowerCase() &&
      n.type === e.type &&
      (n.registration ?? "") === (e.registration ?? "") &&
      (!e.last4 || !n.last4 || e.last4 === n.last4),
  );
}

function RemoveOrMerge({ a: e, all, onDone }) {
  const { toast } = useApp();
  const a = findDuplicate(e, all);
  const [i, o] = useState(a ? String(a.id) : "");
  const [u, l] = useState(false);
  const c = all.filter((d) => d.id !== e.id);
  return (
    <div
      className="grid g2"
      style={{
        padding: "6px 0",
      }}
    >
      <div>
        <h3>Merge into another account</h3>
        <p
          className="small muted"
          style={{
            marginTop: 0,
          }}
        >
          {`For duplicates: moves all of this account's transactions, balances and statements into the one you pick, drops transactions that account already has, then removes "`}
          {e.name}".
        </p>
        <div className="row">
          <select value={i} onChange={(d) => o(d.target.value)} aria-label="Merge into">
            <option value="" disabled={true}>
              Choose account…
            </option>
            {c.map((d) => (
              <option value={d.id} key={d.id}>
                {d.name} ({d.type}, {d.transactions} txns)
              </option>
            ))}
          </select>
          <button
            className="btn primary small"
            disabled={!i}
            onClick={async () => {
              const d = c.find((p) => String(p.id) === i);
              if (!confirm(`Merge "${e.name}" into "${d.name}"?`)) {
                return;
              }
              const f = await api.post(`/accounts/${e.id}/merge`, {
                into: Number(i),
              });
              toast(`Merged: ${f.moved} transactions moved, ${f.duplicates_removed} duplicates dropped`);
              onDone();
            }}
          >
            Merge
          </button>
        </div>
      </div>
      <div>
        <h3>Delete this account</h3>
        <p
          className="small muted"
          style={{
            marginTop: 0,
          }}
        >
          Removes the account and its {e.transactions} transactions from the dashboard. Its statement files won't be
          imported again.
        </p>
        <label
          className="row small"
          style={{
            gap: 6,
            marginBottom: 8,
          }}
        >
          <input type="checkbox" checked={u} onChange={(d) => l(d.target.checked)} />
          Also move its statement files to statements\_deleted\ (files shared with other accounts are kept)
        </label>
        <button
          className="btn danger small"
          onClick={async () => {
            if (!confirm(`Delete "${e.name}" and its ${e.transactions} transactions?`)) {
              return;
            }
            const d = await api.del(`/accounts/${e.id}?delete_files=${u}`);
            toast(`Deleted ${e.name}: ${d.transactions} transactions${u ? `, ${d.files_moved} file(s) moved` : ""}`);
            onDone();
          }}
        >
          Delete account
        </button>
      </div>
    </div>
  );
}

function ManualItems() {
  const { bump } = useApp();
  const { data, reload } = useApi("/manual");
  const { viewing } = useApp();
  const [a, i] = useState({
    name: "",
    kind: "asset",
    value: "",
    as_of: today(),
    note: "",
    owner: "",
  });
  const o = viewing.members.length > 1;
  async function u(c) {
    c.preventDefault();
    const d = a.owner || (viewing.single ? String(viewing.single.id) : "");
    await api.post("/manual", {
      ...a,
      value: Number(a.value),
      member_id: d ? Number(d) : null,
    });
    i({
      ...a,
      name: "",
      value: "",
      note: "",
    });
    reload();
    bump();
  }
  const l = new Map();
  (data ?? []).forEach((c) => {
    if (!l.has(c.name) || l.get(c.name).as_of < c.as_of) {
      l.set(c.name, c);
    }
  });
  return (
    <Card
      title="Other assets & debts"
      extra={
        <span className="small muted">
          Home, car, cash, a loan from family… Add a new row with a new date to update a value; history is kept for the
          net worth chart.
        </span>
      }
    >
      <form
        onSubmit={u}
        className="row"
        style={{
          alignItems: "flex-end",
          marginBottom: 12,
        }}
      >
        <label className="field">
          Name
          <input
            required={true}
            value={a.name}
            onChange={(c) =>
              i({
                ...a,
                name: c.target.value,
              })
            }
            placeholder="e.g. Home"
            list="manual-names"
          />
        </label>
        <datalist id="manual-names">
          {[...l.keys()].map((c) => (
            <option value={c} key={c} />
          ))}
        </datalist>
        <label className="field">
          Kind
          <select
            value={a.kind}
            onChange={(c) =>
              i({
                ...a,
                kind: c.target.value,
              })
            }
          >
            <option value="asset">Asset (I own)</option>
            <option value="liability">Debt (I owe)</option>
          </select>
        </label>
        <label className="field">
          Value
          <input
            required={true}
            type="number"
            step="0.01"
            value={a.value}
            onChange={(c) =>
              i({
                ...a,
                value: c.target.value,
              })
            }
            style={{
              width: 130,
            }}
          />
        </label>
        <label className="field">
          As of
          <input
            type="date"
            value={a.as_of}
            onChange={(c) =>
              i({
                ...a,
                as_of: c.target.value,
              })
            }
          />
        </label>
        <label className="field">
          Note
          <input
            value={a.note}
            onChange={(c) =>
              i({
                ...a,
                note: c.target.value,
              })
            }
          />
        </label>
        {o && (
          <label className="field">
            Owner
            <select
              value={a.owner || (viewing.single ? String(viewing.single.id) : "")}
              onChange={(c) =>
                i({
                  ...a,
                  owner: c.target.value,
                })
              }
            >
              {viewing.members.map((c) => (
                <option value={c.is_primary ? "" : c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="btn primary">Save</button>
      </form>
      {data && data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              {o && <th>Owner</th>}
              <th>Kind</th>
              <th>As of</th>
              <th className="num">Value</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((c) => {
              return (
                <tr
                  style={{
                    opacity: l.get(c.name)?.id === c.id ? 1 : 0.55,
                  }}
                  key={c.id}
                >
                  <td>{c.name}</td>
                  {o && <td className="small">{c.owner}</td>}
                  <td className="muted">{c.kind === "asset" ? "Asset" : "Debt"}</td>
                  <td className="muted">{c.as_of}</td>
                  <td className="num">{money(c.value)}</td>
                  <td className="muted small">{c.note}</td>
                  <td>
                    <button
                      className="btn small danger"
                      onClick={async () => {
                        await api.del(`/manual/${c.id}`);
                        reload();
                        bump();
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ContributionRoom() {
  const { bump, toast, viewing } = useApp();
  const r = new Date().getFullYear();
  const { data, reload } = useApi(`/room?year=${r}`);
  const o = viewing.members.filter((c) => !viewing.ids || viewing.ids.includes(c.id));
  const u = (c, d) => (data ?? []).find((f) => f.member_id === c && f.registration === d);
  async function l(c, d, f, p) {
    try {
      await api.put("/room", {
        year: r,
        registration: f,
        member_id: c,
        basis: p.basis,
        room: p.basis === "cra" ? parseAmount(p.room) : null,
        since_year: p.basis === "estimate" ? Number(p.since) : null,
        contributed: p.contributed.trim() === "" ? null : parseAmount(p.contributed),
      });
      toast(`${o.length > 1 ? `${d}'s ` : ""}${f} room saved`);
      reload();
      bump();
    } catch (h) {
      toast(h.message);
    }
  }
  return (
    <Card title={`Contribution room · ${r}`} extra={<span className="small muted">Room is per person.</span>}>
      <table>
        <thead>
          <tr>
            {o.length > 1 && <th>Person</th>}
            <th>Account</th>
            <th>Based on</th>
            <th className="num">Room</th>
            <th className="num">Put in</th>
            <th className="num">Available</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {o.flatMap((c) =>
            ["TFSA", "RRSP", "FHSA"].map((d) => {
              const f = u(c.id, d);
              return (
                <RoomRow
                  reg={d}
                  person={o.length > 1 ? c.name : null}
                  r={f}
                  onSave={(p) => l(c.id, c.name, d, p)}
                  key={`${c.id}-${d}-${f?.basis}-${f?.room}-${f?.since_year}`}
                />
              );
            }),
          )}
        </tbody>
      </table>
      <RoomCandidates
        year={r}
        onChange={() => {
          reload();
          bump();
        }}
      />
      <div
        className="small muted"
        style={{
          marginTop: 8,
        }}
      >
        <p
          style={{
            margin: "4px 0",
          }}
        >
          <b>CRA figure</b>
          {`: the room CRA My Account shows as available on January 1 (most accurate). "Put in" is this year's contributions: deposits on the account's statements, transfers from chequing that name it, and transfers you mark above. Money already in your accounts before this year is already reflected in CRA's figure.`}
        </p>
        <p
          style={{
            margin: "4px 0",
          }}
        >
          <b>Estimate from my accounts</b> (TFSA, FHSA): adds up the official yearly limits since the year you became
          eligible (TFSA: turned 18 and a resident, 2009 at the earliest) or opened the account (FHSA: $8,000 a year, up
          to $8,000 carried forward, $40,000 lifetime), minus what you've put in, i.e. the book value of all your
          accounts of that kind. RRSP room depends on your income, so it always uses the CRA figure.
        </p>
      </div>
    </Card>
  );
}

function RoomRow({ reg, r: t, person, onSave }) {
  const a = reg !== "RRSP";
  const [i, o] = useState({
    basis: t?.basis ?? "cra",
    room: t && t.basis === "cra" ? String(t.room) : "",
    since: t != null && t.since_year ? String(t.since_year) : "",
    contributed: t && !t.detected ? String(t.contributed) : "",
  });
  const u = (c) =>
    o({
      ...i,
      ...c,
    });
  const l = i.basis === "estimate";
  return (
    <>
      <tr>
        {person !== null && (
          <td
            style={{
              fontWeight: reg === "TFSA" ? 600 : 400,
            }}
          >
            {reg === "TFSA" ? person : ""}
          </td>
        )}
        <td>{reg}</td>
        <td>
          <select
            value={i.basis}
            onChange={(c) =>
              u({
                basis: c.target.value,
              })
            }
            aria-label={`${reg} room basis`}
            disabled={!a}
          >
            <option value="cra">CRA figure (Jan 1)</option>
            {a && <option value="estimate">Estimate from my accounts</option>}
          </select>
          {l && (
            <label
              className="small"
              style={{
                display: "block",
                marginTop: 4,
              }}
            >
              {reg === "TFSA" ? "Eligible since " : "Opened in "}
              <input
                type="number"
                min={reg === "TFSA" ? 2009 : 2023}
                max={new Date().getFullYear()}
                value={i.since}
                onChange={(c) =>
                  u({
                    since: c.target.value,
                  })
                }
                style={{
                  width: 80,
                }}
                aria-label={`${reg} since year`}
              />
            </label>
          )}
        </td>
        <td className="num">
          {l ? (
            <span title="Sum of the yearly limits">{t?.basis === "estimate" ? money(t.room) : "–"}</span>
          ) : (
            <input
              value={i.room}
              onChange={(c) =>
                u({
                  room: c.target.value,
                })
              }
              placeholder="from CRA"
              style={{
                width: 110,
              }}
              aria-label={`${reg} room`}
            />
          )}
        </td>
        <td className="num">
          <input
            value={i.contributed}
            placeholder={t != null && t.detected ? `${money(t.contributed)} ${l ? "(book value)" : "(found)"}` : "auto"}
            onChange={(c) =>
              u({
                contributed: c.target.value,
              })
            }
            style={{
              width: 150,
            }}
            aria-label={`${reg} put in`}
          />
        </td>
        <td
          className={`num ${t && t.remaining < 0 ? "up-bad" : ""}`}
          style={{
            fontWeight: 600,
          }}
        >
          {t ? money(t.remaining) : "–"}
          {t?.basis === "estimate" && (
            <div
              className="small muted"
              style={{
                fontWeight: 400,
              }}
            >
              estimate
            </div>
          )}
        </td>
        <td>
          <button className="btn small" disabled={l ? !i.since : !i.room.trim()} onClick={() => onSave(i)}>
            Save
          </button>
        </td>
      </tr>
      {t && t.notes && t.notes.length > 0 && (
        <tr>
          <td
            colSpan={person !== null ? 7 : 6}
            className="small muted"
            style={{
              paddingTop: 0,
            }}
          >
            {t.notes.join(" · ")}
          </td>
        </tr>
      )}
    </>
  );
}
