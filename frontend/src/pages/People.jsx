import { useEffect, useState } from "react";
import { api } from "../api";
import { Card, Loading, PageHead, Stat } from "../components/ui";
import { useApi, useApp } from "../context";
import { dayLabel, moneyCents, today } from "../format";

function Owed({ v, name }) {
  if (Math.abs(v) < 0.005) {
    return <span className="muted">Settled</span>;
  } else if (v > 0) {
    return (
      <span className="up-good">
        {name ? `${name} owes you` : "Owes you"} {moneyCents(v)}
      </span>
    );
  } else {
    return (
      <span className="up-bad">
        {name ? `You owe ${name}` : "You owe"} {moneyCents(-v)}
      </span>
    );
  }
}

export function PeoplePage() {
  const { bump } = useApp();
  const { data, error, reload } = useApi("/people");
  const [a, i] = useState(null);
  const [o, u] = useState(false);
  const l = () => {
    reload();
    bump();
  };
  useEffect(() => {
    if (data && a === null && data.contacts.length) {
      i(data.contacts[0].id);
    }
  }, [data, a]);
  if (data) {
    return (
      <>
        <PageHead
          title="People & loans"
          sub="Money you've lent to or borrowed from people: e-transfers from your statements plus cash. These are kept out of your income and spending."
        >
          <button className="btn primary" onClick={() => u(true)}>
            + Add person
          </button>
        </PageHead>
        <div className="grid g3">
          <Stat hero={true} label="People owe you" value={data.owed_to_me} format={moneyCents} />
          <Stat label="You owe people" value={data.i_owe} format={moneyCents} />
          <Stat label="Net" value={data.net} format={(c) => `${c >= 0 ? "" : "−"}${moneyCents(Math.abs(c))}`} />
        </div>
        {o && (
          <PersonForm
            onDone={(c) => {
              u(false);
              if (c) {
                i(c);
              }
              l();
            }}
          />
        )}
        <div
          className="grid g3"
          style={{
            marginTop: 16,
            alignItems: "start",
          }}
        >
          <section className="card flush">
            <div
              style={{
                padding: "14px 18px 4px",
              }}
            >
              <h2>People</h2>
            </div>
            {data.contacts.length === 0 ? (
              <p
                className="muted"
                style={{
                  padding: "0 18px 14px",
                }}
              >
                No one yet. Add a person, or pick an e-transfer below and choose "New person".
              </p>
            ) : (
              <table>
                <tbody>
                  {data.contacts.map((c) => (
                    <tr
                      onClick={() => i(c.id)}
                      style={{
                        cursor: "pointer",
                        background: a === c.id ? "var(--accent-wash)" : undefined,
                      }}
                      key={c.id}
                    >
                      <td>
                        <div
                          style={{
                            fontWeight: 600,
                          }}
                        >
                          {c.name}
                        </div>
                        <div className="small muted">
                          {c.entries} entries{c.last_date ? ` · last ${dayLabel(c.last_date)}` : ""}
                        </div>
                      </td>
                      <td className="num small">
                        <Owed v={c.balance} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <div className="span2">
            {a !== null && data.contacts.some((c) => c.id === a) ? (
              <PersonDetail
                id={a}
                onChange={l}
                onDeleted={() => {
                  i(null);
                  l();
                }}
              />
            ) : (
              <Card title="Details">
                <p className="muted">Select a person.</p>
              </Card>
            )}
          </div>
        </div>
        <AssignTransactions contacts={data.contacts} selected={a} onChange={l} onCreated={(c) => i(c)} />
      </>
    );
  } else {
    return <Loading error={error} />;
  }
}

function PersonForm({ c, onDone }) {
  const { toast } = useApp();
  const [r, a] = useState({
    name: c?.name ?? "",
    keywords: c?.keywords ?? "",
    note: c?.note ?? "",
  });
  async function i(o) {
    o.preventDefault();
    try {
      if (c) {
        await api.put(`/people/${c.id}`, r);
        onDone(c.id);
      } else {
        const u = await api.post("/people", r);
        onDone(u.id);
      }
    } catch (u) {
      toast(u.message);
    }
  }
  return (
    <Card
      title={c ? `Edit ${c.name}` : "New person"}
      style={{
        marginTop: 16,
      }}
    >
      <form
        onSubmit={i}
        className="row"
        style={{
          alignItems: "flex-end",
        }}
      >
        <label className="field">
          Name
          <input
            required={true}
            value={r.name}
            onChange={(o) =>
              a({
                ...r,
                name: o.target.value,
              })
            }
          />
        </label>
        <label
          className="field"
          title="Text that appears in their e-transfers, comma separated. Defaults to their first name."
        >
          Find them in descriptions by
          <input
            value={r.keywords}
            onChange={(o) =>
              a({
                ...r,
                keywords: o.target.value,
              })
            }
            placeholder="e.g. JORDAN, J SMITH"
            style={{
              width: 200,
            }}
          />
        </label>
        <label
          className="field"
          style={{
            flex: 1,
          }}
        >
          Note
          <input
            value={r.note}
            onChange={(o) =>
              a({
                ...r,
                note: o.target.value,
              })
            }
            placeholder="e.g. car loan, repay by Dec"
          />
        </label>
        <button className="btn primary">Save</button>
        <button type="button" className="btn" onClick={() => onDone()}>
          Cancel
        </button>
      </form>
    </Card>
  );
}

function PersonDetail({ id, onChange, onDeleted }) {
  const { toast } = useApp();
  const { data, reload } = useApi(`/people/${id}`);
  const [o, u] = useState(false);
  const [l, c] = useState({
    direction: "gave",
    amount: "",
    date: today(),
    note: "",
  });
  if (!data) {
    return <Loading />;
  }
  const d = data.contact;
  const f = () => {
    reload();
    onChange();
  };
  async function p(h) {
    h.preventDefault();
    const y = Math.abs(Number(l.amount));
    await api.post(`/people/${id}/entries`, {
      date: l.date,
      amount: l.direction === "gave" ? -y : y,
      note: l.note || null,
    });
    c({
      ...l,
      amount: "",
      note: "",
    });
    toast("Entry added");
    f();
  }
  return (
    <>
      {o && (
        <PersonForm
          c={{
            ...d,
            entries: 0,
            sent: 0,
            received: 0,
            balance: 0,
            last_date: null,
          }}
          onDone={() => {
            u(false);
            f();
          }}
        />
      )}
      <Card
        title={d.name}
        style={{
          marginTop: o ? 16 : 0,
        }}
        extra={
          <div className="row">
            <button className="btn small" onClick={() => u(true)}>
              Edit
            </button>
            <button
              className="btn small danger"
              onClick={async () => {
                if (confirm(`Delete ${d.name}? Linked transactions go back to being normal income/spending.`)) {
                  await api.del(`/people/${id}`);
                  onDeleted();
                }
              }}
            >
              Delete
            </button>
          </div>
        }
      >
        {d.note && (
          <p
            className="small muted"
            style={{
              marginTop: 0,
            }}
          >
            {d.note}
          </p>
        )}
        <div
          className="grid g3"
          style={{
            marginBottom: 12,
          }}
        >
          <div>
            <div className="small muted">You sent / lent</div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 620,
              }}
            >
              {moneyCents(data.sent)}
            </div>
          </div>
          <div>
            <div className="small muted">You received / repaid</div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 620,
              }}
            >
              {moneyCents(data.received)}
            </div>
          </div>
          <div>
            <div className="small muted">Balance</div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 620,
              }}
            >
              <Owed v={data.balance} />
            </div>
          </div>
        </div>
        <div
          className="table-wrap"
          style={{
            maxHeight: 420,
          }}
        >
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Details</th>
                <th className="num">You sent</th>
                <th className="num">You received</th>
                <th className="num">Balance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.entries.map((h) => (
                <tr key={h.id}>
                  <td
                    className="muted"
                    style={{
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h.date}
                  </td>
                  <td>
                    {h.kind === "cash" ? (
                      <span className="badge">cash / other</span>
                    ) : (
                      <span className="small">{h.description}</span>
                    )}
                    {h.note && <div className="small muted">{h.note}</div>}
                    {h.kind === "bank" && (
                      <div className="small muted">
                        {h.account}
                        {!h.transaction_id && " · waiting to re-link after re-import"}
                      </div>
                    )}
                  </td>
                  <td className="num">{h.amount < 0 ? moneyCents(-h.amount) : ""}</td>
                  <td className="num up-good">{h.amount > 0 ? moneyCents(h.amount) : ""}</td>
                  <td className="num small">
                    <Owed v={h.balance} />
                  </td>
                  <td>
                    <button
                      className="btn small danger"
                      title="Remove from this person"
                      onClick={async () => {
                        await api.del(`/people/entries/${h.id}`);
                        f();
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
              {data.entries.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No entries yet. Assign e-transfers below, or add a cash entry.
                  </td>
                </tr>
              )}
            </tbody>
            {data.entries.length > 0 && (
              <tfoot>
                <tr>
                  <td
                    colSpan={2}
                    style={{
                      fontWeight: 600,
                    }}
                  >
                    Total ({data.entries.length})
                  </td>
                  <td
                    className="num"
                    style={{
                      fontWeight: 600,
                    }}
                  >
                    {moneyCents(data.sent)}
                  </td>
                  <td
                    className="num"
                    style={{
                      fontWeight: 600,
                    }}
                  >
                    {moneyCents(data.received)}
                  </td>
                  <td
                    className="num"
                    style={{
                      fontWeight: 600,
                    }}
                  >
                    <Owed v={data.balance} />
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <form
          onSubmit={p}
          className="row"
          style={{
            alignItems: "flex-end",
            marginTop: 14,
          }}
        >
          <label className="field">
            Cash / other entry
            <select
              value={l.direction}
              onChange={(h) =>
                c({
                  ...l,
                  direction: h.target.value,
                })
              }
            >
              <option value="gave">I gave / lent / repaid them</option>
              <option value="received">I received / they repaid me</option>
            </select>
          </label>
          <label className="field">
            Amount
            <input
              required={true}
              type="number"
              step="0.01"
              min="0.01"
              value={l.amount}
              onChange={(h) =>
                c({
                  ...l,
                  amount: h.target.value,
                })
              }
              style={{
                width: 110,
              }}
            />
          </label>
          <label className="field">
            Date
            <input
              type="date"
              value={l.date}
              onChange={(h) =>
                c({
                  ...l,
                  date: h.target.value,
                })
              }
            />
          </label>
          <label
            className="field"
            style={{
              flex: 1,
            }}
          >
            Note
            <input
              value={l.note}
              onChange={(h) =>
                c({
                  ...l,
                  note: h.target.value,
                })
              }
            />
          </label>
          <button className="btn">Add</button>
        </form>
      </Card>
    </>
  );
}

function AssignTransactions({ contacts, selected, onChange, onCreated }) {
  const { toast } = useApp();
  const [i, o] = useState("");
  const [u, l] = useState("");
  const { data, reload } = useApi(`/people/candidates${u ? `?q=${encodeURIComponent(u)}` : ""}`);
  const [f, p] = useState(new Set());
  const [h, y] = useState("");
  useEffect(() => {
    y(selected ? String(selected) : "");
  }, [selected]);
  async function b(g, w) {
    await api.post(`/people/${g}/entries`, {
      transaction_ids: w,
    });
    const S = contacts.find((j) => j.id === g)?.name ?? "person";
    toast(`${w.length} transaction(s) assigned to ${S}`);
    p(new Set());
    reload();
    onChange();
  }
  async function v(g) {
    const w = prompt("Name for this person:", g.suggested_name || "");
    if (w) {
      try {
        const S = await api.post("/people", {
          name: w,
          keywords: g.suggested_name ? g.suggested_name.split(" ")[0].toUpperCase() : null,
        });
        await b(S.id, [g.id]);
        onCreated(S.id);
      } catch (S) {
        toast(S.message);
      }
    }
  }
  const m = (data ?? []).filter((g) => g.suggested_contact_id);
  return (
    <section
      className="card flush"
      style={{
        marginTop: 16,
      }}
    >
      <div
        style={{
          padding: "14px 18px",
        }}
        className="row"
      >
        <h2
          style={{
            margin: 0,
          }}
        >
          Assign transactions to people
        </h2>
        <span className="small muted">
          {u
            ? `Search results for "${u}"`
            : "Unassigned e-transfers, newest first. Search to find any other transaction."}
        </span>
        <span className="spacer" />
        <form
          onSubmit={(g) => {
            g.preventDefault();
            l(i.trim());
          }}
          className="row"
        >
          <input
            placeholder="Search any transaction…"
            value={i}
            onChange={(g) => o(g.target.value)}
            aria-label="Search transactions"
          />
          <button className="btn small">Search</button>
          {u && (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                o("");
                l("");
              }}
            >
              Clear
            </button>
          )}
        </form>
      </div>
      {f.size > 0 && (
        <div
          className="row"
          style={{
            padding: "0 18px 10px",
          }}
        >
          <span className="small">{f.size} selected →</span>
          <select value={h} onChange={(g) => y(g.target.value)} aria-label="Assign selected to">
            <option value="" disabled={true}>
              Choose person…
            </option>
            {contacts.map((g) => (
              <option value={g.id} key={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <button className="btn small primary" disabled={!h} onClick={() => b(Number(h), [...f])}>
            Assign
          </button>
          <button className="btn small" onClick={() => p(new Set())}>
            Clear
          </button>
        </div>
      )}
      {m.length > 0 && f.size === 0 && (
        <div
          className="row"
          style={{
            padding: "0 18px 10px",
          }}
        >
          <span className="small muted">{m.length} look like people you've added.</span>
          <button className="btn small" onClick={() => p(new Set(m.map((g) => g.id)))}>
            Select them
          </button>
        </div>
      )}
      <div
        className="table-wrap"
        style={{
          maxHeight: 460,
        }}
      >
        <table>
          <thead>
            <tr>
              <th
                style={{
                  width: 28,
                }}
              />
              <th>Date</th>
              <th>Description</th>
              <th>Account</th>
              <th className="num">Sent</th>
              <th className="num">Received</th>
              <th>Assign to</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((g) => (
              <tr key={g.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label="Select"
                    checked={f.has(g.id)}
                    onChange={(w) => {
                      const S = new Set(f);
                      if (w.target.checked) {
                        S.add(g.id);
                      } else {
                        S.delete(g.id);
                      }
                      p(S);
                    }}
                  />
                </td>
                <td
                  className="muted"
                  style={{
                    whiteSpace: "nowrap",
                  }}
                >
                  {dayLabel(g.date)} <span className="small">{g.date.slice(0, 4)}</span>
                </td>
                <td>
                  {g.description}
                  <div className="small muted">{g.category}</div>
                </td>
                <td className="muted small">{g.account}</td>
                <td className="num">{g.amount < 0 ? moneyCents(-g.amount) : ""}</td>
                <td className="num up-good">{g.amount > 0 ? moneyCents(g.amount) : ""}</td>
                <td
                  style={{
                    whiteSpace: "nowrap",
                  }}
                >
                  {g.suggested_contact_id && (
                    <button
                      className="btn small primary"
                      onClick={() => b(g.suggested_contact_id, [g.id])}
                      title="Matched by name"
                    >
                      {g.suggested_contact}
                    </button>
                  )}{" "}
                  <select
                    className="inline-select"
                    value=""
                    onChange={(w) => {
                      if (w.target.value === "new") {
                        v(g);
                      } else if (w.target.value) {
                        b(Number(w.target.value), [g.id]);
                      }
                    }}
                    aria-label="Assign to person"
                    style={{
                      background: "var(--surface)",
                    }}
                  >
                    <option value="">{g.suggested_contact_id ? "Other…" : "Choose…"}</option>
                    {contacts.map((w) => (
                      <option value={w.id} key={w.id}>
                        {w.name}
                      </option>
                    ))}
                    <option value="new">+ New person{g.suggested_name ? ` "${g.suggested_name}"` : ""}…</option>
                  </select>
                </td>
              </tr>
            ))}
            {data && data.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  {u ? "Nothing matches." : "No unassigned e-transfers."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
